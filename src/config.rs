//! Port of the module-level env resolution in `serve.py` (TV_MODE / PORT /
//! COLLECTOR_PORT / ROOT).

use std::path::{Path, PathBuf};

// Defaults must match the deployed five-port layout (9991-9995). They were
// still the old dev ports (9090 dashboard, 8091 collector), and the collector
// one was the more damaging: `/config.js` publishes it to the browser, so every
// API call went to a dead port and the dashboard rendered permanently empty.
// setup.ps1 injects VMC_COLLECTOR_PORT at install time, which masked this --
// but any path that bypasses the wizard (manual XML copy, reinstall that
// restores the shipped XML, run-all.bat) fell straight back to 8091.
pub const DASH_PORT_DEFAULT: u16 = 9991;
pub const TV_PORT_DEFAULT: u16 = 9995;
pub const COLLECTOR_PORT_DEFAULT: u16 = 9994;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerConfig {
    /// True when `VMC_TV_ROOT` is set: the kiosk board becomes the landing page.
    pub tv_mode: bool,
    pub port: u16,
    /// Collector port handed to the browser through `/config.js`.
    pub collector_port: u16,
    /// Directory holding `index.html`, `css/`, `js/`.
    pub root: PathBuf,
}

/// Python: `TV_MODE = bool(os.environ.get("VMC_TV_ROOT"))`.
///
/// `bool("")` is False in Python, so an empty value means "not TV mode" — an
/// `is_ok()` check would diverge here.
fn tv_mode_from(get: &dyn Fn(&str) -> Option<String>) -> bool {
    get("VMC_TV_ROOT").is_some_and(|v| !v.is_empty())
}

/// Python:
/// ```text
/// if TV_MODE: PORT = int(os.environ.get("VMC_TV_PORT") or "9995")
/// else:       PORT = int(os.environ.get("VMC_DASH_PORT", "9090"))
/// ```
/// Note the asymmetry, faithfully reproduced: the TV branch uses `or`, so an
/// empty `VMC_TV_PORT` falls back to 9995.
pub fn resolve_mode(get: &dyn Fn(&str) -> Option<String>) -> (bool, u16) {
    let tv_mode = tv_mode_from(get);
    let port = if tv_mode {
        get("VMC_TV_PORT")
            .filter(|v| !v.is_empty())
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(TV_PORT_DEFAULT)
    } else {
        get("VMC_DASH_PORT")
            .filter(|v| !v.is_empty())
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(DASH_PORT_DEFAULT)
    };
    (tv_mode, port)
}

/// Python: `int(os.environ.get("VMC_COLLECTOR_PORT") or os.environ.get("VMC_API_PORT") or "8091")`.
pub fn collector_port(get: &dyn Fn(&str) -> Option<String>) -> u16 {
    for key in ["VMC_COLLECTOR_PORT", "VMC_API_PORT"] {
        if let Some(v) = get(key).filter(|v| !v.is_empty()) {
            if let Ok(p) = v.trim().parse() {
                return p;
            }
        }
    }
    COLLECTOR_PORT_DEFAULT
}

/// Static root. Python uses the script's own directory; the shipped Rust build
/// keeps the assets in `web/` next to the exe. `VMC_DASH_APP_ROOT` overrides for
/// repo/mac runs, mirroring `VMC_REPORT_APP_ROOT` in the report crate.
pub fn static_root() -> PathBuf {
    if let Some(p) = std::env::var("VMC_DASH_APP_ROOT")
        .ok()
        .filter(|p| !p.is_empty())
    {
        return web_dir(Path::new(&p));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = web_dir(dir);
            if candidate.join("index.html").exists() {
                return candidate;
            }
        }
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    web_dir(&cwd)
}

/// Accept either the crate dir (which holds `web/`) or the asset dir itself, so
/// pointing the override at either place works.
fn web_dir(base: &Path) -> PathBuf {
    if base.join("index.html").exists() {
        return base.to_path_buf();
    }
    base.join("web")
}

impl ServerConfig {
    pub fn from_env() -> Self {
        let get = |k: &str| std::env::var(k).ok();
        let (tv_mode, port) = resolve_mode(&get);
        Self {
            tv_mode,
            port,
            collector_port: collector_port(&get),
            root: static_root(),
        }
    }
}

//! VMC Sequence Dashboard / TV Wall Board — native Rust port of
//! `apps/dashboard/serve.py`.
//!
//! Serves the dashboard's static assets on `VMC_DASH_PORT` (default 9090) with
//! no-cache + correct MIME so ESM modules and the importmap load cleanly over
//! the LAN. With `VMC_TV_ROOT` set it runs as the standalone TV Wall Board on
//! `VMC_TV_PORT` and the kiosk board becomes the landing page. The dashboard
//! reads the collector API from the same host on the port published through
//! `/config.js` (see js/dataLayer.js).
//!
//! SECURITY: unauthenticated by design, same as the Python original — static
//! assets plus a port shim only. See the note in lib.rs.

use vmc_dashboard::config::ServerConfig;
use vmc_dashboard::router::build_router;

#[tokio::main]
async fn main() {
    let cfg = ServerConfig::from_env();
    let addr = format!("0.0.0.0:{}", cfg.port);
    let mode = if cfg.tv_mode { "tv-board" } else { "dashboard" };

    println!(
        "vmc-dashboard: serving {} on http://{} (mode={}, collector_port={})",
        cfg.root.display(),
        addr,
        mode,
        cfg.collector_port
    );

    if !cfg.root.join("index.html").exists() {
        eprintln!(
            "vmc-dashboard: WARNING index.html not found under {} — set VMC_DASH_APP_ROOT",
            cfg.root.display()
        );
    }

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("vmc-dashboard: cannot bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = axum::serve(listener, build_router(cfg)).await {
        eprintln!("vmc-dashboard: server error: {e}");
        std::process::exit(1);
    }
}

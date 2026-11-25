//! Parity tests against `apps/dashboard/serve.py`.
//!
//! The kiosk snippet is asserted byte-for-byte from the Python source itself, so
//! the two can never silently drift.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use std::path::{Path, PathBuf};
use tower::ServiceExt;
use vmc_dashboard::config::{collector_port, resolve_mode, ServerConfig};
use vmc_dashboard::kiosk::KIOSK_SNIPPET;
use vmc_dashboard::router::build_router;

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn web_root() -> PathBuf {
    crate_root().join("web")
}

/// The Python original, for byte-level comparison of the kiosk block.
/// Vendored from `apps/dashboard/serve.py` so this crate tests standalone.
fn serve_py() -> String {
    let p = crate_root().join("tests").join("reference").join("serve.py");
    std::fs::read_to_string(p).expect("tests/reference/serve.py must stay as the parity reference")
}

fn cfg(tv_mode: bool, collector_port: u16) -> ServerConfig {
    ServerConfig {
        tv_mode,
        port: 0,
        collector_port,
        root: web_root(),
    }
}

async fn get(cfg: ServerConfig, path: &str) -> (StatusCode, String, String) {
    let app = build_router(cfg);
    let res = app
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let ctype = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let cache = res
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let cors = res
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // Every response must carry Python's end_headers additions.
    assert_eq!(cache, "no-store", "Cache-Control missing for {path}");
    assert_eq!(cors, "*", "CORS header missing for {path}");
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, ctype, String::from_utf8_lossy(&body).into_owned())
}

// --------------------------------------------------------------- kiosk parity
/// Rebuild the kiosk string from serve.py's own literals and compare bytes.
#[test]
fn kiosk_snippet_matches_python() {
    let py = serve_py();
    let start = py.find("kiosk = (").expect("kiosk assignment in serve.py");
    let tail = &py[start..];
    let end = tail.find("\n        )").expect("end of kiosk literal");
    let block = &tail[..end];

    // Concatenate every double-quoted Python literal in the block, undoing the
    // \" escapes, which is exactly what Python's implicit concatenation yields.
    let mut rebuilt = String::new();
    let bytes = block.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            let mut j = i + 1;
            let mut lit = String::new();
            while j < bytes.len() {
                if bytes[j] == b'\\' && j + 1 < bytes.len() && bytes[j + 1] == b'"' {
                    lit.push('"');
                    j += 2;
                    continue;
                }
                if bytes[j] == b'"' {
                    break;
                }
                lit.push(bytes[j] as char);
                j += 1;
            }
            rebuilt.push_str(&lit);
            i = j + 1;
            continue;
        }
        i += 1;
    }

    assert!(
        !rebuilt.is_empty(),
        "failed to parse the kiosk literal out of serve.py"
    );
    assert_eq!(
        KIOSK_SNIPPET, rebuilt,
        "KIOSK_SNIPPET drifted from serve.py's kiosk block"
    );
}

// ------------------------------------------------------------------ config.js
#[tokio::test]
async fn config_js_served_at_both_paths() {
    for path in ["/config.js", "/js/config.js"] {
        let (status, ctype, body) = get(cfg(false, 9994), path).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ctype, "text/javascript");
        assert_eq!(body, "window.__VMC_COLLECTOR_PORT__ = 9994;\n");
    }
}

#[test]
fn collector_port_precedence_matches_python() {
    // The default is the DEPLOYED collector port. It used to be 8091 (the dev
    // port), and because /config.js publishes this value to the browser, every
    // API call went to a dead port whenever VMC_COLLECTOR_PORT was unset --
    // which rendered the dashboard permanently empty.
    let none = |_: &str| None;
    assert_eq!(collector_port(&none), 9994);

    let only_api = |k: &str| (k == "VMC_API_PORT").then(|| "8091".to_string());
    assert_eq!(collector_port(&only_api), 8091,
               "an explicit VMC_API_PORT must still be honoured verbatim");

    // VMC_COLLECTOR_PORT wins over VMC_API_PORT.
    let both = |k: &str| match k {
        "VMC_COLLECTOR_PORT" => Some("9994".to_string()),
        "VMC_API_PORT" => Some("8091".to_string()),
        _ => None,
    };
    assert_eq!(collector_port(&both), 9994);

    // Python's `or` treats "" as falsey, so an empty value falls through.
    let empty_then_api = |k: &str| match k {
        "VMC_COLLECTOR_PORT" => Some(String::new()),
        "VMC_API_PORT" => Some("7000".to_string()),
        _ => None,
    };
    assert_eq!(collector_port(&empty_then_api), 7000);
}

// -------------------------------------------------------------- mode + ports
#[test]
fn mode_and_port_resolution_matches_python() {
    // 9991 is the deployed dashboard port (was 9090 in the dev layout).
    let none = |_: &str| None;
    assert_eq!(resolve_mode(&none), (false, 9991));

    let dash = |k: &str| (k == "VMC_DASH_PORT").then(|| "9991".to_string());
    assert_eq!(resolve_mode(&dash), (false, 9991));

    // VMC_TV_ROOT set -> TV mode, default 9995.
    let tv = |k: &str| (k == "VMC_TV_ROOT").then(|| "1".to_string());
    assert_eq!(resolve_mode(&tv), (true, 9995));

    let tv_port = |k: &str| match k {
        "VMC_TV_ROOT" => Some("1".to_string()),
        "VMC_TV_PORT" => Some("9995".to_string()),
        _ => None,
    };
    assert_eq!(resolve_mode(&tv_port), (true, 9995));

    // bool("") is False in Python: an empty VMC_TV_ROOT is NOT tv mode.
    let empty_tv = |k: &str| (k == "VMC_TV_ROOT").then(String::new);
    assert_eq!(resolve_mode(&empty_tv), (false, 9991));

    // TV mode ignores VMC_DASH_PORT entirely.
    let mixed = |k: &str| match k {
        "VMC_TV_ROOT" => Some("1".to_string()),
        "VMC_DASH_PORT" => Some("9991".to_string()),
        _ => None,
    };
    assert_eq!(resolve_mode(&mixed), (true, 9995));
}

// ----------------------------------------------------------------- kiosk http
#[tokio::test]
async fn kiosk_paths_inject_in_both_modes() {
    for path in ["/tv", "/tv/", "/tv.html"] {
        let (status, ctype, body) = get(cfg(false, 8091), path).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        // _serve_tv sends an explicit charset, unlike the static-file path.
        assert_eq!(ctype, "text/html; charset=utf-8");
        assert!(body.contains(KIOSK_SNIPPET), "{path} missing kiosk block");
        assert!(body.contains("machineGrid"), "{path} should be the dashboard");
    }
}

#[tokio::test]
async fn root_is_plain_dashboard_but_kiosk_in_tv_mode() {
    // Sequence Dashboard: "/" is the normal board.
    let (status, ctype, body) = get(cfg(false, 8091), "/").await;
    assert_eq!(status, StatusCode::OK);
    // Python's mimetypes yields a bare "text/html" for static files.
    assert_eq!(ctype, "text/html");
    assert!(!body.contains(KIOSK_SNIPPET), "/ must not be kiosk-skinned");

    // TV Wall Board: "/" and "/index.html" ARE the kiosk board.
    for path in ["/", "/index.html"] {
        let (status, _, body) = get(cfg(true, 8091), path).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains(KIOSK_SNIPPET), "TV mode {path} must be kiosk");
    }
}

#[tokio::test]
async fn kiosk_injects_exactly_once_before_head_close() {
    let (_, _, body) = get(cfg(true, 8091), "/tv").await;
    assert_eq!(body.matches("id=\"vmc-tv\"").count(), 1);
    assert!(body.contains(&format!("{KIOSK_SNIPPET}</head>")));
}

// ---------------------------------------------------------------- static files
#[tokio::test]
async fn static_assets_served_with_correct_mime() {
    let (status, ctype, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctype, "text/javascript");
    assert!(!body.is_empty());

    let (status, ctype, _) = get(cfg(false, 8091), "/css/cards.css").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctype, "text/css");
}

#[tokio::test]
async fn missing_file_is_404() {
    let (status, _, _) = get(cfg(false, 8091), "/nope/missing.js").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn traversal_is_refused_over_http() {
    let (status, _, _) = get(cfg(false, 8091), "/../../etc/passwd").await;
    assert_ne!(status, StatusCode::OK);
}

#[tokio::test]
async fn missing_index_reports_pythons_message() {
    let empty = std::env::temp_dir().join("vmc-dash-empty-root");
    std::fs::create_dir_all(&empty).unwrap();
    let c = ServerConfig {
        tv_mode: true,
        port: 0,
        collector_port: 8091,
        root: empty,
    };
    let (status, _, body) = get(c, "/tv").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body.contains("dashboard index not found"));
}

// ------------------------------------------------------------------- assets
/// The shipped `web/` must carry everything index.html references, or the board
/// silently loads a broken page on the floor.
#[test]
fn shipped_assets_are_complete() {
    let root = web_root();
    assert!(root.join("index.html").exists(), "index.html must ship");
    // tv-config.js and tv.js are listed because index.html loads them with plain
    // <script src>, and tv-config.js must load FIRST -- it declares the global
    // tv.js reads. If either goes missing from the shipped tree the wall board
    // silently loses its rotation, clock and settings while still returning 200
    // for the page itself, which is the hardest kind of deploy failure to spot.
    for f in [
        "js/app.js",
        "js/aurora.js",
        "js/godmode.js",
        "js/dataLayer.js",
        "js/tv-config.js",
        "js/tv.js",
    ] {
        assert!(root.join(f).exists(), "{f} must ship");
    }
    let css = root.join("css");
    assert!(css.join("cards.css").exists(), "css/cards.css must ship");
    assert!(css.join("godmode.css").exists(), "css/godmode.css must ship");
    assert!(css.join("tv.css").exists(), "css/tv.css must ship");

    // index.html must load the config layer before the engine that reads it.
    let html = std::fs::read_to_string(root.join("index.html")).expect("read index.html");
    let cfg_at = html.find("js/tv-config.js").expect("index.html must load js/tv-config.js");
    let tv_at = html.find("js/tv.js").expect("index.html must load js/tv.js");
    assert!(
        cfg_at < tv_at,
        "js/tv-config.js must be loaded before js/tv.js: it declares __VMC_TV_CFG__, \
         which tv.js reads at module scope"
    );

    // Dev-only material must NOT be shipped.
    assert!(!root.join("plans").exists(), "plans/ is dev docs");
    assert!(!Path::new(&root).join("serve.py").exists());
}

// ------------------------------------------------------ settings UI parity
// Fullscreen + TV-settings buttons use tv-cfg-btn: the kiosk skin re-hides
// `.topbar .cfg-btn` on every DOM mutation.
#[tokio::test]
async fn settings_buttons_served_in_index() {
    for (tv, path) in [
        (false, "/"),
        (false, "/index.html"),
        (true, "/"),
        (true, "/index.html"),
    ] {
        let (status, _, body) = get(cfg(tv, 8091), path).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        for id in ["fsBtn", "dashCfgBtn"] {
            let needle = format!(r#"id="{id}""#);
            let at = body
                .find(&needle)
                .unwrap_or_else(|| panic!("{path} missing {needle}"));
            let start = body[..at].rfind("<button").expect("button open tag");
            let end = body[at..].find('>').expect("button tag end") + at + 1;
            let tag = &body[start..end];
            assert!(
                tag.contains("tv-cfg-btn"),
                "{path} {id} must carry tv-cfg-btn, got: {tag}"
            );
            assert!(
                !tag.contains(r#"class="cfg-btn""#),
                "{path} {id} must not carry cfg-btn, got: {tag}"
            );
        }
    }
}

#[tokio::test]
async fn dash_prefs_and_toolpath_off_served_in_app_js() {
    let (status, ctype, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctype, "text/javascript");
    assert!(
        body.contains("vmc_dash_prefs_v1"),
        "prefs key missing from served app.js"
    );
    assert!(
        body.contains("TOOLPATH OFF"),
        "TOOLPATH OFF tag missing from served app.js"
    );
    assert!(
        body.contains(r#"toolpath: "off""#),
        "toolpath must default off in served app.js"
    );
    assert!(
        body.contains(r#"dashPrefs.toolpath !== "on""#),
        "toolpath off guard missing from served app.js"
    );
}

// The wall is its OWN page at /tv, not an overlay inside the dashboard. The
// dashboard's fullscreen button must NAVIGATE there, and the two-scope
// (Global / This display) settings model must be present.
#[tokio::test]
async fn wall_board_is_a_dedicated_page_not_an_overlay() {
    let (status, ctype, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctype, "text/javascript");
    for needle in ["gotoWallBoard", "TV_WALL_PATH", "vmc_dash_global_v2", "vmc_dash_device_v2", "resolveDashPrefs"] {
        assert!(body.contains(needle), "token missing from served app.js: {needle}");
    }
    // The in-page slideshow overlay is gone: no duplicate wall engine.
    for gone in ["startPreviewFullscreen", "data-preview", "applyWallPaging"] {
        assert!(!body.contains(gone), "removed in-page wall engine still served: {gone}");
    }
    let (status, _, css) = get(cfg(false, 8091), "/css/cards.css").await;
    assert_eq!(status, StatusCode::OK);
    assert!(css.contains(".dash-cfg-tab"), "scope tabs style missing from served cards.css");
}

// The wall board must offer a VISIBLE way in and out in every view. The corner
// hotspot and the `s`/`x` keys are invisible on a wall panel with no keyboard,
// and in the timeline view the card grid is not even on screen.
#[tokio::test]
async fn wall_board_has_visible_settings_and_exit() {
    let (status, ctype, body) = get(cfg(true, 8091), "/js/tv.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctype, "text/javascript");
    for needle in [
        "buildWallControls",
        "tvWallExit",
        "tvWallSettings",
        "tv-wallbar",
        "TV BOARD SETTINGS",
        "data-tv-scope=\"global\"",
        "data-tv-scope=\"device\"",
        "Wall board",
        "Machines &amp; order",
        "TVCLS_SHARED",
        "Timeline step",
        "__VMC_DASH_SECTIONS__",
        "tvMachineList",
        "__VMC_DASH_SETTINGS__",
    ] {
        assert!(body.contains(needle), "wall control missing from served tv.js: {needle}");
    }
    assert!(
        body.contains("buildWallControls();"),
        "buildWallControls must be called from boot in served tv.js"
    );
    let (status, _, tv_cfg) = get(cfg(true, 8091), "/js/tv-config.js").await;
    assert_eq!(status, StatusCode::OK);
    for needle in ["vmc_tv_global_cfg", "vmc_tv_cfg", "__VMC_TV_CFG_SCOPE__"] {
        assert!(tv_cfg.contains(needle), "scoped wall config missing from served tv-config.js: {needle}");
    }
    assert!(
        body.contains("window.location.origin + \"//index.html\""),
        "Exit must navigate from /tv to the plain dashboard"
    );
    let (status, _, css) = get(cfg(true, 8091), "/css/tv.css").await;
    assert_eq!(status, StatusCode::OK);
    for needle in [".tv-wallbar", ".tv-wallbtn", "#tvWallExit"] {
        assert!(css.contains(needle), "wall control style missing from served tv.css: {needle}");
    }
}

// The wall timeline step is a presentation, not the dashboard pane: tv.js pins
// Hour + live and follows the wall fleet through the timeline.js bridge, the
// default dwell is uniform 20s, and the wall hides the timeline's own controls.
#[tokio::test]
async fn wall_timeline_presentation_served() {
    let (status, _, body) = get(cfg(true, 8091), "/js/tv.js").await;
    assert_eq!(status, StatusCode::OK);
    for needle in [
        "__VMC_TIMELINE__",
        "presentTimeline",
        "releaseTimeline",
        "wasTimeline",
        "orderedFleet()",
        "tvTlDwell",
    ] {
        assert!(body.contains(needle), "timeline presentation missing from served tv.js: {needle}");
    }
    let (status, _, tv_cfg) = get(cfg(true, 8091), "/js/tv-config.js").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        tv_cfg.contains(r#"{ view: "timeline", dwell: 20000 }"#),
        "timeline step must default to the uniform 20s dwell"
    );
    assert!(
        tv_cfg.contains(r#"q.get("views")"#),
        "?views= timeline-only entry must stay parseable"
    );
    let (status, _, tl) = get(cfg(true, 8091), "/js/timeline.js").await;
    assert_eq!(status, StatusCode::OK);
    for needle in ["__VMC_TIMELINE__", "setRangeSilent", "wallOrder", "present(visibleIds)", "release()"] {
        assert!(tl.contains(needle), "wall bridge missing from served timeline.js: {needle}");
    }
    assert!(
        tl.contains("setRangeSilent(\"hour\")"),
        "wall present() must pin Hour through the non-persisting path"
    );
    let (status, _, css) = get(cfg(true, 8091), "/css/tv.css").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        css.contains("[data-tv-view=\"timeline\"] .tl-controls"),
        "wall must hide the timeline operator controls"
    );
}

// The dashboard keeps its own card/display settings panel: the topbar button
// must TOGGLE it, never navigate away. Unifying settings on /tv must not
// orphan openDashCfg (zero callers = unreachable panel + dead export/import).
#[tokio::test]
async fn dash_settings_panel_stays_reachable() {
    let (status, _, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.contains("else openDashCfg();"),
        "dashCfgBtn must toggle the dashboard settings panel"
    );
    assert!(
        !body.contains("btn.title = \"Open wall board settings (/tv)\""),
        "dashCfgBtn must not be rewired to navigate to /tv"
    );
    let (status, _, html) = get(cfg(false, 8091), "/").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        html.contains("title=\"Display and card settings\""),
        "dashCfgBtn must keep its settings title in served index.html"
    );
}

// Both panels render the SAME card/display/profile sections from one shared
// definition: identical order, titles and wording. The dashboard additionally
// owns the Collector endpoint inline (no blocking prompt anywhere) and notes
// that wall values live on the wall.
#[tokio::test]
async fn settings_panels_share_sections() {
    let (status, _, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    for needle in [
        "__VMC_DASH_SECTIONS__",
        "dashSectionsHTML",
        "wireDashSections",
        "data-ss=",
        "S(\"display\", \"Display\"",
        "S(\"cards\", \"Machine cards\"",
        "S(\"profile\", \"Profile\"",
        "data-dc=\"summary\"",
        "data-dc=\"toolpath\"",
        "data-dc=\"ranked\"",
        "data-dc=\"export\"",
        "Machines &amp; order",
        "Timeline step",
        "data-c=\"api\"",
        "data-c=\"apiApply\"",
    ] {
        assert!(body.contains(needle), "shared settings missing from served app.js: {needle}");
    }
    assert!(
        !body.contains("window.prompt("),
        "blocking prompt() must be gone from served app.js"
    );
    let (status, _, tv) = get(cfg(true, 8091), "/js/tv.js").await;
    assert_eq!(status, StatusCode::OK);
    for needle in ["__VMC_DASH_SECTIONS__", "TVCLS_SHARED", "sharedProfile", "[\"display\", \"cards\"]"] {
        assert!(tv.contains(needle), "wall panel must use the shared sections: {needle}");
    }
    assert!(
        !tv.contains("tvDashZoom") && !tv.contains("tvToolpath"),
        "wall panel must not keep its own duplicate card controls"
    );
}

#[tokio::test]
async fn prog_timeline_served_and_chute_machine_gone() {
    let (status, ctype, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctype, "text/javascript");
    assert!(
        body.contains(r#"data-f="progTimelineList""#),
        "timeline block missing from served app.js"
    );
    assert!(
        body.contains("paintProgTimeline"),
        "timeline renderer missing from served app.js"
    );
    assert!(
        !body.contains("chuteMachine"),
        "chute machine label must be gone from served app.js"
    );
}

#[tokio::test]
async fn last_part_timing_and_water_stages_served() {
    let (status, ctype, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctype, "text/javascript");
    assert!(
        body.contains("lastPartHistAt"),
        "last-part timing missing from served app.js"
    );
    assert!(
        body.contains("data-fill"),
        "water fill stages missing from served app.js"
    );
    assert!(
        !body.contains(r#"data-f="partsRecentList""#),
        "extra recent-parts strip must be gone from served app.js"
    );
    let (status, _, css) = get(cfg(false, 8091), "/css/cards.css").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        !css.contains(".parts-recent"),
        "extra recent-parts styles must be gone from served cards.css"
    );
}

#[tokio::test]
async fn session_rank_and_no_live_badge_served() {
    let (status, ctype, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctype, "text/javascript");
    assert!(
        body.contains("setSessFill"),
        "session fill missing from served app.js"
    );
    assert!(
        !body.contains("shiftLive"),
        "LIVE badge must be gone from served app.js"
    );
    let (status, _, css) = get(cfg(false, 8091), "/css/cards.css").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        css.contains("sess-sheen"),
        "session sheen missing from served cards.css"
    );
    assert!(
        !css.contains("shift-live-dot"),
        "LIVE styles must be gone from served cards.css"
    );
    assert!(
        !body.contains("chuteCode"),
        "program-name line must be gone from served app.js"
    );
    assert!(
        !css.contains("shift-chute-label"),
        "program-name styles must be gone from served cards.css"
    );
    assert!(
        body.contains(r#"data-f="sessOn""#),
        "session time chips missing from served app.js"
    );
    assert!(
        css.contains(".sess-chip"),
        "session chip styles missing from served cards.css"
    );
}

#[tokio::test]
async fn sp_chips_and_rectangular_current_served() {
    let (status, ctype, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctype, "text/javascript");
    assert!(
        body.contains(r#"data-f="shiftRunning""#),
        "SP ON time chip missing from served app.js"
    );
    assert!(
        body.contains(r#"data-f="shiftStopped""#),
        "SP OFF time chip missing from served app.js"
    );
    assert!(
        body.contains("sp-chip sp-chip--on"),
        "SP ON chip classes missing from served app.js"
    );
    assert!(
        body.contains("sp-chip sp-chip--off"),
        "SP OFF chip classes missing from served app.js"
    );
    assert!(
        !body.contains(r#"SP ON ${"#),
        "SP ON prefix must live outside the chip, not inside setText"
    );
    let (status, _, css) = get(cfg(false, 8091), "/css/cards.css").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        css.contains(".sp-chip--on"),
        "SP ON chip styles missing from served cards.css"
    );
    assert!(
        css.contains(".sp-chip--off"),
        "SP OFF chip styles missing from served cards.css"
    );
    assert!(
        !css.contains("width: 84px"),
        "current session box must be rectangular, not the 84px circle"
    );
    assert!(
        css.contains("align-self: stretch"),
        "current session box must stretch as a rectangular spanning box"
    );
}

#[tokio::test]
async fn stopped_blur_clipped_to_cycle_panel() {
    let (status, _, css) = get(cfg(false, 8091), "/css/cards.css").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        css.contains(".cycle-panel {") && css.contains("position: relative") && css.contains("overflow: hidden"),
        "cycle panel must be a clipping container for the stopped blur"
    );
    assert!(
        css.contains(".machine-card-idle-time") && css.contains("position: absolute") && css.contains("inset: 0"),
        "stopped overlay must be positioned inside cycle panel with inset:0"
    );
}

#[tokio::test]
async fn spindle_moving_indicator_served() {
    let (status, ctype, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctype, "text/javascript");
    assert!(
        body.contains(r#"data-f="shiftRunning""#),
        "SP ON timer data-f ref missing from served app.js"
    );
    assert!(
        body.contains(r#"setAttr(refs.shiftRunning, "data-spindle", "on")"#),
        "spindle state must target only the SP ON timer"
    );
    let (status, _, css) = get(cfg(false, 8091), "/css/cards.css").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        css.contains(r#".sp-chip--on[data-spindle="on"]"#),
        "SP ON timer highlight rule missing from served cards.css"
    );
    assert!(
        !css.contains(r#".shift-panel-meta[data-spindle="on"]"#),
        "spindle state must not highlight the complete SP ON/SP OFF row"
    );
}

// "Part count instead of RPM graph": one shared Machine-cards checkbox, a
// scoped boolean pref (default off = graph), and a spindle-row readout fed from
// the same per-machine partsShown value as the PARTS box.
#[tokio::test]
async fn spindle_parts_option_served() {
    let (status, _, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body.matches(r#"data-dc="spindleParts""#).count(),
        1,
        "exactly one spindleParts checkbox in the shared sections"
    );
    for needle in [
        "Part count instead of RPM graph",
        "spindleParts: false,",
        r#""rankedCounts", "spindleParts""#,
        r#"h.dataset.spindleParts = dashPrefs.spindleParts ? "on" : "off";"#,
        r#"a.set("spindleParts", els.spindleParts.checked)"#,
        r#"data-f="spindleParts""#,
        r#"data-f="spindlePartsVal""#,
        r#"setText(refs.spindlePartsVal, entry.partsKnown ? fmtInt(entry.partsShown) : "—");"#,
        r#"setText(refs.spindlePartsVal, "—");"#,
    ] {
        assert!(body.contains(needle), "spindle-parts option missing from served app.js: {needle}");
    }
    // The graph canvas stays in the card; the option only swaps visibility.
    assert!(body.contains(r#"data-f="spindleWave""#), "RPM graph canvas must remain");
    let (status, _, css) = get(cfg(false, 8091), "/css/cards.css").await;
    assert_eq!(status, StatusCode::OK);
    for needle in [
        r#"html[data-spindle-parts="on"] .spindle-wave { display: none; }"#,
        r#"html[data-spindle-parts="on"] .spindle-parts { display: flex; }"#,
    ] {
        assert!(css.contains(needle), "spindle-parts rule missing from served cards.css: {needle}");
    }
    let (status, _, tvcss) = get(cfg(true, 8091), "/css/tv.css").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        tvcss.contains("html[data-tv][data-tv-compact] .spindle-parts-value"),
        "compact 3x2 sizing for the spindle-row part count missing from served tv.css"
    );
}

#[tokio::test]
async fn shift_art_phases_served() {
    let (status, ctype, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctype, "text/javascript");
    for phase in ["\"morning\"", "\"afternoon\"", "\"night\""] {
        assert!(
            body.contains(phase),
            "shift art phase {phase} missing from served app.js"
        );
    }
    for cls in ["art-rays", "art-cloud", "art-star", "art-moon"] {
        assert!(
            body.contains(cls),
            "shift art layer {cls} missing from served app.js"
        );
    }
    let (status, _, css) = get(cfg(false, 8091), "/css/cards.css").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        css.contains(".shift-prev-art svg"),
        "shift art sizing missing from served cards.css"
    );
    assert!(
        css.contains(".shift-prev-box > .shift-prev-art"),
        "previous-shift icon must dock inline, never overlay the percentage"
    );
    assert!(
        css.contains(".shift-vibe-on .shift-vibe .art-rays"),
        "corner vibe sun rotation missing from served cards.css"
    );
}

#[tokio::test]
async fn offline_status_overrides_stale_execution() {
    let (status, _, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.contains("if (m.online === false) return \"offline\";"),
        "offline machines must not render green off stale ACTIVE execution"
    );
}

#[tokio::test]
async fn hurco_program_history_served() {
    let (status, _, body) = get(cfg(false, 8091), "/js/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.contains("Program_Name_Running"),
        "Hurco program-history item missing from served app.js"
    );
    assert!(
        body.contains("function progRowsFor(per)"),
        "program-history fallback helper missing from served app.js"
    );
}

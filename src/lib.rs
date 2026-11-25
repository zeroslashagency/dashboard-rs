//! VMC Sequence Dashboard + TV Wall Board — native Rust port of
//! `apps/dashboard/serve.py` (124 lines, stdlib only).
//!
//! One binary backs BOTH services, exactly like the Python original:
//!   * `VMC_TV_ROOT` unset -> Sequence Dashboard on `VMC_DASH_PORT` (default 9090),
//!     kiosk board available at `/tv`.
//!   * `VMC_TV_ROOT` set   -> TV Wall Board on `VMC_TV_PORT` (default 9995), where
//!     the kiosk board IS the landing page.
//!
//! SECURITY: this server is unauthenticated BY DESIGN, matching the Python
//! original. It serves only static assets plus a tiny runtime-config shim, and
//! the wide-open `Access-Control-Allow-Origin: *` header is required so the LAN
//! dashboard can call the collector from a browser on another host. Do not add
//! an auth gate here without also updating the dashboard JS and the installer's
//! firewall notes.

pub mod config;
pub mod kiosk;
pub mod router;

pub use config::{collector_port, resolve_mode, ServerConfig, TV_PORT_DEFAULT};
pub use kiosk::{inject_kiosk, KIOSK_SNIPPET};
pub use router::{build_router, config_js_body, mime_for};

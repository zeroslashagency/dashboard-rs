//! Port of `serve.py::Handler` — routing, the `/config.js` shim, MIME overrides
//! and the headers `end_headers` adds to every response.

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, Request, StatusCode};
use axum::response::Response;
use axum::Router;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use crate::config::ServerConfig;
use crate::kiosk::{inject_kiosk, is_kiosk_path};

/// Python: `("window.__VMC_COLLECTOR_PORT__ = %d;\n" % COLLECTOR_PORT)`.
pub fn config_js_body(collector_port: u16) -> String {
    format!("window.__VMC_COLLECTOR_PORT__ = {collector_port};\n")
}

/// Python: `Handler.extensions_map.update({...})` plus the stdlib defaults for
/// the handful of types this dashboard actually serves.
pub fn mime_for(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        // serve.py's explicit overrides
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "mdx" => "text/plain",
        // stdlib guesses. Python's mimetypes returns a bare "text/html" for a
        // static file (no charset), and the browser sniffs the meta charset —
        // matched here so the Content-Type is identical to the Python server's.
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/vnd.microsoft.icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "map" => "application/json",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

pub fn build_router(cfg: ServerConfig) -> Router {
    Router::new()
        .fallback(serve)
        .with_state(Arc::new(cfg))
}

/// Every response carries these, matching Python's `end_headers` override.
fn finish(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    res
}

fn text(status: StatusCode, content_type: &'static str, body: impl Into<Body>) -> Response {
    finish(
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, content_type)
            .body(body.into())
            .unwrap(),
    )
}

/// Byte-identical to `BaseHTTPRequestHandler.send_error`'s page
/// (`DEFAULT_ERROR_MESSAGE` filled in), so a missing asset produces exactly the
/// response the Python server produced — some dashboard JS checks the status,
/// and mirroring the body keeps logs/screenshots comparable.
fn py_error(status: StatusCode, message: &str, explain: &str) -> Response {
    let body = format!(
        "<!DOCTYPE HTML>\n<html lang=\"en\">\n    <head>\n        <meta charset=\"utf-8\">\n\
         \x20       <style type=\"text/css\">\n            :root {{\n                \
         color-scheme: light dark;\n            }}\n        </style>\n        \
         <title>Error response</title>\n    </head>\n    <body>\n        \
         <h1>Error response</h1>\n        <p>Error code: {code}</p>\n        \
         <p>Message: {message}.</p>\n        \
         <p>Error code explanation: {code} - {explain}.</p>\n    </body>\n</html>\n",
        code = status.as_u16(),
    );
    text(status, "text/html;charset=utf-8", body)
}

fn not_found() -> Response {
    py_error(
        StatusCode::NOT_FOUND,
        "File not found",
        "Nothing matches the given URI",
    )
}

async fn serve(State(cfg): State<Arc<ServerConfig>>, req: Request<Body>) -> Response {
    // Python: `path = self.path.split("?", 1)[0]`
    let path = req.uri().path().to_string();

    // Runtime config injected so the collector port is never hardcoded in JS.
    if path == "/config.js" || path == "/js/config.js" {
        let body = config_js_body(cfg.collector_port);
        return text(StatusCode::OK, "text/javascript", body);
    }

    // TV / kiosk board: the SAME dashboard with a full-screen kiosk skin.
    if is_kiosk_path(&path, cfg.tv_mode) {
        return match std::fs::read_to_string(cfg.root.join("index.html")) {
            Ok(html) => text(
                StatusCode::OK,
                "text/html; charset=utf-8",
                inject_kiosk(&html),
            ),
            // Python: `self.send_error(404, "dashboard index not found")`
            Err(_) => py_error(
                StatusCode::NOT_FOUND,
                "dashboard index not found",
                "Nothing matches the given URI",
            ),
        };
    }

    // Directory index, like SimpleHTTPRequestHandler.
    let rel = if path == "/" || path.ends_with('/') {
        format!("{}index.html", path.trim_start_matches('/'))
    } else {
        path.trim_start_matches('/').to_string()
    };

    let Some(file) = safe_join(&cfg.root, &rel) else {
        return not_found();
    };

    match std::fs::read(&file) {
        Ok(bytes) => text(StatusCode::OK, mime_for(&rel), bytes),
        Err(_) => not_found(),
    }
}

/// Resolve a request path under `root`, refusing anything that escapes it.
/// `SimpleHTTPRequestHandler.translate_path` does the same by discarding `..`
/// components; being explicit here keeps path traversal impossible.
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let decoded = percent_decode(rel);
    let mut out = root.to_path_buf();
    for part in Path::new(&decoded).components() {
        match part {
            Component::Normal(p) => out.push(p),
            // Discard traversal and absolute/root markers outright.
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
            Component::CurDir => {}
        }
    }
    if out.is_dir() {
        out.push("index.html");
    }
    Some(out)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_js_matches_python_format() {
        assert_eq!(
            config_js_body(9994),
            "window.__VMC_COLLECTOR_PORT__ = 9994;\n"
        );
    }

    #[test]
    fn mime_overrides_match_python() {
        assert_eq!(mime_for("js/app.js"), "text/javascript");
        assert_eq!(mime_for("js/godmode.mjs"), "text/javascript");
        assert_eq!(mime_for("css/cards.css"), "text/css");
        assert_eq!(mime_for("notes.mdx"), "text/plain");
        assert_eq!(mime_for("index.html"), "text/html");
    }

    #[test]
    fn traversal_is_refused() {
        let root = Path::new("/tmp/vmc-root");
        assert!(safe_join(root, "../../etc/passwd").is_none());
        assert!(safe_join(root, "css/../../../etc/passwd").is_none());
        // Percent-encoded traversal is decoded before the check.
        assert!(safe_join(root, "%2e%2e/%2e%2e/etc/passwd").is_none());
        assert_eq!(
            safe_join(root, "css/cards.css").unwrap(),
            root.join("css").join("cards.css")
        );
    }
}

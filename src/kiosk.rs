//! Port of `serve.py::_serve_tv` — the kiosk skin injected into `index.html`.
//!
//! Kiosk skin: in TV mode hide nav + config buttons, but keep .godview-host
//! visible so the TV auto-switch (cards ↔ timeline) can toggle views.
//! A MutationObserver removes the nav/config the moment god-mode.js injects
//! them, so the chrome never flashes on the wall board.
//!
//! The string below is a byte-for-byte transcription of the Python `kiosk`
//! variable (the concatenated literals in `_serve_tv`). A single character of
//! drift changes how the wall board renders, so `kiosk_snippet_matches_python`
//! in the tests asserts the exact expected bytes.

pub const KIOSK_SNIPPET: &str = concat!(
    "<style id=\"vmc-tv\">",
    "html[data-tv] .godnav,",
    "html[data-tv] .topbar .cfg-btn{display:none!important}",
    "html[data-tv] body{overflow:auto;margin:0;background:#0b1120}",
    "html[data-tv] main{padding:0!important;margin:0!important}",
    "html[data-tv] .machine-grid{gap:16px;padding:16px}",
    "</style>",
    "<script>document.documentElement.setAttribute('data-tv','1');",
    "window.__VMC_TV__=true;",
    "(function(){var strip=function(){",
    "document.querySelectorAll('.godnav,.topbar .cfg-btn')",
    ".forEach(function(el){el.style.display='none';});};",
    "if(document.readyState!=='loading')strip();",
    "document.addEventListener('DOMContentLoaded',strip);",
    "try{new MutationObserver(strip).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}",
    "})();</script>"
);

/// Python:
/// ```text
/// if "</head>" in html: html = html.replace("</head>", kiosk + "</head>", 1)
/// else:                 html = kiosk + html
/// ```
pub fn inject_kiosk(html: &str) -> String {
    match html.find("</head>") {
        Some(idx) => {
            let mut out = String::with_capacity(html.len() + KIOSK_SNIPPET.len());
            out.push_str(&html[..idx]);
            out.push_str(KIOSK_SNIPPET);
            out.push_str(&html[idx..]);
            out
        }
        None => format!("{KIOSK_SNIPPET}{html}"),
    }
}

/// Python: `path in ("/tv", "/tv/", "/tv.html")`, plus `("/", "/index.html")`
/// when TV_MODE.
pub fn is_kiosk_path(path: &str, tv_mode: bool) -> bool {
    matches!(path, "/tv" | "/tv/" | "/tv.html")
        || (tv_mode && matches!(path, "/" | "/index.html"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_before_head_close_once() {
        let html = "<html><head><title>a</title></head><body>x</body></html>";
        let out = inject_kiosk(html);
        assert!(out.contains(KIOSK_SNIPPET));
        assert!(out.contains(&format!("{KIOSK_SNIPPET}</head>")));
        // replace(..., 1): exactly one injection.
        assert_eq!(out.matches("id=\"vmc-tv\"").count(), 1);
        // Nothing else is disturbed.
        assert_eq!(out.replace(KIOSK_SNIPPET, ""), html);
    }

    #[test]
    fn prepends_when_no_head() {
        let html = "<div>bare</div>";
        assert_eq!(inject_kiosk(html), format!("{KIOSK_SNIPPET}{html}"));
    }

    #[test]
    fn kiosk_paths_match_python() {
        for p in ["/tv", "/tv/", "/tv.html"] {
            assert!(is_kiosk_path(p, false), "{p} should be kiosk in both modes");
            assert!(is_kiosk_path(p, true));
        }
        // "/" and "/index.html" are kiosk ONLY in TV mode.
        for p in ["/", "/index.html"] {
            assert!(!is_kiosk_path(p, false), "{p} must be plain outside TV mode");
            assert!(is_kiosk_path(p, true));
        }
        assert!(!is_kiosk_path("/css/cards.css", true));
        assert!(!is_kiosk_path("/tvboard", true));
    }
}

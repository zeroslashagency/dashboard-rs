#!/usr/bin/env python3
"""VMC Sequence Dashboard — static server (stdlib only, zero deps).

Serves this folder on VMC_DASH_PORT (default 9090) with no-cache + correct MIME
so ESM modules and the importmap load cleanly over the LAN. The dashboard reads
the collector API from the same host on VMC_API_PORT (see js/dataLayer.js)."""
import http.server
import os
import socketserver
import sys

# TV-board mode: when VMC_TV_ROOT is set (the standalone TV Wall Board service),
# this instance runs on VMC_TV_PORT and serves the full-screen kiosk board at
# "/" (and every non-asset path), so a wall TV just opens the bare host:port.
# When unset, this is the normal Sequence Dashboard on VMC_DASH_PORT and the
# kiosk board is available at /tv. Same code, same data layer either way.
TV_MODE = bool(os.environ.get("VMC_TV_ROOT"))
if TV_MODE:
    PORT = int(os.environ.get("VMC_TV_PORT") or "9995")
else:
    PORT = int(os.environ.get("VMC_DASH_PORT", "9090"))
# Collector API port the board should call. Propagated by the installer/control
# center (VMC_COLLECTOR_PORT, else VMC_API_PORT); defaults to 8091. Served to the
# browser via /config.js so no port is hardcoded in the static JS.
COLLECTOR_PORT = int(os.environ.get("VMC_COLLECTOR_PORT")
                     or os.environ.get("VMC_API_PORT") or "8091")
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        # Runtime config injected so the collector port is never hardcoded in JS.
        if path in ("/config.js", "/js/config.js"):
            body = ("window.__VMC_COLLECTOR_PORT__ = %d;\n" % COLLECTOR_PORT).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # TV / kiosk board: serve the SAME dashboard with a full-screen kiosk
        # skin injected (chrome hidden, larger cards, no config buttons). Reuses
        # the live grid + data layer so it never drifts from the main board.
        # In TV_MODE the kiosk is the landing page ("/"); otherwise it's at /tv.
        if path in ("/tv", "/tv/", "/tv.html") or (TV_MODE and path in ("/", "/index.html")):
            self._serve_tv()
            return
        super().do_GET()

    def _serve_tv(self) -> None:
        index_path = os.path.join(ROOT, "index.html")
        try:
            with open(index_path, "r", encoding="utf-8") as fh:
                html = fh.read()
        except OSError:
            self.send_error(404, "dashboard index not found")
            return
        # Kiosk skin: in TV mode hide nav + config buttons, keep .godview-host
        # visible for TV auto-switch (cards ↔ timeline). MutationObserver
        # removes nav/cfg the moment god-mode injects them.
        kiosk = (
            "<style id=\"vmc-tv\">"
            "html[data-tv] .godnav,"
            "html[data-tv] .topbar .cfg-btn{display:none!important}"
            "html[data-tv] body{overflow:auto;margin:0;background:#0b1120}"
            "html[data-tv] main{padding:0!important;margin:0!important}"
            "html[data-tv] .machine-grid{gap:16px;padding:16px}"
            "</style>"
            "<script>document.documentElement.setAttribute('data-tv','1');"
            "window.__VMC_TV__=true;"
            "(function(){var strip=function(){"
            "document.querySelectorAll('.godnav,.topbar .cfg-btn')"
            ".forEach(function(el){el.style.display='none';});};"
            "if(document.readyState!=='loading')strip();"
            "document.addEventListener('DOMContentLoaded',strip);"
            "try{new MutationObserver(strip).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}"
            "})();</script>"
        )
        # Inject just before </head> so the kiosk skin loads with the page.
        if "</head>" in html:
            html = html.replace("</head>", kiosk + "</head>", 1)
        else:
            html = kiosk + html
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


Handler.extensions_map.update({
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".mdx": "text/plain",
})


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"VMC Sequence Dashboard serving {ROOT} on http://0.0.0.0:{PORT}", flush=True)
        httpd.serve_forever()

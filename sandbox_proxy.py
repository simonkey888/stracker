#!/usr/bin/env python3
"""
Sandbox proxy for stracker V9.
Serves the static nextjs-ui/ build on port 3000 and proxies /points,
/osrm-route, /api/cookies* to the production Render backend so the
sandbox preview shows live telemetry without needing a local Python backend.
"""
import http.server
import socketserver
import urllib.request
import urllib.error
import os
import sys
from pathlib import Path

PORT = 3000
BASE_DIR = Path(__file__).parent / "nextjs-ui"
PRODUCTION = "https://strackerglm.onrender.com"

PROXY_PATHS = {"/points", "/osrm-route", "/api/cookies", "/api/cookies/status",
               "/health", "/ghostrail/encrypted", "/predict", "/api/archive",
               "/historial.csv", "/cookies.html"}


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in PROXY_PATHS or path.startswith("/api/archive"):
            return self._proxy()
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path in ("/api/cookies", "/cookies"):
            return self._proxy()
        self.send_error(404, "Not Found")

    def _proxy(self):
        url = PRODUCTION + self.path
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length > 0 else None
            req = urllib.request.Request(url, data=body, method=self.command)
            for k, v in self.headers.items():
                if k.lower() not in ("host", "content-length", "connection"):
                    req.add_header(k, v)
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() not in ("transfer-encoding", "connection", "content-encoding"):
                        self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            msg = f"Proxy error: {e}".encode()
            self.send_response(502)
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[proxy] {self.address_string()} - {fmt % args}\n")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    os.chdir(str(BASE_DIR))
    print(f"[V9 sandbox proxy] serving {BASE_DIR} on :{PORT} (proxy → {PRODUCTION})", flush=True)
    with Server(("0.0.0.0", PORT), ProxyHandler) as httpd:
        httpd.serve_forever()

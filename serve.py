"""Tiny dev server with `Cache-Control: no-store` on every response.

The default `python3 -m http.server` sends no cache headers, which lets browsers
aggressively memory-cache ES modules — editing a file then reloading shows the
OLD code. This serves the same tree but tells browsers never to cache.
"""

import http.server
import os
import socketserver
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    # Prefer an explicit CLI arg, then the harness-assigned PORT env var, else a
    # default. This lets the dev server take whatever port is free.
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8473))
    with socketserver.ThreadingTCPServer(("", port), NoCacheHandler) as httpd:
        httpd.allow_reuse_address = True
        print(f"serving on http://localhost:{port}")
        httpd.serve_forever()

"""Tiny dev server with `Cache-Control: no-store` on every response.

The default `python3 -m http.server` sends no cache headers, which lets browsers
aggressively memory-cache ES modules — editing a file then reloading shows the
OLD code. This serves the same tree but tells browsers never to cache.
"""

import http.server
import os
from pathlib import Path
import re
import socketserver
import sys


CAPTURE_PATH = "/__trailer_capture__/"
CAPTURE_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]*\.(?:webm|json)$")
MAX_CAPTURE_BYTES = 1024 * 1024 * 1024


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        """Accept local trailer recordings without exposing a general upload API."""
        if not self.path.startswith(CAPTURE_PATH):
            self.send_error(404)
            return
        filename = self.path[len(CAPTURE_PATH):]
        if not CAPTURE_NAME.fullmatch(filename):
            self.send_error(400, "invalid capture name")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(411)
            return
        if length <= 0 or length > MAX_CAPTURE_BYTES:
            self.send_error(413)
            return
        capture_dir = Path.cwd() / "trailer" / "raw"
        capture_dir.mkdir(parents=True, exist_ok=True)
        target = capture_dir / filename
        remaining = length
        with target.open("wb") as output:
            while remaining:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    target.unlink(missing_ok=True)
                    self.send_error(400, "incomplete capture")
                    return
                output.write(chunk)
                remaining -= len(chunk)
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(
            (f'{{"ok":true,"file":"trailer/raw/{filename}","bytes":{length}}}').encode()
        )

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    # Prefer an explicit CLI arg, then the harness-assigned PORT env var, else a
    # default. This lets the dev server take whatever port is free.
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8473))
    # Development and capture are intentionally loopback-only. Besides avoiding
    # accidental LAN exposure of the source tree, this keeps the narrowly
    # scoped trailer POST endpoint local to the machine doing the recording.
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), NoCacheHandler) as httpd:
        httpd.allow_reuse_address = True
        print(f"serving on http://localhost:{port}")
        httpd.serve_forever()

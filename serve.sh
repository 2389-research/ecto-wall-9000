#!/bin/sh
# ABOUTME: Serves ECTO-WALL 9000 on port 44678 ("GHOST" on a phone pad) with caching
# ABOUTME: disabled, so a redeploy never strands a stale main.js importing deleted modules.
# Usage: ./serve.sh [bind-address]   (default 0.0.0.0)
# Camera access requires a secure context: use http://localhost:44678 (or front with `tailscale serve` for remote https).
cd "$(dirname "$0")" || exit 1
exec python3 - "${1:-0.0.0.0}" <<'PYEOF'
import http.server
import sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # no-cache means "revalidate every time", not "never cache" — 304s keep it
        # cheap while guaranteeing clients never run a stale module graph.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

http.server.ThreadingHTTPServer((sys.argv[1], 44678), Handler).serve_forever()
PYEOF

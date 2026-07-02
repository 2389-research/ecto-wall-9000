#!/bin/sh
# ABOUTME: Serves ECTO-WALL 9000 on port 44678 ("GHOST" on a phone pad).
# ABOUTME: Camera access requires a secure context: use http://localhost:44678 (or front with `tailscale serve` for remote https).
cd "$(dirname "$0")"
exec python3 -m http.server 44678 --bind 0.0.0.0

#!/usr/bin/env python3
"""Serves dist/ with CORS headers so Penpot can load the plugin manifest."""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7780
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")


class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, fmt, *args):
        pass


if not os.path.isdir(ROOT):
    sys.exit("dist/ not found. Run: npm run build")

print(f"Broken Component Repair: http://localhost:{PORT}/manifest.json")
http.server.HTTPServer(("", PORT), CORSHandler).serve_forever()

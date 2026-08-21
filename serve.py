#!/usr/bin/env python3
"""Serves the plugin with CORS headers so Penpot can load the manifest."""
import http.server
import os
import socket
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7782
ROOT = os.path.dirname(os.path.abspath(__file__))


class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        # Chromium (Chrome, Edge) blocks a public https page from fetching
        # anything on localhost unless the server opts in. Penpot loads
        # index.html as an iframe, which is allowed, but fetches plugin.js,
        # which is not, so the panel opens and the sandbox never starts.
        # Firefox does not implement this, which is why it works there.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        pass


class DualStackServer(http.server.ThreadingHTTPServer):
    """Chromium resolves localhost to ::1 before it tries 127.0.0.1, so an
    IPv4-only bind answers curl fine and refuses the browser outright."""

    address_family = socket.AF_INET6
    daemon_threads = True

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        return super().server_bind()


def serve():
    try:
        return DualStackServer(("::", PORT), CORSHandler)
    except OSError:
        # A host without IPv6 still deserves a working server.
        return http.server.ThreadingHTTPServer(("", PORT), CORSHandler)


print(f"Broken Component Repair: http://localhost:{PORT}/manifest.json")
serve().serve_forever()

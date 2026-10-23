#!/usr/bin/env python3
"""Ring webhook receiver using only the Python standard library and python/verify.py.

    python3 examples/python-webhook.py            # listens on :3001 (PORT env to change)
    node bin/ring-sandbox.js serve --webhook-url http://localhost:3001/webhooks/ring
    node bin/ring-sandbox.js fire button_press --via http://localhost:8686

In your own project, copy python/verify.py next to your code (it has no dependencies).
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
from verify import first_delivery, verify_signature  # noqa: E402

KEY = os.environ.get("RING_WEBHOOK_SECRET", "sandbox-signing-key")
PORT = int(os.environ.get("PORT", "3001"))


class RingWebhook(BaseHTTPRequestHandler):
    def _reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path != "/webhooks/ring":
            return self._reply(404, {"error": "not found"})
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        # Verify the raw bytes, never re-serialised JSON.
        if not verify_signature(KEY, raw, self.headers.get("X-Signature")):
            return self._reply(401, {"error": "invalid signature"})
        event = json.loads(raw)
        if not first_delivery(event.get("meta", {}).get("request_id")):
            return self._reply(200, {"ok": True, "duplicate": True})
        data = event.get("data", {})
        attrs = data.get("attributes", {})
        sub = attrs.get("sub_type")
        print(f"event {data.get('type')}{'.' + sub if sub else ''} request_id={event['meta'].get('request_id')}", flush=True)
        self._reply(200, {"ok": True})

    def log_message(self, *args):  # keep output to one line per event
        pass


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), RingWebhook)
    print(f"python webhook receiver listening on http://127.0.0.1:{server.server_port}/webhooks/ring", flush=True)
    server.serve_forever()

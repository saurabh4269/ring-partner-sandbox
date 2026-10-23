#!/usr/bin/env node
// Plain node:http webhook receiver for Ring events, using the verify middleware.
// Verifies X-Signature (HMAC-SHA256 of the raw body), drops duplicate deliveries, logs each event.
//
//   node examples/webhook-receiver.mjs                    # listens on :3000
//   node bin/ring-sandbox.js serve --webhook-url http://localhost:3000/webhooks/ring
//   node bin/ring-sandbox.js fire motion_detected --sub-type human --via http://localhost:8686
//
// In your own project: import { ringWebhookMiddleware } from 'ring-partner-sandbox/verify';
// With Express:        app.post('/webhooks/ring', ringWebhookMiddleware(key), handler)
import http from 'node:http';
import { ringWebhookMiddleware } from '../src/verify.js';

const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.RING_WEBHOOK_SECRET || 'sandbox-signing-key';
const verify = ringWebhookMiddleware(KEY, { onDuplicate: (b) => console.log(`duplicate ${b.meta.request_id} ignored`) });

function handle(event) {
  const { type, attributes = {} } = event.data;
  const device = attributes.source || '';
  switch (type) {
    case 'motion_detected':
      return `motion (${attributes.sub_type || 'motion'}) on ${device}`;
    case 'button_press':
      return `doorbell pressed on ${device}`;
    case 'device_offline':
    case 'device_online':
      return `${device} is now ${type === 'device_online' ? 'online' : 'offline'}`;
    default:
      return `${type} ${device}`;
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhooks/ring') { res.statusCode = 404; return res.end(); }
  verify(req, res, () => {
    console.log(`event ${req.body.data.type}: ${handle(req.body)} (request_id=${req.body.meta.request_id})`);
    // Acknowledge fast (Ring times out after 5s and retries 5xx); do slow work asynchronously.
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`webhook receiver listening on http://127.0.0.1:${server.address().port}/webhooks/ring`));

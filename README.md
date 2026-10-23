# ring-partner-sandbox

A local mock of the **Ring Partner API** (`https://api.amazonvision.com`, JSON:API) plus a **signed webhook simulator**, so you can build and test a Ring integration without a live token and run your webhook handler against realistic events.

- Zero runtime dependencies. Node.js 20 or newer, ESM. Nothing to install.
- Response shapes, headers, error envelopes and webhook payloads follow the public Ring Partner API docs.
- Webhooks are signed exactly as the docs describe (`X-Signature: sha256=<hex HMAC-SHA256 of the raw body>`).
- Includes a verifier library (JS and Python) and Node `http`/Express middleware.

> **Unofficial.** This project is not affiliated with, endorsed by or supported by Ring LLC or Amazon. Endpoint shapes are derived from the public [Ring Partner API documentation](https://developer.amazon.com/docs/ring/api-documentation.html). The real API can differ from this mock. Before you ship, test against the real service.

## Why

The Ring Developer Playground is the official way to try the Partner API, but it has limits that slow down day-to-day development:

| Pain point | What the sandbox gives you |
|---|---|
| Playground tokens expire after about **30 minutes** | A fixed bearer token (`sandbox-token`) that never expires |
| The Playground **can't send webhooks**, so you can't exercise `motion_detected`, `button_press`, `device_offline` and similar events | All 10 documented v1.1 event types, HMAC-signed and sent to your URL, one at a time or as timed scenarios |
| There's **no SDK**, so you have to get the headers, 303 redirect, JSON:API envelopes and WAF quirks right by hand | A server that enforces the same rules (Bearer, `User-Agent`/`Hardware_Id` 406, 303 snapshot flow) so mistakes surface locally |
| Webhooks and history are unrelated in ad-hoc mocks | Events fired through `serve` go into mock history **and** out as webhooks, so `/v1/history` matches what your handler received |

## Quick start

```bash
git clone https://github.com/saurabh4269/ring-partner-sandbox
cd ring-partner-sandbox
node bin/ring-sandbox.js serve --webhook-url http://localhost:3000/webhooks/ring
```

In another terminal:

```bash
H=(-H 'User-Agent: MyApp/1.0' -H 'Hardware_Id: 550e8400-e29b-41d4-a716-446655440000' -H 'Authorization: Bearer sandbox-token')
curl -s "${H[@]}" 'http://localhost:8686/v1/devices?include=status,capabilities'

# Snapshot: POST (-d) returns a 303; -L follows it with a GET (no -X POST, or curl keeps POSTing)
curl -sL "${H[@]}" -H 'Content-Type: application/json' \
  -d "{\"type\":\"latest_in_range\",\"start_timestamp\":$(( $(date +%s)000 - 3600000 ))}" \
  http://localhost:8686/v1/devices/ava1.ring.device.SANDBOX0001/media/image/download -o snap.jpg

# Fire a signed webhook through the server (also recorded in /v1/history)
node bin/ring-sandbox.js fire motion_detected --sub-type human --via http://localhost:8686

# Play a timed scenario 10x faster than real time
node bin/ring-sandbox.js play scenarios/porch-delivery.json --via http://localhost:8686 --speed 10
```

You can also install the CLI globally with `npm i -g github:saurabh4269/ring-partner-sandbox`, then run `ring-sandbox serve`.

## Point your app at it

Make your Ring API base URL configurable, then set it to the sandbox:

```bash
RING_API_BASE=http://localhost:8686 RING_ACCESS_TOKEN=sandbox-token npm start
```

For example, [DropZone+](https://github.com/saurabh4269/dropzone-plus) reads `RING_API_BASE`, and its probe script runs end to end against the sandbox:

```
$ RING_API_BASE=http://localhost:8686 RING_ACCESS_TOKEN=sandbox-token node scripts/ring-probe.js
✓ GET /v1/users/me
✓ GET /v1/devices
✓ GET status
✓ GET capabilities
✓ GET history
✓ POST image/download (snapshot)
  snapshot 3520 bytes, ts=1792767620679, origin=recording
```

Snapshot download URLs are absolute and point back to the sandbox host. Like Ring's signed URLs, they carry their own `security_token`, so don't send the bearer token to them.

## CLI reference

### `serve`

| Flag | Default | Description |
|---|---|---|
| `--port` | `8686` (or `$PORT`) | Port to listen on |
| `--host` | `127.0.0.1` | Bind address. Use `0.0.0.0` for Docker or LAN access. |
| `--token` | `sandbox-token` (or `$RING_SANDBOX_TOKEN`) | Accepted bearer token. Anything else gets a 401. |
| `--webhook-url` | `$RING_WEBHOOK_URL` | Where fired events are POSTed. If unset, events are only recorded in history. |
| `--signing-key` | `sandbox-signing-key` (or `$RING_WEBHOOK_SECRET`) | HMAC key for `X-Signature` |
| `--devices N` | `1` | Number of simulated devices. Device 1 is a DoorbellPro-like doorbell. The others are cameras. |
| `--snapshot file.jpg` | built-in placeholder | Serve your own JPEG or PNG from the snapshot endpoint |
| `--scenario file.json` / `--speed` | none / `1` | Play a scenario on startup, recording each event to history and sending its webhook |
| `--no-waf` | WAF on | Stop requiring `User-Agent` and `Hardware_Id` (by default, a missing header gets a 406) |
| `--no-sim-flag` | flag on | Leave out the non-standard `meta.simulated: true` |
| `--fixtures dir/` | none | Serve recorded responses (see [Record and replay](#record-and-replay-real-responses)) before falling back to the mock |
| `--no-seed` | seeded | Start with empty history (by default, each device gets 5 events from the last hour) |

### `fire <type>`

Sends one v1.1 webhook. Supported types: `motion_detected`, `button_press`, `device_online`, `device_offline`, `device_added`, `device_removed`, `app_integration_added`, `app_integration_removed`, `subscription_activated`, `subscription_deactivated`.

| Flag | Description |
|---|---|
| `--sub-type` | For motion: `human`, `vehicle`, `motion`, `other_motion` or `animal`. For subscriptions: `paid` or `trial`. |
| `--url` | Webhook endpoint (or `$RING_WEBHOOK_URL`). Without `--url` or `--via`, the payload is printed instead of sent. |
| `--signing-key` | HMAC key (or `$RING_WEBHOOK_SECRET`; defaults to `sandbox-signing-key`) |
| `--device`, `--account` | Override the device ID and account ID |
| `--via http://localhost:8686` | Send through a running `serve` so the event also lands in mock history and changes device state. The server's own signing key is used. |
| `--no-sim-flag`, `--print` | Leave out `meta.simulated`; print the payload |

### `play <scenario.json>`

Plays a timed sequence of events. Accepts the same `--url`, `--via`, `--signing-key`, `--device` and `--no-sim-flag` flags as `fire`, plus `--speed N` (`10` runs 10x faster than real time). A scenario is a JSON array:

```json
[
  { "at": 0,  "type": "motion_detected", "sub_type": "vehicle" },
  { "at": 20, "type": "motion_detected", "sub_type": "human" },
  { "at": 28, "type": "button_press" }
]
```

`at` is the number of seconds from the start. Steps are sorted by `at`, and steps with the same `at` keep their file order. Two scenarios ship in `scenarios/`: `porch-delivery.json` and `integration-lifecycle.json` (link an app, add a device, go offline and back online, unlink).

### Sandbox control endpoints

These aren't part of the Ring API. They take no auth, so keep the sandbox on localhost.

- `GET /_sandbox/state`: devices, history count and recent webhook deliveries with their status codes
- `POST /_sandbox/events` with `{"type":"motion_detected","sub_type":"human","device":"…","url":"optional override"}`: same as `fire --via`
- `POST /_sandbox/reset` (`?seed=false` to start empty)

Events also update mock state. `device_offline` and `device_online` toggle `status.online`, `device_removed` hides the device (a later request for it gets a 404), and `device_added` restores or creates it. `motion_detected` adds a `motion` history event and `button_press` adds a `ding`.

## Record and replay real responses

Playground tokens last about 30 minutes. Spend them recording, then develop against the recording forever:

```bash
# 1. Start a recording proxy in front of the real API
npx ring-sandbox record --upstream https://api.amazonvision.com --port 8687 --out fixtures/

# 2. Point your app (or curl) at the proxy with your real Playground token and click around
RING_API_BASE=http://localhost:8687 RING_ACCESS_TOKEN=<playground token> npm start

# 3. Later, offline, with the never-expiring sandbox token
npx ring-sandbox serve --fixtures fixtures/
RING_API_BASE=http://localhost:8686 RING_ACCESS_TOKEN=sandbox-token npm start
```

- The proxy forwards your `Authorization`, `User-Agent` and `Hardware_Id` headers and returns upstream responses unchanged.
- Snapshot redirects are routed back through the proxy so the image is captured: the `POST …/media/image/download` fixture stores the `303` plus the image file next to it. On replay the sandbox issues its own 303 and serves the recorded bytes.
- Each response becomes one readable file, `METHOD_path[__queryhash].json`, containing `request` (method, path, canonical query, JSON body) and `response` (status, content headers, body). Edit them by hand to craft edge cases.
- **Redaction.** The `Authorization` header is never written to disk. Bearer tokens seen on the wire and signed-URL credentials (`security_token`, `X-Amz-Signature`, …) are always replaced with `REDACTED`. By default (`--redact`) Ring account ids become stable placeholders (`ava1.ring.account.REDACTED0001`) and e-mail addresses are masked; `--no-redact` keeps them. Review fixtures before committing them anyway.
- 401, 403, 406, 429 and 5xx responses are not saved (they describe your session, not your data). 404s and other 4xx are.
- Replay matching: exact method + path + query first (volatile params like `security_token`, `req_id`, `X-Amz-Date` are ignored), then method + path. Anything unmatched falls back to the built-in mock. Auth and WAF checks still apply in front of fixtures. Replayed responses carry an `X-Sandbox-Fixture` header naming the file, and `/_sandbox/state` reports the fixture count.
- Programmatic use: `createRecorder({ upstream, out, redact })` and `createSandbox({ fixtures: 'fixtures/' })` from `ring-partner-sandbox`. `RING_UPSTREAM` sets the default `--upstream`.

## GitHub Action

The repo is also a composite GitHub Action that starts the sandbox in the background, waits until it answers, and exposes its URL. Use it to run your Ring integration tests in CI with no secrets:

```yaml
# .github/workflows/ring-integration.yml (in your repo)
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - id: ring
        uses: saurabh4269/ring-partner-sandbox@v0.2.0
        with:
          webhook-url: http://127.0.0.1:3000/webhooks/ring   # optional
          signing-key: test-signing-key
          scenario: test/ring-scenario.json                  # optional
      - run: npm test
        env:
          RING_API_BASE: ${{ steps.ring.outputs.base-url }}
          RING_ACCESS_TOKEN: ${{ steps.ring.outputs.token }}
          RING_WEBHOOK_SECRET: test-signing-key
```

| Input | Default | |
|---|---|---|
| `port` | `8686` | Bound to `127.0.0.1` |
| `token` | `sandbox-token` | Accepted bearer token |
| `webhook-url` | none | Where fired events are delivered |
| `signing-key` | `sandbox-signing-key` | HMAC key for `X-Signature` |
| `scenario` / `speed` | none / `1` | Scenario to play on startup |
| `devices` | `1` | Number of simulated devices |
| `fixtures` | none | Directory of recorded fixtures to replay |
| `waf` | `true` | `false` disables the `User-Agent`/`Hardware_Id` 406 check |
| `timeout` | `15` | Seconds to wait for readiness |

Outputs: `base-url`, `token`, `log-file`. The server PID is exported as `$RING_SANDBOX_PID`. A complete workflow is in [`examples/github-actions/ci.yml`](examples/github-actions/ci.yml).

## Verifying webhooks in your app

```js
import { verifySignature, ringWebhookMiddleware, idempotency } from 'ring-partner-sandbox/verify';

// Low level: always verify the raw bytes, never re-serialised JSON.
verifySignature(process.env.RING_WEBHOOK_SECRET, rawBodyBuffer, req.headers['x-signature']); // -> boolean

// node:http / Express / Connect middleware: reads the raw body, returns 401 on a bad signature,
// acknowledges duplicate meta.request_id with a 200 (Ring retries 5xx), and sets req.body.
app.post('/webhooks/ring', ringWebhookMiddleware(process.env.RING_WEBHOOK_SECRET), (req, res) => {
  console.log(req.body.data.type);
  res.sendStatus(200);
});
```

With Express, don't put `express.json()` in front of this route, because it consumes the body. If you need a body parser there, use `express.raw({ type: '*/*' })`; the middleware reuses the Buffer. For Python, [`python/verify.py`](python/verify.py) provides `verify_signature(key, raw_bytes, header)` and `first_delivery(request_id)`, built on `hmac.compare_digest`.

## Fidelity

| Area | Status |
|---|---|
| `GET /v1/users/me` | Matches the documented shape |
| `GET /v1/devices` with `?include=status,capabilities,configurations,location` | Matches the documented shape: JSON:API compound document, `relationships` with `data` and `links.related`, top-level `included`, and `meta.time` |
| `/v1/devices/{id}` and its `/status`, `/capabilities`, `/configurations`, `/location` | Matches the documented shape. Values are fixed and DoorbellPro-like (1080p AVC, motion zones, `e2e_encryption.enabled: false`). |
| `GET /v1/history/devices/{id}/events` | Matches: newest first, `event_types` filter including composite values like `motion.human`, and `links.next` with `page[key]`. Approximated: 20 events per page. Viewing a snapshot of an event sets its `is_third_party_reviewed` to true. |
| Snapshot `POST …/media/image/download` → `303` → `GET /v1/download?security_token=…&req_type=image_download&req_id=…` | Matches the flow, the `X-Media-Timestamp`/`X-Media-Origin`/`X-Request-ID` headers, the `at_timestamp`/`latest_in_range` validation (180 days, 24-hour window) and JPEG/PNG output. Approximated: the image is a placeholder (or your `--snapshot` file), download links expire after 60 seconds, and `components` is ignored. |
| Auth | `Bearer` required, otherwise 401 `UNAUTHORIZED`. Approximated: one static token with no expiry. |
| WAF | 406 if `User-Agent` or `Hardware_Id` is missing (`--no-waf` turns this off). The 406 for datacenter IP addresses isn't simulated. |
| Errors | Documented envelope: `{"errors":[{"id","status","code","detail","source":{"pointer"},"meta":{"timestamp"}}]}`, with codes such as `INVALID_PAYLOAD`, `UNAUTHORIZED`, `REQUEST_FORBIDDEN`, `DEVICE_NOT_FOUND` and `MEDIA_NOT_FOUND` |
| Webhooks v1.1 | Matches: `meta.version`/`time`/`request_id`/`account_id`, per-type `data` shapes (device, `users`-sourced app integration, and subscription events with `source_id`/`plan_id`/`expires_at`), and the `X-Signature` HMAC-SHA256 over the raw body. Non-standard: `meta.simulated: true` (`--no-sim-flag` removes it). `timestamp_readable` is in UTC. |
| Webhook retries and backoff (1s, 5s, 30s, …) and the 5-second timeout | Partial: one attempt with a 5-second timeout, and the result is recorded in `/_sandbox/state`. No retries. |
| **Not mocked** | WHEP live streaming and video clip download (both return 501 `NOT_IMPLEMENTED`), OAuth (`oauth.ring.com` token exchange and refresh), account linking and `app-integrations`, the Subscriptions query API, chimes and other non-camera devices, multi-camera `components`, rate limiting |

Found a mismatch with the docs or the real API? Please open an issue with the docs section or a redacted real response.

## Development

```bash
npm test     # node --test, no dependencies
```

The code is in `src/`: `server.js` (mock API), `events.js` (payload builders), `verify.js` (signatures, middleware, idempotency), `deliver.js`, `scenario.js` and `image.js`.

## License

MIT. See [LICENSE](LICENSE). Ring and Amazon are trademarks of their respective owners. They're mentioned here only to describe compatibility.

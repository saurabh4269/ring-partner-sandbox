# ring-partner-sandbox

A local, zero-dependency stand-in for the **Ring Partner API** (`https://api.amazonvision.com`, JSON:API) with a **signed webhook simulator** and a **record/replay proxy**. Build and test a Ring integration without waiting on a 30-minute Playground token: develop against realistic mock data, fire every documented webhook at your handler with a valid `X-Signature`, capture a real Playground session once and replay it forever, and run all of it in CI with a one-line GitHub Action.

> **Unofficial. Not affiliated with, endorsed by or supported by Ring LLC or Amazon.** Endpoint shapes are derived from the public [Ring Partner API documentation](https://developer.amazon.com/docs/ring/api-documentation.html). The real API can differ from this mock. Before you ship, test against the real service.

## Features

- **Mock API** for users, devices (with JSON:API `include`), status, capabilities, configurations, location, event history with filters and pagination, and the snapshot `POST` → `303` → signed download flow. It enforces the same rules as Ring (Bearer 401, `User-Agent`/`Hardware_Id` 406, documented error envelopes), so mistakes surface locally.
- **Webhook simulator** for all 10 documented v1.1 event types, HMAC-SHA256 signed exactly as documented. Fire them one at a time or as timed scenarios. Events also land in mock history and change device state.
- **Record / replay**: a transparent proxy that saves real API responses (and snapshot images) as redacted fixtures, then `serve --fixtures` replays them. [Details](#record-and-replay-real-responses)
- **GitHub Action**: `uses: saurabh4269/ring-partner-sandbox@v0.2.1` gives your CI a running sandbox and its `base-url`. [Details](#github-action)
- **Verifiers** for JS (`verifySignature`, node:http/Express middleware with idempotency) and Python (stdlib only).
- **Runnable examples** for a Node client and Node/Python webhook receivers, all covered by the test suite.
- Node.js 20 or newer, ESM, no runtime dependencies, nothing to install.

## 60-second quick start

Needs Node.js 20 or newer and nothing else: there is no `npm install` step, because there are no dependencies.

```bash
git clone https://github.com/saurabh4269/ring-partner-sandbox && cd ring-partner-sandbox
npm test                                                                      # 33 tests, about 1 second
node examples/webhook-receiver.mjs &                                          # a signed-webhook receiver on :3000
node bin/ring-sandbox.js serve --webhook-url http://localhost:3000/webhooks/ring &   # the mock API on :8686
sleep 1
node examples/node-client.mjs                                                 # devices, history, snapshot.jpg
node bin/ring-sandbox.js play scenarios/porch-delivery.json --via http://localhost:8686 --speed 10
kill %1 %2                                                                    # stop both background servers
```

The client prints your devices and recent events and saves `snapshot.jpg`. The receiver logs each verified event as the scenario plays (vehicle, person, doorbell press). The [curl walkthrough](#quick-start-with-curl) below shows the raw HTTP.

## Why

The Ring Developer Playground is the official way to try the Partner API, but it has limits that slow down day-to-day development:

| Pain point | What the sandbox gives you |
|---|---|
| Playground tokens expire after about **30 minutes** | A fixed bearer token (`sandbox-token`) that never expires |
| The Playground **can't send webhooks**, so you can't exercise `motion_detected`, `button_press`, `device_offline` and similar events | All 10 documented v1.1 event types, HMAC-signed and sent to your URL, one at a time or as timed scenarios |
| There's **no SDK**, so you have to get the headers, 303 redirect, JSON:API envelopes and WAF quirks right by hand | A server that enforces the same rules (Bearer, `User-Agent`/`Hardware_Id` 406, 303 snapshot flow) so mistakes surface locally |
| Webhooks and history are unrelated in ad-hoc mocks | Events fired through `serve` go into mock history **and** out as webhooks, so `/v1/history` matches what your handler received |

## Quick start with curl

```bash
node bin/ring-sandbox.js serve --webhook-url http://localhost:3000/webhooks/ring
```

In another terminal (bash or zsh; the receiver from the quick start is optional, without it webhook deliveries are just logged as failed):

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

For example, [DropZone](https://github.com/saurabh4269/dropzone-plus) reads `RING_API_BASE`, and its probe script runs end to end against the sandbox:

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

Playground tokens last about 30 minutes. Spend them recording, then develop against the recording forever. (Commands assume `npm i -g github:saurabh4269/ring-partner-sandbox`; otherwise use `node bin/ring-sandbox.js`.)

```bash
# 1. Start a recording proxy in front of the real API
ring-sandbox record --upstream https://api.amazonvision.com --port 8687 --out fixtures/

# 2. Point your app (or curl) at the proxy with your real Playground token and click around
RING_API_BASE=http://localhost:8687 RING_ACCESS_TOKEN=<playground token> npm start

# 3. Later, offline, with the never-expiring sandbox token
ring-sandbox serve --fixtures fixtures/
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
        uses: saurabh4269/ring-partner-sandbox@v0.2.1
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

## Examples

| File | What it shows |
|---|---|
| [`examples/node-client.mjs`](examples/node-client.mjs) | A dependency-free client: required WAF headers, `include=status` and resolving `included`, history filters, and the snapshot 303 flow without leaking the bearer token to the signed URL. Respects `RING_API_BASE` / `RING_ACCESS_TOKEN`, so it also works against the real API or a recording proxy. |
| [`examples/webhook-receiver.mjs`](examples/webhook-receiver.mjs) | A `node:http` receiver using `ringWebhookMiddleware`: signature check, duplicate `request_id` handling, fast acknowledgement. The same middleware works in Express. |
| [`examples/python-webhook.py`](examples/python-webhook.py) | The same receiver in Python using only `http.server` and [`python/verify.py`](python/verify.py). Listens on `:3001`. |
| [`examples/github-actions/ci.yml`](examples/github-actions/ci.yml) | A complete CI workflow using the action. |

`npm test` runs each example against a live sandbox, so they stay working.

## Use with DropZone

[DropZone](https://github.com/saurabh4269/dropzone-plus) is a Ring integration that reads `RING_API_BASE`, so it runs end to end against the sandbox:

```bash
# terminal 1
node bin/ring-sandbox.js serve --webhook-url http://localhost:3000/webhooks/ring
# terminal 2, in a clone of github.com/saurabh4269/dropzone-plus
RING_API_BASE=http://localhost:8686 RING_ACCESS_TOKEN=sandbox-token npm start
```

Any integration can do the same: make the API base URL configurable and point it at the sandbox (or at `serve --fixtures` with a recorded session).

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

## API coverage

Every endpoint in the [Ring Partner API reference](https://developer.amazon.com/docs/ring/api-documentation.html) and how closely the sandbox follows it. **Full**: request validation, response shape and status codes follow the docs. **Approximate**: the flow and shape match, with the simplifications listed. **Not mocked**: returns the status shown so your code fails loudly instead of silently.

| Method | Path | Fidelity | Notes |
|---|---|---|---|
| `GET` | `/v1/users/me` | Full | Fixed account `ava1.ring.account.SANDBOX0001` |
| `GET` | `/v1/devices` | Full | JSON:API compound document; `?include=status,capabilities,configurations,location` adds top-level `included`; `relationships` with `data` and `links.related`; `meta.time`. Unknown `include` gets 400 `INVALID_PAYLOAD`. |
| `GET` | `/v1/devices/{device_id}` | Full | 404 `DEVICE_NOT_FOUND` for unknown or removed devices |
| `GET` | `/v1/devices/{device_id}/status` | Approximate | Documented shape; `online` follows `device_online`/`device_offline` events, other values are fixed |
| `GET` | `/v1/devices/{device_id}/capabilities` | Approximate | Documented shape with fixed DoorbellPro-like values (1080p AVC, motion zones) |
| `GET` | `/v1/devices/{device_id}/configurations` | Approximate | Documented shape with fixed values (`e2e_encryption.enabled: false`) |
| `GET` | `/v1/devices/{device_id}/location` | Approximate | Documented shape with fixed values |
| `GET` | `/v1/history/devices/{device_id}/events` | Approximate | Newest first, `event_types` filter including composite values like `motion.human`, `links.next` with `page[key]`. Page size fixed at 20. Viewing an event's snapshot sets `is_third_party_reviewed`. |
| `POST` | `/v1/devices/{device_id}/media/image/download` | Approximate | `303` with `Location`, `X-Media-Timestamp`/`X-Media-Origin`/`X-Request-ID`; validates `at_timestamp`/`latest_in_range` (180 days, 24-hour window). The image is a placeholder or your `--snapshot` file; `components` is ignored. |
| `GET` | `/v1/download?security_token=…&req_type=image_download&req_id=…` | Approximate | Signed link, no bearer needed, JPEG or PNG. Links expire after 60 seconds. |
| `POST` | `/v1/devices/{device_id}/media/video/download` | Not mocked | 501 `NOT_IMPLEMENTED` |
| `POST`/`DELETE` | `/v1/devices/{device_id}/media/streaming/whep/sessions[/{session_id}]` | Not mocked | 501 `NOT_IMPLEMENTED` (WHEP live video) |
| — | `rtsps://video.rtsp.amazonvision.com:322/v1/devices/{device_id}/stream` | Not mocked | RTSPS live video is out of scope |
| `POST` | `/v1/devices/{device_id}/media/audio/playback` | Not mocked | 404 `NOT_FOUND` (chime audio) |
| `POST`/`PATCH`/`DELETE` | `/v1/accounts/me/app-integrations` | Not mocked | 404 `NOT_FOUND` (account linking) |
| `GET` | `/v1/accounts/me/subscriptions` | Not mocked | 404 `NOT_FOUND` (Subscriptions query API) |
| `POST` | `https://oauth.ring.com/oauth/token` | Not mocked | Use the fixed sandbox bearer token instead |
| Webhooks | all 10 v1.1 event types | Full | `meta.version`/`time`/`request_id`/`account_id`, per-type `data` shapes, `X-Signature` HMAC-SHA256 over the raw body. Non-standard `meta.simulated: true` (`--no-sim-flag` removes it); `timestamp_readable` is UTC. |
| Webhooks | retries with backoff, 5-second timeout | Approximate | One attempt with a 5-second timeout, result visible in `/_sandbox/state`. No retries. |

Cross-cutting behaviour:

| Area | Fidelity | Notes |
|---|---|---|
| Auth | Approximate | `Authorization: Bearer` required, otherwise 401 `UNAUTHORIZED`. One static token with no expiry. |
| WAF headers | Full | 406 if `User-Agent` or `Hardware_Id` is missing (`--no-waf` turns this off). The 406 for datacenter IP addresses isn't simulated. |
| Error envelope | Full | `{"errors":[{"id","status","code","detail","source":{"pointer"},"meta":{"timestamp"}}]}` with codes such as `INVALID_PAYLOAD`, `UNAUTHORIZED`, `REQUEST_FORBIDDEN`, `DEVICE_NOT_FOUND`, `MEDIA_NOT_FOUND` |
| Rate limiting | Not mocked | No 429s |
| Sensors, chimes, multi-camera `components` | Not mocked | Only cameras and doorbells are simulated |
| Record / replay | Approximate | Replayed JSON is byte-for-byte what the real API returned (after redaction). Matching ignores request bodies, so two different `POST` bodies to one path share a fixture (the last one recorded wins). Replayed snapshot links are issued by the sandbox. |

Found a mismatch with the docs or the real API? Please open an issue with the docs section or a redacted real response. [CONTRIBUTING.md](CONTRIBUTING.md#how-fidelity-is-checked) explains how fidelity is checked.

## Tests

```bash
npm test     # node --test: 33 tests, no dependencies, about 1 second
```

The tests start real servers on random ports and make no calls to Ring. They cover the mock API (auth, WAF, includes, history filters and paging, the snapshot 303 flow, error envelopes), every webhook payload and its signature, the JS and Python verifiers (the Python one is skipped if `python3` is missing), record/replay (using the sandbox itself as a fake upstream for the recorder), the composite action's start script, and each file in `examples/`.

## CI

The workflow is in [`ci/ci.yml`](ci/ci.yml): `npm test` on Node 20 and 22, plus a job that starts the sandbox with this repo's own composite action (`uses: ./`), checks `GET /v1/devices` and the 401 path, and fires a signed webhook. It lives in `ci/` rather than `.github/workflows/` because the token used to publish the repo can't push workflow files. To turn it on:

```bash
gh auth refresh -h github.com -s workflow   # once: grant the workflow scope
scripts/enable-ci.sh                        # copies ci/ci.yml to .github/workflows/ci.yml, commits, pushes
```

## Development

The code is in `src/`: `server.js` (mock API), `fixtures.js` (record proxy and replay), `events.js` (payload builders), `verify.js` (signatures, middleware, idempotency), `deliver.js`, `scenario.js` and `image.js`. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add an endpoint, and [CHANGELOG.md](CHANGELOG.md) for releases.

## License and disclaimer

Unofficial. Not affiliated with, endorsed by or supported by Ring LLC or Amazon. This is a community project, released under the MIT license. See [LICENSE](LICENSE). Ring and Amazon are trademarks of their respective owners. They're mentioned here only to describe compatibility.

# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-23

### Added
- **Record / replay.** `ring-sandbox record --upstream https://api.amazonvision.com --out fixtures/` runs a transparent proxy that forwards your `Authorization`, `User-Agent` and `Hardware_Id` headers to the real API, returns responses unchanged and saves each one as a readable JSON fixture. Snapshot 303 redirects are routed back through the proxy so the image is captured too.
- Redaction: the `Authorization` header is never written; bearer tokens and signed-URL credentials (`security_token`, `X-Amz-*`) are always replaced; account ids and e-mails are redacted by default (`--no-redact` keeps them). Auth, WAF, rate-limit and 5xx responses are not saved.
- `ring-sandbox serve --fixtures fixtures/` (and `createSandbox({ fixtures })`) serves recorded responses by method + path (+ query), replays recorded snapshots through the sandbox's own 303 flow, and falls back to the mock for everything else. Responses carry `X-Sandbox-Fixture`.
- **GitHub Action**: `uses: saurabh4269/ring-partner-sandbox@v0.2.0` starts the sandbox in the background, waits for readiness and outputs `base-url`, `token` and `log-file`. Example workflow in `examples/github-actions/ci.yml`.
- **Examples**: `examples/node-client.mjs` (devices, history, snapshot via 303), `examples/webhook-receiver.mjs` (node:http + verify middleware), `examples/python-webhook.py` (stdlib `http.server` + `python/verify.py`). All are exercised by the test suite.
- Package exports `ring-partner-sandbox/fixtures`; `createRecorder`, `loadFixtures`, `matchFixture` exported from the main entry.

### Changed
- npm metadata (bugs, homepage, author, keywords, `files`) for a clean `npm pack`.
- Removed a stray `__pycache__` from the repository.

## [0.1.0] - 2026-10-22

### Added
- Mock Ring Partner API: users/me, devices (+ JSON:API `include`), device status/capabilities/configurations/location, history with `event_types` filters and `page[key]` pagination, snapshot `POST` → `303` → download flow, JSON:API error envelopes, WAF (406) and bearer (401) checks.
- HMAC-SHA256 signed webhook simulator for all 10 v1.1 event types; `fire` and timed `play` scenarios; `--via` to keep history and webhooks consistent.
- Verifier library for JS (`verifySignature`, `ringWebhookMiddleware`, `idempotency`) and Python (`python/verify.py`).

[0.2.0]: https://github.com/saurabh4269/ring-partner-sandbox/releases/tag/v0.2.0
[0.1.0]: https://github.com/saurabh4269/ring-partner-sandbox/tree/7542520

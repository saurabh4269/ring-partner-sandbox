# Contributing

Thanks for helping make Ring development easier. Issues and pull requests are welcome, especially reports of places where the sandbox and the real API disagree.

## Dev setup

You need Node.js 20 or newer. Python 3 is optional: it's only used to test `python/verify.py`, and that test is skipped without it.

```bash
git clone https://github.com/saurabh4269/ring-partner-sandbox && cd ring-partner-sandbox
npm test                          # no npm install: there are no dependencies
node bin/ring-sandbox.js serve    # the mock API on http://127.0.0.1:8686
```

`GET /_sandbox/state` shows devices, history and recent webhook deliveries while you work.

## Tests

- `npm test` runs `node --test` over `test/*.test.js`. The whole suite takes about a second.
- Tests start real HTTP servers on port 0 (random) and talk to them with `fetch`. Nothing calls Ring.
- Every new endpoint, event type, CLI flag or action input needs a test. Every file in `examples/` is run by `test/examples.test.js`, so keep examples working.
- CI runs the same suite on Node 20 and 22 (see [`ci/ci.yml`](ci/ci.yml)). Run it locally before you open a PR.

## Style

- **No runtime dependencies.** Use the Node standard library only (ESM, `node:` imports). Dev dependencies need a very good reason too.
- Small, readable modules in `src/`. Match the surrounding code: two-space indent, single quotes, semicolons.
- Errors use the documented JSON:API envelope via `apiError(res, status, code, detail, pointer)` in `src/server.js`.
- Anything non-standard that the sandbox adds (for example `meta.simulated`) must be clearly marked and removable with a flag.
- Docs and messages in plain English. Keep PRs small and describe user-visible changes in the PR body and in `CHANGELOG.md` under an "Unreleased" heading.

## How to add an endpoint

1. Find the endpoint in the [Ring Partner API documentation](https://developer.amazon.com/docs/ring/api-documentation.html) and note the section: method, path, required headers, request body, success response, and error responses.
2. Add a route in `handle()` in `src/server.js`, after the auth check and the fixture lookup, so auth, WAF and record/replay apply to it automatically. Use `send(res, status, body)` for JSON and `apiError(...)` for errors. Return `DEVICE_NOT_FOUND` for unknown devices, as the existing device routes do.
3. If the endpoint changes state (for example app-integrations), keep that state in the `state` object so `/_sandbox/reset` clears it and `/_sandbox/state` can show it.
4. Add tests in `test/server.test.js`: the happy path with the documented shape, at least one documented error, and the 401/406 behaviour if it differs from the default.
5. Update the **API coverage** table in `README.md` (Full, Approximate or Not mocked, plus notes on any simplification) and add a `CHANGELOG.md` entry.

Webhook event types live in `src/events.js`: a payload builder plus an entry in `EVENT_TYPES`, which the CLI (`fire`, `play`) and `/_sandbox/events` read. A new event needs a builder, a test in `test/events.test.js` that checks the shape and signature, and a row in the README.

## How fidelity is checked

There is no official schema to validate against, so fidelity is checked by hand against two sources:

- **The public docs.** Each response shape, status code, header and error code should match an example or table in the Ring Partner API documentation. Link the doc section in your PR. When the docs are ambiguous, say so in the PR and pick the most conservative reading (the one that makes client code handle more cases).
- **Real responses.** If you have Playground access, `ring-sandbox record --upstream https://api.amazonvision.com --out fixtures/` captures real, redacted responses. Compare them with the mock's output, and attach the relevant fixture to the issue or PR. Review fixtures before you share them: never paste tokens, account IDs, e-mail addresses or signing keys.

Then label the endpoint honestly in the README coverage table. "Approximate" with a clear note is better than "Full" with a hidden difference.

## Scope

Good additions: missing documented endpoints (subscriptions query, app-integrations), webhook retry simulation, multi-camera `components`, sensors and chimes. Out of scope: anything that talks to real Ring services outside the explicit `record` proxy.

## Disclaimer

Unofficial. Not affiliated with, endorsed by or supported by Ring LLC or Amazon. By contributing you agree that your contribution is released under the [MIT license](LICENSE).

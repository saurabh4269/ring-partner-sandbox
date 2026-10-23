# Contributing

Thanks for helping make Ring development easier.

- **Fidelity first.** If you change a response shape, include a link to the doc section it comes from, or a redacted real response. Never paste tokens, account IDs or signing keys.
- **No runtime dependencies.** Use Node 20+ standard library only.
- **Tests.** Run `npm test` (`node --test`). New endpoints or event types need a test.
- **Scope.** Good additions: missing documented endpoints (subscriptions query, app-integrations), webhook retry simulation, multi-camera `components`. Out of scope: anything that talks to real Ring services.
- Keep PRs small. Describe user-visible changes in the PR body.

This is an unofficial community project. It is not affiliated with Ring or Amazon.

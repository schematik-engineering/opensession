# Grok ACP compatibility checklist

- [x] Reproduce and identify the production plan failure.
- [x] Ground ACP wire behavior, durable Ask recovery, accounts, fallback, and MCP placement.
- [x] Compare two structurally distinct architectures and cross-judge them.
- [x] Record the selected ownership and security invariants.
- [x] Unit 1: xAI extension adapter and deterministic fake-agent fixtures.
- [x] Unit 2: acknowledged detached-host Ask delivery.
- [x] Unit 3: single-attempt host protocol and server-owned coordinator.
- [x] Unit 4: central Grok account rotation and exact projection.
- [x] Unit 5: hosted MCP parity, ACP automation pins, and provider-neutral fallbacks.
- [x] Run focused blast-radius suites and module-side-effect check.
- [x] Run `bun run check`.
- [ ] Fetch, rebase if required, commit, and push.
- [ ] Deploy with `deploy_self`.
- [ ] Verify the production web, reconnect, MCP, rotation, fallback, and detached routes.
- [ ] Cross-model review the decision trail and close remaining findings.

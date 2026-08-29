# Grok and Cursor subscriptions over ACP

OpenSession runs Grok and Cursor through each vendor's official
[Agent Client Protocol](https://agentclientprotocol.com/) command. This uses
the existing SuperGrok and Cursor subscriptions; it does not proxy the consumer
subscription through an OpenAI-compatible API, add API-key billing, or fall
back to a different provider on exhaustion.

The Docker runner image pins:

- Grok CLI `1.0.13`, invoked as `grok agent stdio`.
- Cursor Agent build `2026.08.25-3e8eec8`, invoked as `cursor-agent acp`.

## Credential projection

Authenticate the official CLIs once on a trusted operator machine, then copy
only their native auth artifacts into the OpenSession state directory:

```text
~/.grok/auth.json             → ~/.opensession/acp/grok/auth.json
~/.grok/agent_id              → ~/.opensession/acp/grok/agent_id
~/.config/cursor/auth.json    → ~/.opensession/acp/cursor/auth.json
```

Directories must be mode 0700 and files mode 0600. Enable the providers in
`~/.opensession/acp.json`:

```json
{
  "grok": { "enabled": true },
  "cursor": { "enabled": true }
}
```

`authPath` and Grok's `agentIdPath` may override those source paths. The source
credential never enters a session file, run spec, environment variable,
command argument, transcript, or log. For a Docker turn, OpenSession refreshes
an expired native Grok OIDC token at the host-only source and atomically stores
any rotated refresh token with mode 0600. The launcher then copies the
credential into the private per-run directory; the ACP adapter consumes and
unlinks that copy, authenticates the vendor CLI, then deletes the CLI auth file
before the first model-visible prompt. Tool processes receive a separate empty
HOME and a filtered environment.

If the refresh grant is revoked or invalid, the run fails explicitly and asks
an operator to run `grok login` again on the OpenSession host. It never falls
back to an xAI API key or separate usage billing.

## Models

Grok exposes `grok/grok-4.6` and `grok/grok-4.5`. Cursor exposes
`cursor/auto` plus the curated subscription models shown by OpenSession's model
picker. A session retains the provider-native ACP session ID, so follow-up
turns load the same vendor conversation without replaying transcript text.

External MCP servers are filtered by the normal OpenSession allowlist and
per-user identity policy, then supplied through ACP session setup. In a Docker
run, trusted in-process OpenSession tools travel through the existing
session-scoped MCP proxy. Ask-mode permission requests still require human
approval; code-mode requests honor the normal denied/confirmation tool policy.

## Verification

From a checkout with the corresponding source credential configured:

```sh
bun scripts/verify-acp-provider.ts grok grok/grok-4.6
bun scripts/verify-acp-provider.ts cursor cursor/auto
```

Each command performs a real subscription-backed turn and exits non-zero
unless the expected response reaches a terminal `done` event. Live deployment
verification must additionally create Docker-backed sessions through the
public OpenSession UI; a host-only smoke test does not prove the sandbox path.

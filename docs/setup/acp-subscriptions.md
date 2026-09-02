# Grok and Cursor subscriptions over ACP

OpenSession runs Grok and Cursor through each vendor's official
[Agent Client Protocol](https://agentclientprotocol.com/) command. This uses
the existing SuperGrok and Cursor subscriptions; it does not proxy the consumer
subscription through an OpenAI-compatible API, add API-key billing, or fall
back to separate xAI API-key billing. Multiple subscriptions for the same
provider can be pooled and rotated before the configured cross-model fallback
begins.

The Docker runner image pins:

- Grok CLI `1.0.16`, invoked as `grok agent stdio`.
- Cursor Agent build `2026.08.25-3e8eec8`, invoked as `cursor-agent acp`.

Host-backed sessions require those same executables on the OpenSession system
service's `PATH`; installing them only in the Docker runner is not sufficient.
Keep the host and runner versions aligned so switching sandbox targets does not
change ACP protocol or session-state behavior. If a command is unavailable,
the affected turn reports a provider error without terminating the gateway.
OpenSession negotiates Grok's current `grok.com` ACP authentication method and
the earlier `cached_token` id during rolling CLI upgrades.

## Credential projection

The normal path is **Settings → Providers → Subscriptions → Add account**.
Choose SuperGrok or Cursor, choose whether the subscription is shared or owned
by one teammate, and complete the official browser sign-in. Grok uses its
device-code flow; Cursor provides its official one-time browser link. Each
completed login is copied into an isolated, mode-0700 account directory with a
mode-0600 auth file. The UI receives account metadata only, never credential
paths or tokens.

An existing operator-managed host login remains supported and appears as a
protected account in the same list. To provision that initial login manually,
copy only the native auth artifacts into the OpenSession state directory:

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

`authPath` and Grok's `agentIdPath` may override those host-account paths. The source
credential never enters a session file, run spec, environment variable,
command argument, transcript, or log. For a Docker turn, OpenSession refreshes
an expired native Grok OIDC token at the host-only source and atomically stores
any rotated refresh token with mode 0600. The launcher then copies the
credential into the private per-run directory; the ACP adapter consumes and
unlinks that copy, authenticates the vendor CLI, then deletes the CLI auth file
before the first model-visible prompt. Tool processes receive a separate empty
HOME and a filtered environment.

Shared accounts use durable session affinity: an OpenSession thread resumes on
the subscription that owns its provider-native session. Personal accounts are
eligible only for their configured teammate and are preferred for that
person's runs. A usage-limit failure sidelines the account for an hour. A host
run retries immediately on another eligible account before the cross-model
fallback chain; a credential-minimal Docker run records the exhausted account
and selects another subscription on its next run. Switching subscriptions
starts a fresh provider-native session rather than loading one account's native
session under another account. The server retains that rotation and fallback
policy while a detached host is running, so gateway restart recovery continues
the logical turn instead of settling the current account's usage error.

If the refresh grant is revoked or invalid, the run fails explicitly and asks
an operator to run `grok login` again on the OpenSession host. It never falls
back to an xAI API key or separate usage billing.

## Models

Grok exposes `grok/grok-4.6` and `grok/grok-4.5`. Cursor exposes
`cursor/auto` plus the curated subscription models shown by OpenSession's model
picker. A session retains the provider-native ACP session ID while its account
binding is unchanged, so follow-up turns load the same vendor conversation
without replaying transcript text.

External MCP servers are filtered by the normal OpenSession allowlist and
per-user identity policy, then supplied through ACP session setup. In a Docker
run, trusted in-process OpenSession tools travel through the existing
session-scoped MCP proxy. Ask-mode permission requests still require human
approval; code-mode requests honor the normal denied/confirmation tool policy.
Interactive sessions and automations use the detached host route for Grok, so
their OpenSession MCP tools use the same scoped proxy as Pi models. Automation
definitions may pin a Grok account; validation rejects unknown accounts and
accounts owned by another model provider.

Grok's private ACP compatibility methods are handled at the client boundary.
`ask_user_question` uses OpenSession's durable ask flow, `exit_plan_mode` shows
the proposed plan to an interactive user, and `mcp/elicit` maps MCP form input
onto the same ask flow. The private elicitation response uses xAI's
`outcome: accept|decline|cancel` wire contract, while the standard ACP handler
uses `action: accept|decline|cancel`. Explicitly unattended runs approve leaving
plan mode but do not widen tool, MCP, publication, or credential permissions.
Unattended elicitation cancels instead of inventing an answer. Human wait time
is excluded from the inactivity watchdog. Grok's private `prompt_complete`
notification can finish a turn when the standard ACP prompt request remains
open.

## Verification

From a checkout with the corresponding source credential configured:

```sh
bun scripts/verify-acp-provider.ts grok grok/grok-4.6
bun scripts/verify-acp-provider.ts grok grok/grok-4.6 elicitation
bun scripts/verify-acp-provider.ts cursor cursor/auto
```

Each command performs a real subscription-backed turn and exits non-zero
unless the expected response reaches a terminal `done` event. Live deployment
verification must additionally create Docker-backed sessions through the
public OpenSession UI; a host-only smoke test does not prove the sandbox path.

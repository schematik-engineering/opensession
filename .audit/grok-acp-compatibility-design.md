# Grok ACP compatibility design

## Context

Open Session's ACP client implements the standard client surface but not Grok's xAI extension requests. Grok 1.0.13 therefore receives JSON-RPC method-not-found for `_x.ai/exit_plan_mode` and reports the misleading client-disconnected error seen in production. The same boundary omits private question and completion signals. Grok 1.0.13 also rejects MCP form elicitation before it reaches the ACP client; Grok 1.0.16 adds the reverse bridge.

The audit also found adjacent reliability gaps that prevent Grok 4.6 from acting as a main-model peer: Grok 1.0.13 renamed its ACP auth method, detached runs cannot rotate projected Grok accounts in one logical turn, projected quota failures do not update the central pool, follow-up ACP runs can lose Open Session MCP proxies, automation validation rejects ACP account pins, fallback destinations are Pi-only, and committed Ask answers are not acknowledged across the detached-host socket.

## Decision

Use a server-owned logical run coordinator. Each physical detached host executes exactly one model/account attempt and receives at most one account credential. The coordinator verifies a typed attempt result, updates central account health, rotates eligible Grok accounts, and only then follows the provider-neutral model fallback graph.

The implementation has these ownership boundaries:

- `grok-acp-extension.ts` parses observed xAI requests and notifications and maps them to provider-neutral outcomes.
- `AcpActivityWatchdog` in `acp-runner.ts` owns inactivity, human-blocked, and settled phases.
- `runModelFallbackWalk` and `runHostedModelAttempt` own account-before-model retry order, fallback approval, handoff, and logical recovery state.
- `runAgentHostedPhysical` owns one physical attempt and its one credential projection.
- the actor-backed Ask subsystem remains the durable human-input authority.
- the host protocol adds answer delivery IDs and ACKs so a committed answer is resent until consumed.
- the run-RPC MCP builder remains the capability authority; hosted ACP receives scoped stdio proxies rather than direct SDK servers.

## Invariants

1. A physical run and host lifetime can observe at most one model account credential.
2. Only a typed usage outcome whose attempt, model, provider, and account match the coordinator spec can mark central account health.
3. A stable logical run key owns the user turn. Physical retries are serialized, and each completed host is drained and reaped before the same key launches another attempt.
4. Fallback ownership moves atomically to the coordinator. Detached hosts never rotate accounts or models.
5. Same-provider accounts are exhausted before cross-model fallback. Strict pins never rotate.
6. Grok may be an explicit fallback source or destination; this change does not add Grok to the implicit global fallback order.
7. Known xAI spellings are parsed at one boundary. Unknown methods return MethodNotFound; invalid or session-mismatched payloads return InvalidParams.
8. `ask_user_question` never invents a headless answer. `exit_plan_mode` may be policy-auto-approved only for explicitly unattended work; tool permissions, publication policy, denied tools, and MCP allowlists remain unchanged.
9. Human wait time does not count as model inactivity. A durable ask survives browser, gateway, and host reconnects.
10. Every route that needs Open Session MCPs gets the same approved proxy names regardless of model provider.

## xAI behavior

Support the installed CLI's observed aliases for:

- `x.ai/ask_user_question` and `_x.ai/ask_user_question`
- `x.ai/exit_plan_mode` and `_x.ai/exit_plan_mode`
- `x.ai/mcp/elicit` and `_x.ai/mcp/elicit`
- `x.ai/mcp/elicit_complete` and `_x.ai/mcp/elicit_complete`
- `_x.ai/session/prompt_complete`
- usage-limit errors from the ACP request and stderr boundary

Interactive plan decisions use the existing Ask card with Approve, Request changes, and Abandon choices. The adapter returns Grok's current approved, cancelled-with-feedback, and abandoned outcomes. Grok consumes that response inside the same standard prompt turn.

Duplicate xAI question text is invalid because responses are keyed by question text. Custom answers map to `Other` plus xAI notes annotations. The adapter accepts only bounded, parsed input.

Grok 1.0.16 forwards MCP form elicitation through its private extension. That response is not the standard ACP shape: xAI expects `outcome: accept|decline|cancel`, while standard ACP expects `action: accept|decline|cancel`. Both map onto the existing durable Ask lifecycle. Unattended runs cancel rather than inventing form values.

## Recovery model

Each physical host spec carries the logical fallback and account-pin policy while the shared run journal keeps the stable turn identity. Recovery reattaches a running host or consumes its ended receipt. A matching ACP usage result updates the central pool once, then resumes account selection and model fallback under the same run key. A visible partial attempt requires a readable transcript handoff before retry.

Ask answers use delivery IDs. The gateway retains a committed result in `awaiting_ack`, resends it after reconnect, and clears it only after the host ACKs. The host resolves the provider promise once and keeps a bounded settled-delivery cache so duplicates only trigger another ACK.

## Alternatives

### Run-scoped credential lease

A single durable host could request account B after account A is exhausted. This reduces orchestration migration, but the host cumulatively observes multiple account credentials and expands the privileged mid-run staging boundary. Deleting account A before staging B does not protect against a compromised host retaining A. Rejected.

### Project all eligible accounts

This keeps rotation local but exposes the entire pool to one run and leaves central health split. Rejected.

### Keep Grok in the gateway

This preserves in-process pool access but loses detached restart survival, workload isolation, and MCP placement parity. Rejected.

### Handle only exit_plan_mode

This fixes the visible incident but leaves questions, completion, answer delivery, quota rotation, MCP parity, account pins, and fallback destination gaps. Rejected.

## Consequences

The fallback walk and physical host lifecycle must be separated without a dual-owner transition. This is a larger change than a protocol shim, but it keeps the credential boundary narrow and gives account/model recovery one authoritative state machine. A bounded transcript handoff is required when an attempt produced visible work; hosts still never open the server's actor database.

## Verification contract

Focused tests must prove exact xAI request/response schemas, current and rolling auth negotiation, unknown/invalid failure behavior, plan continuation, prompt-complete, usage-limit classification, ask-aware liveness, answer ACK replay, one-account projection, central quota propagation, Grok account rotation, strict pins, explicit Grok fallback, transcript identity, MCP parity, and automation restrictions.

The shipped production gate is: normal Grok 4.6 turn, harmless Open Session MCP call, plan approve and revise, pending Ask across a gateway reconnect, detached automation-style run, staged Grok account A-to-B rotation, and controlled Pi-to-Grok fallback. Automations remain disabled and Discord migration remains out of scope for this change.

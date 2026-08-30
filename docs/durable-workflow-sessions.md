# Durable sessions in dynamic workflows

Use `spawnSession()` when a workflow step needs a real code session with its own transcript, branch, worktree, PR, and Review UI. Existing `agent()` calls remain lightweight workflow workers.

```js
export const meta = {
  name: "stacked-layout",
  description: "Build a foundation and a dependent implementation",
};

const foundation = await spawnSession({
  prompt: "Implement the new layout protocol. Commit, push, and open a PR.",
  repo: "renderer",
  mode: "code",
  workspace: {
    type: "isolated-worktree",
    baseRef: "main",
  },
  branch: "compat/layout-protocol",
});

await waitSession(foundation.id, {
  until: "branch_pushed",
  timeout: 30 * 60_000,
});

const text = await spawnSession({
  prompt:
    "Implement Text using the new layout protocol. Commit, push, and open a PR against the foundation branch.",
  repo: "renderer",
  mode: "code",
  workspace: {
    type: "isolated-worktree",
    baseSessionId: foundation.id,
  },
  branch: "compat/text-layout",
});

const [foundationPr, textPr] = await Promise.all([
  waitSession(foundation.id, { until: "pr_opened", timeout: 45 * 60_000 }),
  waitSession(text.id, { until: "pr_opened", timeout: 45 * 60_000 }),
]);

return { foundationPr, textPr };
```

Both sessions appear beneath the workflow's parent session and in its Agents panel. The dependent session persists the existing `stackedOn` relationship, opens its PR against `compat/layout-protocol`, and uses the existing Review and GitHub stack UI. The workflow does not merge either PR.

## Session API

- `spawnSession(options)` returns `{ id, url, repo, branch, parentSessionId }` as soon as the visible child exists.
- `sessionStatus(id)` returns the child's current status, worktree, pushed-branch state, and PR.
- `waitSession(id, { until, timeout })` waits for `running`, `waiting`, `branch_pushed`, `pr_opened`, `done`, `error`, or `cancelled`. `timeout` is milliseconds.
- `sendToSession(id, message)` messages or steers a child created by this workflow.
- `cancelSession(id)` cancels a child created by this workflow.

Completed calls are journaled. Resuming a workflow replays them, while a stable create identity also covers a crash after session creation but before the journal append. Child sessions are normal durable Open Session sessions and outlive the workflow worker or gateway process that launched them.

Nested sessions inherit the parent's identity, registered repository scope, MCP allowlist, model, provider-account pin, and credential policy. Automation workflows cannot turn their restricted tool surface into an interactive code session. Children may push and open PRs, but they are explicitly prohibited from merging.

The defaults can be tightened per instance with `OPENSESSION_WORKFLOW_MAX_SESSION_DEPTH`, `OPENSESSION_WORKFLOW_MAX_ACTIVE_SESSIONS`, `OPENSESSION_WORKFLOW_MAX_SESSIONS`, `OPENSESSION_WORKFLOW_MAX_SESSION_TOKENS`, and `OPENSESSION_WORKFLOW_MAX_SESSION_COST_USD`.

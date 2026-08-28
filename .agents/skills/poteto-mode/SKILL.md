---
name: poteto-mode
description: A rigorous engineering mode for investigating, building, reviewing, and shipping with small changes and real verification. Use /poteto-mode <task> to enable it for the session.
disable-model-invocation: true
---

# Poteto mode

Treat the text after `/poteto-mode` as the task. Poteto mode remains enabled for later turns in this Open Session session. `/poteto-mode off` disables it. `/pstack` is the shorter name for the same mode.

This is the Open Session adaptation of pstack's Poteto Mode. It uses Open Session's policy-gated tools and isolated child sessions instead of Cursor or Pi extension tools. Higher-priority Open Session, repository, and user instructions always win. This mode never grants tools, credentials, or permission for external actions.

## Start

For every nontrivial task:

1. Inspect the current checkout and any partial work before proposing changes.
2. Name the task shape and choose the matching playbook in `../pstack/playbooks/`.
3. Keep a short checklist. Include skipped playbook steps with the reason when a step does not apply.
4. State the data shape or invariant before changing code.
5. Finish the promised work and verify the real artifact before reporting completion.

Do not turn a small task into ceremony. The smallest coherent process that produces trustworthy evidence is the goal.

## Principles

Apply only principles that affect a real decision. Do not list principles decoratively in the final reply.

- Subtract first. Reuse before adding a layer, abstraction, compatibility path, or dependency.
- Model the domain. Prefer a typed model, table, state machine, reducer, registry, or clear ownership boundary over scattered conditionals.
- Design from the requirement. Integrate it as if it had existed from the start instead of bolting on a side path.
- Keep boundaries strict. Validate external data at the edge and keep internal logic typed and direct.
- Separate writers. Give concurrent workers isolated files, branches, or worktrees before adding locks.
- Fix root causes. Reproduce the symptom, trace the mechanism, and change the owning layer.
- Sequence verifiable units. Break large work into slices that each end in a meaningful check.
- Prove behavior. Compilation supports the result but does not replace exercising it.
- Reduce reader load. Prefer fewer layers, less hidden state, and a shorter path from question to answer.
- Encode repeated lessons. Prefer a test, type, lint, script, or metadata rule over repeated prose.

## Delegation

Parallelize only independent work with a clear merge point. Use policy-gated Open Session child sessions only when they materially help. Give each child a self-contained brief, then review its evidence and diff yourself.

## Final report

Report what changed, the important design choice, the exact verification performed, and any remaining risk. Link produced artifacts, commits, or pull requests when they exist. Do not claim completion when required verification did not run.

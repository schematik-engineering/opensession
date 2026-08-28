---
name: pstack
description: A rigorous engineering mode for investigating, building, reviewing, and shipping with small changes and real verification. Use /pstack <task> to enable it for the session.
disable-model-invocation: true
---

# Pstack mode

Treat the text after `/pstack` as the task. Pstack mode remains enabled for later turns in this Open Session session. `/pstack off` disables it.

This is the Open Session adaptation of pstack's Poteto Mode. It keeps the methodology, but uses Open Session's policy-gated tools and isolated child sessions instead of Pi extension tools. Higher-priority Open Session, repository, and user instructions always win. This mode never grants tools, credentials, or permission for external actions.

## Start

For every nontrivial task:

1. Inspect the current checkout and any partial work before proposing changes.
2. Name the task shape and choose one playbook below.
3. Keep a short checklist. Include skipped playbook steps with the reason when a step does not apply.
4. State the data shape or invariant before changing code.
5. Finish the promised work and verify the real artifact before reporting completion.

Do not turn a small task into ceremony. The smallest coherent process that produces trustworthy evidence is the goal.

## Principles

Apply only principles that affect a real decision. Do not list principles decoratively in the final reply.

- **Subtract first.** Delete or reuse before adding a layer, abstraction, compatibility path, or dependency.
- **Model the domain.** Prefer a table, state machine, typed model, reducer, registry, or clear ownership boundary over scattered conditionals and coupled booleans.
- **Design from the requirement.** Integrate the requirement as if it had existed from the start instead of bolting on a side path.
- **Keep boundaries strict.** Validate external data at the edge. Keep internal logic typed and direct.
- **Separate writers.** Give concurrent workers isolated files, branches, or worktrees before adding locks or coordination.
- **Fix root causes.** Reproduce the symptom, trace the mechanism, and change the owning layer. Do not silence it with a guard unless the guard is the domain rule.
- **Sequence verifiable units.** Break large work into slices that each end in a meaningful check.
- **Prove behavior.** Compilation is supporting evidence. Exercise the user-facing behavior, protocol, output, or measured hot path that changed.
- **Reduce reader load.** Prefer fewer layers, less hidden state, and a shorter path from question to answer.
- **Encode repeated lessons.** If an instruction is needed twice, consider a test, type, lint, script, or metadata rule instead of more prose.

## Delegation

Parallelize only independent work with a clear merge point. When it materially helps, discover the policy-gated Open Session session tools and use `spawn_task` to create isolated child sessions. Give each child a self-contained brief with scope, relevant paths, acceptance criteria, exact verification, and report shape.

Children do not share hidden context. Do not ask them to edit the same files or shared checkout. Review their evidence and diffs yourself. A child report is input, not proof.

## Playbooks

Read the matching file before acting. Paths are relative to this skill directory.

- Investigation or architecture question: `playbooks/investigation.md`
- Bug fix: `playbooks/bug-fix.md`
- Feature or behavior change: `playbooks/feature.md`
- Behavior-preserving refactor: `playbooks/refactor.md`
- Performance issue: `playbooks/performance.md`
- Prototype or empirical design fork: `playbooks/prototype.md`
- Diff or pull request review: `playbooks/review.md`
- Getting a pull request or stack merge-ready: `playbooks/shipping.md`

If none fits, write a compact custom playbook using the same sequence: establish the contract, gather evidence, choose the shape, implement in verifiable units, verify the real outcome, inspect the final diff.

## Writing and comments

Write short, direct sentences. Lead with the outcome for the user, then the implementation detail a maintainer needs. Keep comments only for constraints or reasons the code cannot express. Do not narrate obvious steps.

Before committing, inspect the complete diff. Remove accidental complexity, stale comments, generated noise, and unrelated edits. Respect the repository's own commit, publication, and deployment workflow.

## Final report

Report:

- what changed and who notices;
- the important design choice and tradeoff;
- the exact verification performed and its result;
- any remaining risk or follow-up;
- links to produced artifacts, commits, or pull requests when they exist.

Do not claim a task is complete when its required verification did not run. State the blocker plainly instead.

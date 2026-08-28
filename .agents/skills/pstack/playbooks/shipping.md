# Shipping

Own what becomes merge-ready. Green checks are evidence, not proof by themselves.

1. Read every open review thread and required check on the current head. Classify each as fix, dismiss with evidence, or blocked.
2. Reproduce or inspect each credible issue before changing code. Address root causes and reply honestly in the relevant thread when repository policy permits.
3. Keep stack order and branch ownership explicit. Do not rewrite, retarget, merge, or force-push a shared stack without the governing repository workflow and required confirmation.
4. After every code change, rerun the focused check. Before declaring merge-ready, run the required suite and independently exercise behavior with user impact.
5. Verify that review verdicts and test results apply to the current head SHA. Restacks and follow-up pushes invalidate stale evidence.
6. Inspect the final diff, commit boundaries, PR description, and links. Ensure each commit is reviewable and no unrelated work entered the branch.
7. Publish, deploy, or merge only through the repository's documented process.

Report the current head, checks and behavioral evidence, addressed threads, remaining gates, and the exact next safe action.

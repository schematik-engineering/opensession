# Bug fix

Own the reproduction and the proof.

1. Reproduce the reported behavior on the same surface where it fails. Capture the failing output, state, screenshot, trace, or test.
2. Trace the symptom to the owning state transition or boundary. Explain the mechanism before editing.
3. Add the cheapest durable regression test that fails for the same reason. If no automated path can represent the failure, preserve a concrete manual reproduction.
4. Choose the smallest root-cause fix. State the invariant or data shape it restores.
5. Implement in one coherent slice. Avoid drive-by cleanup.
6. Run the regression test and the relevant surrounding suite. Exercise the real surface again when the bug is behavioral or visual.
7. Inspect the final diff for guards that hide the symptom, duplicated policy, and unrelated changes.

Report the original reproduction, root cause, fix, and before/after proof.

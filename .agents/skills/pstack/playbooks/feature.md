# Feature

Own the behavior from contract to proof.

1. Define the user-visible outcome and acceptance criteria. Name the authoritative data shape and its owner.
2. Inspect the closest existing behavior and reuse its path. Identify protocol, persistence, security, and client boundaries that the feature crosses.
3. For a novel or contested design, compare two small shapes or prototypes before committing. Otherwise choose the simplest shape that fits the existing architecture.
4. Write a short implementation sequence. Each slice must end in a meaningful check. Delegate only independent slices with exclusive ownership.
5. Implement the smallest complete vertical path. Do not add compatibility branches without a real compatibility requirement.
6. Test boundary parsing and state transitions. Then exercise the shipped user-facing behavior on every affected client or width required by repository policy.
7. Inspect the final diff for duplicated state, hidden coupling, copy drift, and dead paths.

Report who notices, the chosen shape, what was deliberately left out, and the real verification evidence.

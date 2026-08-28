# Investigation

Own the answer. Do not modify source unless the user also asked for a fix.

1. Restate the exact question and what evidence would settle it.
2. Read the narrow owning code path, its callers, types, tests, and relevant history. Search by concrete symbols and error text instead of scanning the repository.
3. When independent evidence streams exist, delegate bounded slices such as source, history, and runtime behavior. Keep the final judgment in this session.
4. Trace one representative input through the real data flow. Distinguish observed facts from inference.
5. Try to falsify the leading explanation with a focused test, query, or runtime observation.
6. Return the answer with source locations and the smallest useful next action. If evidence is incomplete, name what is missing.

Do not build speculative scaffolding for a read-only answer.

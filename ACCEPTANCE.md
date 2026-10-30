# Acceptance

Checked 2026-10-30 on Node 22.23.4, Linux. Fixture runs only. "Not run" means not run, not passed.

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | A saved item is used in a new session after a process restart | Passed | test `a preference saved in one process is used by a new process on the same database file` (spawns `src/cli/serve.ts` twice, different pids, old token refused, new login); demo step 2 |
| 2 | A correction replaces the active value; a deletion stops affecting new answers | Passed | tests `a correction replaces the active value...`, `a correction changes the next answer; a deletion stops affecting new answers`, `delete removes the item from reads and erases every stored value`, `/forget deletes by key`; demo steps 3 and 4 |
| 3 | Two test users cannot read or change each other's items through the API | Passed. Cross-user read, update and delete all return **404** (same as a non-existent id, see DECISIONS.md); a user id in the body returns **400 IDENTITY_IN_BODY**; no or bad token returns **401** | tests in `test/access.test.ts`; demo step 6 |
| 4 | Instructions in a document do not become user preferences without an intended user action | Passed | tests in `test/injection.test.ts`, including a deliberately gullible model whose write attempts fail with `UNKNOWN_TOOL`; demo step 5 |
| 5 | The run log shows that information was read from storage | Passed | `memory_read` events with item id, key, value and version in `evidence/fixture-2026-10-30.jsonl`; test `saved preferences shape the reply, and the run log shows the memory read` |
| 6 | The same flow with a real model | **Not run.** No API key in the build environment. | `make live` writes `evidence/live-*.jsonl` |

Extra checks beyond the plan: forged token payload, expired token, token from a previous process, query-string owner ignored, conversation history scoped per owner, invalid values refused, same key for two users stays independent.

## Open gaps

- No live model run, so nothing here shows how a real model follows saved preferences or treats an injected document. The write path is closed to the model regardless.
- Authentication is test-grade by design (see DECISIONS.md).
- Not yet run by a second person.

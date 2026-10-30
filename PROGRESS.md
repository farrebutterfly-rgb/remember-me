# Progress

## 2026-10-30, session 1

Done: SQLite schema with separate history and memory, owner-scoped memory store with versioned corrections and value-erasing delete, test HMAC auth with two seeded users, HTTP API, `/remember` and `/forget` chat commands, assistant loop with read-only memory tool, scripted fixture assistant (en, sv, fr; bullets, table), process-restart test and demo, 27 tests, docs.

Not done: live run (needs `ANTHROPIC_API_KEY`). Not yet run by a second person.

Next: a live run with `make live` and a comparison of how a real model follows the saved preferences and treats the injected document; then an exercise where the user adds a third known key end to end.

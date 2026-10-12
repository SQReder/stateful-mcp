# Changelog

## [Unreleased]

### Added
- Add `candidate_apply`: write one approved, current-revision candidate into a clean Git workspace and typecheck it with the workspace `tsc` and a trusted `WORKER_TSCONFIG` that must include the target.
- Restore the target after a failed typecheck only when nobody else changed it; report `conflict` otherwise, and recover interrupted applies on restart without replaying validation.
- Add immutable full-file test candidates with generation-time base snapshots and unified replacement diffs, plus `candidate_read`.
- Add `candidate_review` with append-only review history; approval is bound to one candidate on the current context revision.
- Feed the latest candidate and, when it was rejected, its findings into the next `worker_chat`; invalid artifacts, including those over 32000 bytes, keep the raw reply and return diagnostics instead of a candidate.
- Add durable sessions, explicit source snapshots and one-turn chat using current context and the last successful exchange.
- Gate inference with a declared conservative input estimate, path checks and per-session busy state; recover interrupted turns without replay.
- Add compact status with opt-in full details and exclusive built-in SQLite storage.
- Add an I0 stdio MCP server with configuration diagnostics and a single text-only OpenAI-compatible chat request.
- Validate tool arguments and backend responses; report sanitized timeout, connection and HTTP failures without retrying.
- Add fake-backend contract tests, MCP transport checks and an opt-in live smoke command.

### Changed
- Preserve Git hooks in the planned raw-commit workflow; defer modifying-hook compatibility to I4.

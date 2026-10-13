# Changelog

## [Unreleased]

### Added
- Add `postprocess`: run trusted `WORKER_POSTPROCESS` tools (prettier, eslint) only on raw-commit paths directly on top of the raw commit, re-typecheck and commit the changes separately; failures return files to the raw commit, which always stays.
- Commit a validated candidate as one local raw commit with Git hooks enabled; report hook changes as `hooksModified` with a diff after a repeated typecheck, and keep any created commit in history instead of resetting it.
- Add `candidate_apply`: write one approved, current-revision candidate into a clean Git workspace and typecheck it with the workspace `tsc` and a trusted `WORKER_TSCONFIG` that must include the target.
- Restore the target after a failed typecheck only when nobody else changed it; report `conflict` otherwise, and recover interrupted applies on restart without replaying validation.
- Add immutable full-file test candidates with generation-time base snapshots and unified replacement diffs, plus `candidate_read`.
- Add `candidate_review` with append-only review history; approval is bound to one candidate on the current context revision.
- Feed the latest candidate and, when it was rejected, its findings into the next `worker_chat`; invalid artifacts, including those over 192000 bytes, keep the raw reply and return diagnostics instead of a candidate.
- Return a new candidate's code from `worker_chat` as `artifact`, so review needs no extra `candidate_read`.
- Require the agreed scenario list as non-empty `acceptanceCriteria` in `context_set`; the worker implements exactly that list.
- Add durable sessions, explicit source snapshots and one-turn chat using current context and the last successful exchange.
- Gate inference with a declared conservative input estimate (64K-token input budget of the 96K window, UTF-8 bytes / 3 + 256), path checks and per-session busy state; recover interrupted turns without replay.
- Add compact status with opt-in full details and exclusive built-in SQLite storage.
- Add an I0 stdio MCP server with configuration diagnostics and a single text-only OpenAI-compatible chat request.
- Validate tool arguments and backend responses; report sanitized timeout, connection and HTTP failures without retrying.
- Add fake-backend contract tests, MCP transport checks and an opt-in live smoke command.

### Changed
- Run postprocess tools only where package.json of the package or a parent declares them, skipping undeclared ones (`tool_skipped`); `WORKER_POSTPROCESS` is optional and defaults to `eslint,prettier`.
- Let the orchestrator choose the package tsconfig in `candidate_apply` (`tsconfig`, default `WORKER_TSCONFIG`) and the package directory in `postprocess` (`packageDir`, default the tsconfig's directory) for monorepos; `tsc`, prettier and eslint resolve from that package and the tools run there.
- Derive the workspace root at startup from the Git repository of the MCP process's working directory instead of `WORKER_WORKSPACE_ROOT`; `worker_diagnostics` reports it.
- Preserve Git hooks in the planned raw-commit workflow; defer modifying-hook compatibility to I4.

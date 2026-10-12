# TODO

## I0 — connectivity mechanics (accepted by user, 2026-10-13)

- [x] Build the TypeScript stdio MCP skeleton and trusted environment configuration.
- [x] Verify fake-backend error handling and MCP discovery/calls (`npm test`: 17 passed).
- [x] Verify TypeScript (`npm run typecheck`).
- [x] Verify live inference through MCP stdio with TLS enabled (`gpt-6-luna`, `npm run smoke:live`).
- [x] Verify real discovery/calls and key delivery in corporate Kilo (user-reported results, 2026-10-13; `qwen2-5-coder-32b-instruct-awq`; diagnostics configured and instruct returned `READY`).

## I1 — durable local sessions

- [x] Persist brief, snapshots, hashes, revisions, full turns and sanitized errors in built-in SQLite.
- [x] Verify context replacement, session isolation, budget rejection, path boundaries, exclusive storage and crash recovery (`node --test tests/sessions.test.mjs tests/mcp.test.mjs`: 10 affected tests passed after review fixes).
- [x] Verify three live MCP turns with `gpt-6-luna`, revision 2, restart and unchanged source files.
- [x] Complete independent review of I1; fix external storage override and snapshot path-race findings with regression tests.

## I2 — candidates and review loop (local mechanics)

- [x] Store immutable candidates (content, generation-time base, full-replacement diff, revision) and append-only review history.
- [x] Reject invalid, wrong-path or blank artifacts without creating a candidate; keep the raw reply and return diagnostics.
- [x] Bind approval to a candidate on the current revision; refuse stale and previously rejected candidates.
- [x] Feed the latest candidate once and, when it was rejected, its findings into the next `worker_chat`.
- [x] Verify locally (`npm test`: 30 passed after review fixes; live MCP reject → feedback → approve loop on `gpt-6-luna` with restart, source and target unchanged; ad-hoc script, `npm run smoke:live` covers only I0).
- [x] Complete the independent I2 review; stop pairing the latest code with findings for an older version and report `needs_revision` after a reject.
- [ ] Known minor gaps from the review, deferred: `session_status` details show raw `approved` for stale candidates (`candidate_read` reports `stale`); when the last reply produced no candidate, the prompt omits that reply while a candidate exists.
- [ ] Run the review loop from corporate Kilo with Qwen3.6 reviewing real code and diff, without copying between chats (developer with corporate Kilo).

## I3 — safe apply and validation loop (local mechanics)

- [x] Add `candidate_apply` with approval, revision, clean Git, context and base checks before any write.
- [x] Typecheck with the workspace `tsc` and trusted `WORKER_TSCONFIG`; require the target in `--listFilesOnly`; validation writes no files.
- [x] Restore only an unmodified target after failure; report `conflict` otherwise; journal phases and recover after a crash without replay.
- [x] Complete the independent I3 review; reject artifacts over 32000 bytes, keep candidates reusable after a tsc timeout, strip the key from child env under any spelling.
- [x] Verify locally (`npm test`: 37 passed, real `tsc` 7.0.2 in disposable Git repos).
- [ ] Run apply/validation from corporate Kilo on a real pilot module with its own test tsconfig (developer with corporate Kilo).
- [ ] Known limits: compare-then-write restore race; `typescript` may resolve from a hoisted `node_modules` outside the workspace; untested timeout branch (needs a configurable timeout or fake compiler).

## I4 — raw commit and postprocess

- [x] Commit the validated target alone with hooks enabled and a candidate trailer; verify scope and committed content; re-typecheck when hooks changed the file (user decision, 2026-10-13).
- [x] Keep any commit made after the pre-apply HEAD on failures and crashes; never reset, amend or push.
- [x] Complete the independent review of the raw commit and fix confirmed findings (`npm test`: 41 passed).
- [x] Implement `postprocess`: trusted Prettier/ESLint fix only on raw-commit paths, re-typecheck, separate commit or `no_changes`.
- [x] Complete the independent review of `postprocess`; capture commit SHAs right after `git commit` and refuse foreign raw commits (`npm test`: 50 passed).
- [ ] Verify `postprocess` with real Prettier and ESLint on a pilot project (tests use fake CLIs; `--` handling and ignore patterns are unverified).
- [ ] Untested branch: git exits non-zero after creating the commit (needs a reliable way to kill git after the commit in tests).

## Contract updates (user decisions, 2026-10-13)

- [x] Require the agreed scenario list in `context_set` `acceptanceCriteria`; the worker prompt asks to implement exactly that list; the role sends it before generation.
- [x] Return a new candidate's code from `worker_chat` (`artifact`) instead of the raw JSON reply; `candidate_read` stays for diffs, history and restarts.
- [x] Input budget 64K tokens of the 96K window, estimated as UTF-8 bytes / 3 + 256; files and candidates up to 192000 bytes.

## Deployment/pilot checks

- [ ] Verify target Qwen3-Next access, tokenizer/window and quality in the corporate environment; does not block local I1 by user decision.
- [ ] Verify role loading and actual permissions in corporate Kilo (developer with corporate Kilo).

## Later gates

- [x] Begin I1 locally with `gpt-6-luna` after the user's scope decision.
- [x] Before I4, decide how to preserve raw generated code when repository hooks modify files; never bypass hooks (re-typecheck and report `hooksModified`).
- [ ] Follow I1–I6 in `IMPLEMENTATION_PLAN.md`; do not add stateful features to I0.

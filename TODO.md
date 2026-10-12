# TODO

## I0 — connectivity gate (open)

- [x] Build the TypeScript stdio MCP skeleton and trusted environment configuration.
- [x] Verify fake-backend error handling and MCP discovery/calls (`npm test`: 17 passed).
- [x] Verify TypeScript (`npm run typecheck`).
- [x] Verify live inference through MCP stdio with TLS enabled (`gpt-6-luna`, `npm run smoke:live`).
- [ ] Verify real discovery/calls and key delivery in corporate Kilo; configuration and custom-mode formats follow upstream (developer with corporate Kilo).
- [ ] Verify the target Qwen3-Next model through the authorized endpoint (developer with target model access).

## Later gates

- [ ] Begin I1 only after I0 CONNECTED is confirmed.
- [ ] Before I4, decide how to preserve raw generated code when repository hooks modify files; never bypass hooks.
- [ ] Follow I1–I6 in `IMPLEMENTATION_PLAN.md`; do not add stateful features to I0.

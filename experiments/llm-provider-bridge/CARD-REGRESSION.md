# Real-model resource-card regression

Run from the repository root after preparing the Node-compatible SQLite binding:

```sh
node scripts/ensure-node-better-sqlite3.mjs
node experiments/llm-provider-bridge/card-regression.mjs
```

This is opt-in and incurs real model usage. It uses the existing local OpenCode
service registration and the production completion gateway, contact Agent,
resource tools, persistence and result-only handoff phase. It does not inject
proposed tool calls or ask the model to send a card in the positive scenarios.

Worker Session APIs and scheduled-task storage are isolated fixtures. Each case
gets its own temporary SQLite database, Bot, project and skill home. Production
inference receives only synthetic test conversations. Real Session APIs are
forbidden on the inference client. Existing Bots, scheduled tasks, project
registration and global configuration are not changed. Temporary fixtures are
removed after each case; the shared inference bridge retains its normal lifecycle.

The matrix checks new/continued sessions, listen-only watch, Bot creation,
daily/weekly/cron task creation, task edits/pause, conversation lookup, listing
multiple tasks, explicit no-card requests and failed assignment. Success requires
the real requested operation, the expected persisted cards, explicit reference
calls, and no duplicate resource mutation. Lookups/watches must not prompt workers;
task listing must not create or modify tasks.

Environment controls:

- `CARD_TEST_MODELS`: comma-separated connected `provider/model` references.
  Defaults to `openai/gpt-6.1-sol,magpie-astra/deepseek-v4.1-flash`.
- `CARD_TEST_CASES`: comma-separated scenario IDs from the script; omitted runs all.
- `CARD_TEST_REPEATS`: 1–5 independent runs per selected case/model, default 1.
- `YURI_TEST_TMPDIR`: existing directory for disposable fixture directories.
- `CARD_TEST_REPORT`: optional JSON report destination. Reports contain only case
  IDs, model IDs, tool names, counts, timings and bounded error categories, not
  credentials or generated conversation bodies.

Each case has a three-minute cancellation budget and an 18-completion bound.
Models run independently in parallel, with cases sequential within a model.
Any failed case yields a non-zero exit code; there is no account/model fallback.

This verifies bounded model decision quality and backend persistence, not real
worker execution, scheduler firing, external messaging-channel delivery or device
UI rendering. Deterministic failure/restart/transport checks remain in the owning
Vitest suites.

## Regressions captured

- Failed assignment on DeepSeek returned HTTP 400 when a tools-disabled summary
  retained native tool-call history without definitions. The summary now receives
  labeled, quoted operation evidence; it cannot retry mutations. The deterministic
  harness test covers the request shape and the real-model failure case checks
  that the turn completes without a card or a second creation attempt.
- OpenAI conversation lookup sometimes supplied `projectID` alongside `sessionID`.
  The shared schema allowed it, but execution rejected it and lost the card. Session
  references now accept well-formed redundant project context and discard it before
  authoritative resolution. Unit and SQLite integration tests cover publication
  with this argument and preserve rejection of forbidden sessions and forged card
  fields. A three-repeat real-model lookup run passed after the fix.

## Verified run (2026-11-04)

After both fixes, the complete default matrix passed **26/26**: 13 scenarios each
on `openai/gpt-6.1-sol` and `magpie-astra/deepseek-v4.1-flash`. All positive cases
published the expected persisted cards without an explicit user request for cards;
no-card and failed-assignment cases published none. Conversation continuation
reused its worker, and lookup/watch/task-listing cases did not prompt workers or
mutate tasks. The separate OpenAI lookup repetition passed 3/3.

Related deterministic checks passed: 933 Assistant/scheduler/family-gate tests
(3 skipped), 69 inference-gateway tests, and 107 UI card/DTO/routing/scroll tests.
Web type-check passed. The dead-code scan completed with repository-wide findings;
it was not a clean scan. These results have the isolation and runtime limits
described above; they are not a full workspace or device acceptance run.

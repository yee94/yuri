# Real Host acceptance

```sh
node packages/nsh/tests/live/run.mjs
```

This opt-in test uses the running loopback Yuri Host (default `127.0.0.1:57123`)
and an existing authorized desktop credential read into memory from settings.
It creates a new isolated session in the current worktree using configured
`openai/gpt-6.1-sol`. It does not alter existing sessions, global configuration,
passwords or running services. One short real model turn incurs provider usage.
The generated prompt asks for short text and the harmless `printf NSH_LIVE_TOOL_OK`
tool call, followed by a new-session-only native `/goal clear` command.

Environment overrides: `NSH_LIVE_ORIGIN` (loopback only), `NSH_LIVE_SETTINGS`
(settings path), `NSH_LIVE_PROVIDER`, `NSH_LIVE_MODEL`. Never put credentials in
arguments or these variables. No credentials, model configuration, existing user
messages or raw tool results are saved. `.scratch/nsh-live/<sessionID>.json`
contains only origin/version/model/session IDs, event/data key shapes, times,
content lengths, tool names/status and request counts.

The same real HTTP requests back the NSH state module's `runtime.request` boundary;
real Host SSE is forwarded using Swift's `{ key: 'chat', data: JSON.stringify(event) }`
shape. Assertions require direct content growth without a history GET, native
tool success, execution success, idle state and identical reopened text. The
test is not a UIKit or physical-device rendering test, and does not prove Relay.
The command assertion expects `/goal clear` to fail with HTTP 500 on this new
session because it has no goal; it checks that exactly one command POST occurs,
no duplicate prompt is sent, and the failed command draft remains available.

## Native state interfaces

- `chat.messages()` retains its existing shape and now updates from native
  `session.text.*`, `session.reasoning.*`, `session.tool.*` and `session.step.*`.
  `message.content` preserves ordered native part identity and per-kind ordinals.
  Output is coalesced at 32ms; token events perform no history GETs.
- `chat.retry()` is the current native retry payload or null. Completion or
  resumed output clears it. `busy()` remains live execution authority.
- `chat.executionError()` retains a live execution failure even if no assistant
  row exists yet; it also appears through existing `chat.error()` and is cleared
  by the next execution start/success rather than a successful empty GET.
- `chat.streamState()` is `inactive | connecting | live | disconnected`.
- `await chat.loadCommands()` refreshes `chat.commands()` from the scoped native
  catalog. Picker items use `name` and `description` from those rows.
- `await chat.command(name, args)` places the command in the draft and calls send;
  `send()` also recognizes a slash command in the draft. Both validate the live
  catalog, then POST `{ name, text, delivery, files? }` to native `/command`, never
  a second `/prompt`. Unregistered commands (including `/explore` on the tested
  Host) remain in the draft with an error rather than becoming ordinary prompts.
- Native command responses are 204 and accept **no caller id**. An ambiguous
  command response therefore remains in `pendingSend()` and `retrySend()` must
  **not** retransmit it. The UI should show the uncertainty and let the user check
  authoritative state; it cannot promise prompt-style exactly-once retries.
  Ordinary prompts retain their existing stable message id and reconciliation.

History reconciliation still occurs on initial open, admission, terminal receipt,
reconnect, explicit reload and safety polling. During a healthy busy stream the
4-second safety poll reads status/inbox/forms/permissions, not a whole text page.
Late HTTP results cannot overwrite deltas received after that read began. Hidden
or background chats stop streams/polling and reconcile on foreground activation.

# WeChat text channel

This Host-owned channel connects a QR-authorized personal WeChat account to one
existing Yuri Bot. It uses Tencent's public `openclaw-weixin` iLink wire reference,
not WorkBuddy OAuth/private proxy APIs, personal-WeChat hooks or the WeChat customer
service protocol. No OpenClaw runtime or new dependency is installed.

## Ownership and UI

- `api.js`: fixed HTTPS origin, official-host validation for QR redirects, bounded
  JSON decoding, lossless uint64 message IDs, separate HTTP/business errors.
- `store.js`: private SQLite binding, platform cursor, incoming dedup receipts,
  ordered outgoing deliveries and process-owner lease.
- `runtime.js`: QR lifecycle, owner-only admission, bounded output reconciliation,
  retry/ambiguity and shutdown. `routes.js` exposes authenticated settings only.
- `typing.js`: optional per-binding live typing state, ticket lifetime, bounded
  refresh/backoff and serialized cancellation; no persisted presence or UI state.
- `assistants/service.channelPage()` is an internal bounded, ascending durable
  output seam. It validates the Bot and uses the contact-store generation. It does
  not expose credentials or replace the contact execution engine.
- Shared `AssistantChannelsGroup` appears last in each **saved** Bot's settings,
  after scheduled tasks. One labelled **Message channels** group owns its card;
  WeChat is its first channel. It is not a global setting or one search entry per
  dynamic Bot. Web, desktop, hosted mobile and Capacitor configure the active Host
  through `runtimeFetch`; standalone VS Code explicitly returns 501.

## Authorization and persistence

The QR-confirmed `ilink_user_id` is the only accepted sender. Group messages,
other senders and messages without a stable platform ID never invoke tools. Each
bound account maps to exactly one Bot within the Host data directory. The account
can use that Bot's existing tools and Host permissions; the UI discloses this before
scanning. This is not a separate remote-execution sandbox.

Bindings live under `<yuriDataDir>/weixin/channel.sqlite`. The directory is 0700
and database is 0600, with SQLite secure-delete enabled. Tokens are **not encrypted
at rest**; the host OS user must protect its data directory/backups (on Windows,
OS ACLs remain necessary). They never enter settings/snapshot DTOs, transcript,
model context, URLs, logs or config sync. QR/verification data stays in memory;
route responses use `Cache-Control: no-store`, UI Query caches have zero GC retention,
and QR images are generated locally rather than sent to an external image service.

Disconnect aborts local receiving/sending, fences late completions and deletes
local credentials and pending deliveries; it does not erase Bot history or cancel
already admitted work. The public reference has no general server-side token
revocation API, so this is not a promise to revoke the platform's authorization.
Deleting a Bot also forgets its local connection. Failed revision-checked Bot
deletion leaves the connection intact.

## Delivery semantics

Incoming receipt, reply context and platform cursor commit together before calling
`service.send()`. Namespaced IDs keep admission idempotent across duplicates and
restarts. Incoming and outgoing work is separate from the long-poll receiver; pending
plus admitted receipt count applies backpressure at 100, with 20 admissions per pass.
Each active account has one receiver and one outbound scheduler. The process lease
renews every 2 seconds and expires after 60 seconds; another process sharing this
data directory cannot steal a live account. After any network wait, epoch/lease
checks fence stale writes. Cross-machine copies of credentials/data are unsupported.

Binding starts at the current contact tip, so existing history/greetings are not
sent. Subsequent **public assistant replies**, including App-initiated and background
task replies, sync to the paired owner. Plain text is sent as text; current cards
become title/name text, not interactive WeChat cards or deeplinks. Internal settle
markers are omitted and failures use a safe generic message, never raw tool errors.
Media input gets a text-only explanation and never invokes tools. Generation reset
drops queued output from the previous transcript. An already submitted HTTP request
cannot be recalled, including during disconnect/reset.

Replies are split by Unicode code points into at most 3500-character segments;
stable client IDs and ordered outbox rows survive restart. This is not a server-side
exactly-once guarantee. An uncertain HTTP result is marked **delivery unknown** and
blocks later output until the owner explicitly retries. New inbound context may
unblock a known rejected reply but never automatically retries an unknown send.
Authentication expiry stays expired until new authorization; receiver network errors
retry with 1–30 second capped backoff. Users can manually retry other blocked sends.
The platform's reply-context lifetime and active-push quota are not specified here.

Contact execution itself remains process-local. A crash with an admitted request
does **not** rerun tools; recovery sends an interruption/check-status notice. A crash
between contact completion and receipt acknowledgement can conservatively produce
that notice even if some output committed. Completed receipts keep only IDs/states;
sent outbox rows clear text. Dedup metadata is retained for the binding lifetime and
removed on disconnect. There is no autonomous contact-run recovery.

Shutdown awaits channel operations before closing assistant storage. UI polling is
limited to the mounted selected Bot (2s QR, 15s connected, no background polling),
not the composer or global Bot catalog. QR generation reruns only for changed QR
content and stale runtime mutations cannot overwrite a new Host's cache.

## Protocol and verification limits

### Typing presence

Only live `yuri:contact-turn-start/end` events drive typing, including App-initiated
or background contact turns whose public replies also sync to WeChat. Binding or
restarting does not infer activity from persisted receipts/history, and historical
end events or streaming deltas never start an indicator. A turn already running
before binding is not backfilled. Overlapping live turn IDs share one indicator;
the last completion, error or cancellation stops it.

The Host obtains a per-user `typing_ticket` through `getconfig`, then calls
`sendtyping` with status 1 to start/refresh and 2 to cancel. This is native protocol
presence, not a placeholder text message. Successful tickets stay only in memory
for at most 24 hours, scoped to the binding epoch and paired peer. A refresh reads
the latest conversation context. Idle bindings make no typing requests. Each
active binding has at most one serial typing loop, with one refresh per 8 seconds
after the preceding request; token deltas and duplicate starts add no requests.
The cadence and cache duration are Yuri client policy, not a guarantee of WeChat's
indicator TTL. Missing/rejected tickets and request failures retry with 2–60 second
capped backoff while the live turn remains active.

Typing requests have a 5-second deadline and never block admission or text delivery.
The end event aborts a pending start/refresh, fences late configuration results and
serializes a best-effort cancellation before the next turn's start. Cancellation
uses its own deadline, not the already aborted start signal. Disconnect/deletion
retires the binding before awaiting cancellation and removing credentials; shutdown
also awaits cancellation before closing storage/releasing the process lease. A
lost lease or changed epoch cannot send/cancel presence for another owner. Tickets
and transient turn tracking are discarded on unbind, expiry or ownership loss.
Optional presence failures are not surfaced as a broken text channel. Process death
or a failed cancel cannot guarantee immediate removal in the WeChat client.

### QR profile fields

The public QR request sends `bot_type` and `local_token_list`; neither its request
nor confirmation flow exposes nickname/avatar configuration. Do not append guessed
profile fields or alter QR payloads to claim that WeChat adopts the Yuri Bot's
profile. `base_info.bot_agent` is observability metadata, not the contact name or
avatar. There is no public profile-update endpoint in this protocol reference.

Reference: https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
(protocol baseline 2.4.10; `bot_agent: Yuri`). Public source availability does not
establish third-party product admission, all-account availability, service SLA,
unlimited proactive notifications or arbitrary rich-card support.

Focused tests cover wire behavior, business errors, QR fencing, owner isolation,
dedup, restart, conflicting bindings, process lease, shutdown, generation changes,
unknown delivery, HTTP protection, typing cadence/cancellation/stale completions,
and real contact-pipeline execution with a fake WeChat service. Real-account
QR/verification, phone-visible delivery and typing presentation still require
manual testing; mocks and builds are not evidence of platform acceptance.

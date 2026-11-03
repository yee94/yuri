# WeChat message channel

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
- `chat-adapter.js`: the Chat SDK `Adapter` extension for personal-WeChat Bot.
  Standard `Message`, thread identity, owner-only `openDM`, normalization and
  `postMessage` are used by the running channel, not a separate demonstration path.
  iLink-specific `poll`/`receipt` extensions preserve atomic cursor/receipt commits
  and existing stable delivery IDs. Credentials and media capabilities remain in
  private closures/receipts, not serialized Chat messages. Unsupported operations
  throw `NotImplementedError`; HTTP webhook handling explicitly returns 501.
- `typing.js`: optional per-binding live typing state, ticket lifetime, bounded
  refresh/backoff and serialized cancellation; no persisted presence or UI state.
- `inbound.js`: bounded inbound content projection, private media references,
  partial-success attachment admission and TOON model/transcript context.
- `media.js`: deadline/byte-bounded official CDN downloads, AES-128-ECB decoding
  and MIME identification; no arbitrary URL fetch or credential forwarding.
- `toon.js`: local JSON-only TOON encoder (objects, lists, primitive/tabular
  arrays); no new dependency, key folding, raw-string emission or decoding API.
- `assistants/service.channelPage()` is an internal bounded, ascending durable
  output seam. It validates the Bot and uses the contact-store generation. It does
  not expose credentials or replace the contact execution engine.
- Shared `AssistantChannelsGroup` appears last in each **saved** Bot's settings,
  after scheduled tasks. One labelled **Message channels** group owns its card;
  WeChat, WeCom, Feishu and DingTalk form a 2×2 set of colored brand entries;
  configuration (including WeChat QR/verification/rebind) opens in a dialog.
  It is not a global setting or one search entry per
  dynamic Bot. Web, desktop, hosted mobile and Capacitor configure the active Host
  through `runtimeFetch`; standalone VS Code explicitly returns 501.

## Authorization and persistence

Before opening storage or creating any timer, the runtime resolves the channel
policy from its environment. `NODE_ENV=development` or `YURI_ELECTRON_DEV=1/true`
disables WeChat by default; the web development server scripts explicitly set
`NODE_ENV=development`, including watch/HMR/full/mobile live-reload paths. An
explicit `YURI_WEIXIN_ENABLED=1/true` opts in; `0/false` or an unrecognized nonempty
value disables it in any environment. Production defaults remain enabled.

A disabled runtime does not open/create SQLite, acquire/release leases, poll,
send, infer live typing or mutate bindings. Status returns `disabled`; QR login,
verification, retry, disconnect and transfer fail with `channel_disabled` (403).
`forget` and shutdown are no-ops, so development does not erase production channel
credentials. Shared UI displays the disabled state without connection controls
and does not poll it. This gate is channel-specific, not general isolation of
assistant data; testing channels still requires an isolated data directory and
test account. Never copy production WeChat credentials into a second database.

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

### Moving a connection between Yuri Bots

The current WeChat flow supports one Bot entry for a scanning WeChat user, not a
new independent entry on every scan. Multiple stored bindings represent separate
platform accounts, not evidence that one user can create multiple contacts. QR
`binded_redirect` and confirmed-account conflicts never silently steal a binding.

For an unbound target, authenticated status responses optionally list local
`transferSources` containing only the source Bot ID, display name and binding
revision (epoch). No platform account/user IDs, tokens or context tickets leave
the Host. The settings row offers an explicit two-step confirmation, including
the loss of unprocessed inbound messages and queued outgoing replies. No QR or
platform reauthorization is required to move an existing local authorization.

`POST /api/yuri/assistants/:assistantID/weixin/transfer` accepts `sourceAssistantID`,
`revision` and UI `language`. The Host requires the current lease, a live source
matching that exact epoch and an unbound target; it will not overwrite even an
expired target binding. Source/target are locked while receiving and sending are
aborted/drained, live typing is cancelled, and target QR attempts are invalidated.
Both Bots and the source epoch are revalidated after the wait. Concurrent moves,
disconnects and QR starts cannot race this boundary; stale confirmations return
`binding_changed` (409). Shutdown waits for the move before releasing storage.

One SQLite transaction moves credentials, paired owner, cursor and reply context,
assigns a new epoch, sets the target's current transcript tip and drops the source
outbox. Receipt IDs survive under the new epoch as done, with cleared text, so
platform replays cannot re-execute tools after a move or restart. Pending messages
are not reassigned to the new Bot. Histories stay with their original Bots; already
admitted tasks continue there without further WeChat synchronization. Already
submitted HTTP sends cannot be recalled. Failed validation or transaction writes
leave source credentials, cursor and queues intact and resume its receiver (an
interrupted in-flight send still has the normal uncertain-delivery semantics).

The UI invalidates the current Host's channel queries after mutations, including
the source and target, and rejects stale-runtime completions. Connection candidates
are dynamic entity rows, not global Settings search entries. A connection owned by
WorkBuddy or another Host cannot be imported: users must unlink in that application
and authorize Yuri through the platform flow. Local disconnect alone does not
promise to revoke a remote application's authorization.

## Delivery semantics

Incoming receipt, reply context and platform cursor commit together before calling
`service.send()`. Namespaced IDs keep admission idempotent across duplicates and
restarts. Incoming and outgoing work is separate from the long-poll receiver; pending
plus admitted receipt count applies backpressure at 100, with 20 admissions per pass.
Each active account has one receiver, one serial input-preparation worker and one
outbound scheduler. Media downloads do not block same-account replies or another
account's preparation/sending. The process lease
renews every 2 seconds and expires after 60 seconds; another process sharing this
data directory cannot steal a live account. After any network wait, epoch/lease
checks fence stale writes. Cross-machine copies of credentials/data are unsupported.

Binding starts at the current contact tip, so existing history/greetings are not
sent. Subsequent **public assistant replies**, including App-initiated and background
task replies, sync to the paired owner. Plain text is sent as text; current cards
become title/name text, not interactive WeChat cards or deeplinks. Internal settle
markers are omitted and failures use a safe generic message, never raw tool errors.
Generation reset drops queued output from the previous transcript. An already submitted HTTP request
cannot be recalled, including during disconnect/reset.

### Rich inbound content

- Plain text retains the ordinary text path. Item protocol IDs (`msg_id`) and
  envelope fields such as timestamps, completion/routing fields, root/parent IDs,
  and empty button lists do not create a separate TOON text part. Private-only
  extensions are omitted after projection; actual share fields, quotes and
  nonempty buttons still retain their content.
  Every recognized image, voice, file
  and video item is represented; mixed items no longer silently lose media. An
  item-level `msg_id` is accepted when the top-level message ID is absent, matching
  the reference client. Sender/group/ID authorization runs before normalization
  or media access.
- Images download/decrypt and enter the existing `putAssistantContactAttachment`
  pipeline with deterministic receipt/item upload IDs. The transcript stores opaque
  attachment descriptors, not data URLs, CDN capabilities or AES keys. Existing
  contact materialization supplies bytes to vision-capable models; choosing a
  non-vision model does not acquire image understanding through this channel.
  Thumbnail-only references are labelled as thumbnails; URL-only image references
  still pass the same fixed-CDN validation. Neither permits arbitrary web fetching.
- Voice uses platform `voice_item.text` when present, without a duplicate audio
  download. Otherwise the original audio is retained as an attachment and marked
  **not transcribed**. No SILK decoder, automatic ASR provider, guessed transcript
  or new speech dependency is installed. Video similarly retains the original file,
  not a claim of audiovisual understanding. Text files use the existing gateway's
  bounded inline-text path; other document formats retain normal attachment/model
  limitations rather than being represented as extracted text.
- Unknown item types and top-level content extensions retain bounded structured
  data, including share titles, descriptions and article URLs **if supplied by the
  platform**. JSON-valued strings are projected structurally; XML remains quoted
  external text (no XML/entity expansion or URL fetching). Inline quote titles,
  IDs, substring metadata and supplied content are retained; an ID-only quote does
  not invent a cached body. This is not a guessed public article-item schema.
- Structure becomes TOON in an ordinary user text part, explicitly labelled as
  external content. Transport/authentication fields, media references/keys, bearer
  values and known sensitive URL parameters are excluded; raw upstream errors never
  reach the model/transcript. Links or metadata are not evidence that article
  contents were retrieved. The channel does not automatically fetch arbitrary
  article links or bypass WeChat login/risk controls. If iLink never delivers a
  share card, Yuri cannot recover it from the user's WeChat client.
- Bounds: 20 top-level items, eight downloads, nesting limits, a 24,000-character
  metadata budget (8,000 per string), and 20,000 ordinary text characters per
  message. Truncation is explicit. Each file is capped at 20 MiB to match the LLM
  gateway, and each turn at 50 MiB. Downloads are serial per account, have a
  20-second deadline, reject redirects, and only accept HTTPS at the known
  `novac2c.cdn.weixin.qq.com/c2c/download` endpoint. Unknown CDN hosts degrade to
  metadata with an unavailable marker rather than widening the fetch boundary.
- One failed download/storage operation does not discard text, transcripts,
  share fields or successful attachments. Missing bytes and original-only media
  have explicit status. Byte/metadata limits are degradation, not empty success.

The private inbox gains an additive `payload` column (old rows default to empty).
It stores normalized metadata and bounded media capabilities before advancing the
cursor, allowing pre-admission work to resume after restart with stable upload IDs.
After admission the existing no-tool-replay recovery rule applies. Completed,
recovered and transferred receipts clear both text and private payload; disconnect
deletes them. Download cancellation and post-await binding/lease/auth/generation
checks prevent stale preparation from admitting a message after disconnect, move,
expiry or transcript reset. Successfully staged attachments follow the existing
contact attachment lifecycle, including its normal unreferenced-object behavior.

Replies are split by Unicode code points into at most 3500-character segments;
stable client IDs and ordered pending outbox rows survive restart. This is not a server-side
exactly-once guarantee. An uncertain HTTP result is marked **delivery unknown**;
it and definitively blocked replies remain durable but do not block later pending
output, Bot execution or receiving. Later successful sends do not hide unresolved
delivery errors. New inbound context may unblock a known rejected reply but never
automatically retries an unknown send.
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
or background contact turns without a channel source, which may push to WeChat.
Replies to channel-originated turns require an exact receipt in this binding:
WeChat inputs reply only here, and enterprise-channel inputs never broadcast here.
The persisted contact turn ID identifies the original admitted input across restart.
Binding or
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
unknown delivery, HTTP protection, confirmed moves, failed-write rollback,
cursor/dedup preservation, concurrent/stale moves, typing cancellation/stale completions,
and real contact-pipeline execution with a fake WeChat service. Rich-input coverage
includes AES key encodings, SSRF/redirect/size boundaries, partial success,
TOON quoting, synthetic unknown share fields, voice transcripts, private-field
redaction, durable receipt migration/rollback/restart and real attachment storage.
Synthetic article extension fixtures are not evidence of a live platform schema.
Real-account
QR/verification, phone-visible delivery and typing presentation still require
manual testing; mocks and builds are not evidence of platform acceptance.

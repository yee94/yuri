# Enterprise message channels

Host-owned long-connection channel framework for enterprise platforms. It connects
one platform account to one existing Yuri Bot and reuses the Bot's normal contact
pipeline, tools and permissions. WeCom, Feishu and DingTalk wire behavior lives in
injected Chat SDK bridges (`sdk-adapters.js` and `dingtalk-chat-adapter.js`);
`runtime.js` and `store.js` own durable
storage, authorization, lifecycle and delivery semantics.

No public webhook, OAuth callback or platform protocol route is exposed here.
The shared runtime never constructs platform payloads, signs requests, refreshes
tokens or decides how a platform acknowledges a message. Those belong to the
adapter seam so a shared SDK can replace adapter internals without changing this
module.

## Chat adapter boundary

Platform implementations are supplied by the Host from a shared Chat SDK bridge.
Each `adapters[provider]` consumes a Chat SDK adapter internally;
the bridge is responsible for its dependency, protocol framing and reconnect
plumbing. This framework only sees `connect`/`send` and never imports the SDK,
registers SDK routes, or adds per-platform tables, queues or clocks.

Feishu reuses its existing Chat Adapter; WeCom and DingTalk implement the Chat SDK
Adapter interface over their official connection SDKs. The WeChat Bot
Adapter lives in `../weixin/chat-adapter.js` and is consumed by its existing
personal-channel runtime. Its QR authorization, typing, media behavior and private
database remain there. No second Chat state, lock or history engine is started.
SDK versions, ACK/ready evidence and platform limitations live in `PROTOCOLS.md`.

The seam is deliberately narrow so an SDK upgrade changes only the bridge:

- the framework owns Bot ownership, optional sender authorization, durable dedup,
  bounded queues, transcript generation, lease and lifecycle;
- the adapter owns wire authentication, heartbeats, receipts, platform payloads
  and target validation;
- both share one `{ connect, send }` contract and one `onMessage` receipt promise.

## Module map

- `store.js`: private SQLite binding, durable inbound receipts, ordered outbound
  deliveries, routing targets and the process-owner lease.
- `runtime.js`: enablement policy, connect lifecycle, optional sender restriction,
  bounded metadata projection, output reconciliation, dedup, retry/ambiguity and
  shutdown.
- `routes.js`: authenticated settings/mutation routes behind the Host gate.
- `sdk-adapters.js`: vendor Chat Adapter bridges and provider registry.
- `dingtalk-chat-adapter.js`: Chat Adapter extension using the official Stream SDK.
- `wecom-chat-adapter.js`: Chat Adapter extension using the official WeCom SDK,
  including platform-acknowledged sends rather than fire-and-forget writes.
- `transport.js`: bounded HTTP helpers for adapter-owned platform API calls;
  platform sockets and protocol framing remain SDK-owned.
- `../weixin/toon.js`: reused JSON-only TOON encoder. Channel metadata does not
  copy or fork it.

`service.channelPage()` is the internal bounded, ascending public-output seam. It
validates the Bot, uses the contact-store generation and returns only assistant
rows. It does not expose credentials or replace the contact execution engine.

## Runtime API

```js
createAssistantChannelsRuntime({
  directory, service, adapters, refreshAllowedRoots, env, clock, intervalMs,
})
```

- `status(assistantID, provider)` — sync read; validates the Bot first.
- `save(assistantID, provider, input)` — save configuration and connect.
- `discover(assistantID, provider, input, { signal })` — temporarily connect and
  return the first private sender's `{ ownerID }`, without saving or running tools.
- `transfer(assistantID, provider, input)` — explicitly move a local binding using
  `{ sourceAssistantID, revision }`, without returning or re-entering its secret.
- `retry(assistantID, provider)` — explicit reconnect only.
- `disconnect(assistantID, provider)` — delete local configuration and queues.
- `forget(assistantID)` — delete every provider for a deleted Bot.
- `onTurnEvent(event)` — receipt completion from contact turn events.
- `close()` — drain channel work, release the lease and close SQLite.

`registerAssistantChannelRoutes(app, runtime)` registers:

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/yuri/assistants/:assistantID/channels/:provider` | status |
| PUT | same | save + connect |
| POST | same `/retry` | reconnect without resending unknown output |
| POST | same `/transfer` | confirmed local rebind with source revision check |
| POST | same `/discover` | bounded, abortable user-ID discovery before Save |
| DELETE | same | disconnect |

Save input is `{ clientID, clientSecret?, ownerID, language? }`. A non-empty
`ownerID` is required on every save (`owner_required` otherwise) and restricts the
channel to that private sender. Existing unrestricted bindings remain readable and
operational until explicitly updated; no silent owner selection/migration occurs.
The first save
requires `clientSecret`; an update with the same `clientID` and an empty or omitted
secret keeps the stored one. A new `clientID` requires a new secret.
Responses are `Cache-Control: no-store` and contain only safe error codes — no
upstream bodies, secrets or routing targets.

Discovery takes `{ clientID, clientSecret? }` and the same credential-preservation
rules as Save. It returns only `{ ownerID }` after the first valid private message;
groups and missing/oversized sender IDs do not qualify. The user confirms that ID
through Save. The discovery message never enters the assistant execution pipeline.
Credentials stay in the temporary connection, not SQLite or response DTOs.
The request expires after 90 seconds (`discovery_timeout`), and HTTP disconnect,
Bot deletion, lease loss and Host shutdown abort it. A discovery owns its lane and
reserves its provider/account against concurrent saves or probes. It cannot take
another Bot's bound account. An existing connection on this lane is drained first
and resumed unchanged after discovery completes, fails or is cancelled. No other
provider/account is stopped. Platform ACK/reconnect behavior remains adapter-owned.

Status shape:

```json
{
  "provider": "wecom",
  "status": "disabled|disconnected|connecting|connected|reconnecting|error",
  "error": null,
  "configured": true,
  "clientID": "…",
  "ownerID": "…",
  "hasSecret": true,
  "transport": "websocket"
}
```

`clientID`, `ownerID` and `hasSecret` appear only when configured. The secret
itself never appears in any DTO, error, transcript, model context or log.
Unconfigured Bots may also receive `transferSources`: safe source Bot IDs, names,
client IDs and binding revisions for this provider. The UI uses the same move
button, warning and confirmation text as WeChat. It offers matching accounts
instead of telling users to manually unlink the other Bot first.

Transfer drains and stops the source lane under source/destination mutation locks,
then atomically moves credentials and rotates the epoch. It starts at the target
Bot's current transcript tip, preserves receipt IDs against replay, and discards
the old Bot's pending input and queued replies. Chat history and already-started
tasks are not moved or cancelled. Stale revisions, an occupied destination or
failed writes preserve the original binding and resume its receiver. Other
providers/accounts are untouched. The host lease still prevents taking a binding
from another process; this operation only moves a binding in this Host's store.

## Enablement policy

Before opening storage or creating a timer, the runtime resolves policy from its
environment. `NODE_ENV=development` or `YURI_ELECTRON_DEV=1/true` disables channels
by default. Only an explicit `YURI_CHANNELS_ENABLED=1/true` opts in; `0/false` or
an unrecognized non-empty value disables them in every environment. Production
defaults remain enabled.

A disabled runtime does not open/create SQLite, acquire a lease, poll, send or
mutate bindings. Status returns `disabled`; save, retry and disconnect fail with
`channel_disabled` (403). `forget` and `close` are no-ops, so development cannot
erase production channel credentials or delete their bindings.

## Adapter contract

Adapters are injected by provider key and must implement exactly:

```js
{
  connect({ config, signal, onReady, onMessage, onError }): Promise<void>,
  send({ config, target, text, id, signal }): Promise<void>,
}
```

- `config` is `{ clientID, clientSecret, ownerID, language }`.
- `connect` resolves or rejects only when that connection ends. It calls
  `onReady()` after authentication and `onError(error)` for asynchronous transport
  failures. Errors carry a safe `code`; `ambiguous` marks an indeterminate send.
  The framework sends only while the latest connection reported `onReady`; a
  transport error or connection end immediately closes that output lane.
- `onMessage(message)` must return a Promise that the adapter awaits before
  acknowledging the platform. It persists a durable receipt; it does not wait for
  model execution. A missing or overlong stable `id` is never admitted.
- Inbound shape:
  `{ id, senderID, chatType: 'private'|'group', text, metadata?, target? }`.
- `send` receives the current config, the private `target` snapshot and a stable
  delivery `id`. The adapter re-validates `target`; the framework never follows a
  user-controlled URL. An abort after submission must reject with `ambiguous: true`
  so the row becomes `unknown` instead of being retried.
- Adapters must honor `signal`; shutdown and disconnect abort platform I/O.

## Authorization and persistence

Only platform-delivered `private` messages with a valid sender identity may execute
tools. A saved non-empty `ownerID` adds an exact sender restriction. With an empty
ID, administrators must control access through the platform's Bot/application
availability and permissions. Group messages and messages without a valid sender
or stable platform ID are ignored. Receiving a message never saves an owner binding.
All allowed users share this Bot's existing context; this is not per-user isolation.

Account IDs, owner IDs and secrets are never truncated. An overlong value is a
`validation_error`; a changed `clientID` must supply its own secret rather than
silently reusing the previous account's credential. Changing the owner or account
starts the new binding at the current transcript tip, so replies produced while
the previous owner was disconnected are never leaked to the new destination. A
same-identity save keeps the existing watermark and durable receipts.

Bindings live under `<yuriDataDir>/channels/channel.sqlite`. The directory is 0700
and the database 0600, with SQLite secure-delete enabled. Secrets are **not
encrypted at rest**; the host OS user must protect the data directory and backups
(on Windows, OS ACLs remain necessary). The same `provider + clientID` maps to at
most one Bot in the data directory; a second Bot receives `account_in_use` (409).
Different enterprise accounts can bind different Bots, including multiple accounts
of the same provider. The personal-WeChat single-entry/rebind restriction belongs
only to `../weixin/` and never limits these enterprise bindings.

`target` is platform routing metadata (for example a reply handle or session
webhook). It is persisted only in this private database and per outbox row. It is
never added to model context, transcript text or HTTP DTOs. The framework replies
to the configured owner destination, or, without a binding, to the latest accepted
private sender. The runtime derives `target.userID` from the authenticated platform
sender, overriding any supplied routing field; queued output keeps its destination
snapshot. There is no push destination before the first accepted private message,
and earlier public output is not backfilled when a recipient first appears.

Inbound `metadata` is projected before storage: credential-shaped keys, media/file
references, URLs and raw event envelopes are dropped or replaced, nesting and
total size are bounded, and the result is encoded as TOON in an ordinary text part
labelled external content. This is a conservative projection, not proof that a
linked article or media body was read. Text is capped at 20,000 characters.
Internal `platform` and `chatType` labels are omitted from content metadata.
Ordinary text with only these labels remains one original text part, with no
TOON appendix; actual media/transcription descriptors retain their content hints.

## Shared three-provider state

One `channel` row exists per `(assistantID, provider)`. The three enterprise
providers share the same SQLite file, receipt table, outbox table and process
lease; there is no per-platform queue, worker, database or reconnect loop. Each
account still has one receiver and one serial input/output lane, so providers
cannot consume each other's queue or block each other's replies. Deleting a Bot
removes all three rows, receipts and deliveries in one transaction.

## Delivery semantics

- **Durability:** the receipt, private routing target and deduplicated stable ID
  commit before `onMessage` resolves. IDs are namespaced by provider, client account
  and owner, so platform replays and restarts cannot re-execute admitted tools.
- **Backpressure:** pending plus admitted receipts cap at 100; each pass admits at
  most 20. Adapters may treat `backlog_full` as retryable and must not acknowledge.
  A platform replay whose stable ID already has a durable receipt is acknowledged
  without a new slot, even when the backlog is full.
- **Isolation:** each account has one receiver, one serial inbound worker and one
  serial outbound scheduler. A slow Bot cannot block another account.
- **Output source:** all public assistant replies, including App-initiated and
  background replies, come from `channelPage`. Binding starts at the current
  contact tip, so previous history/greetings are not sent. Internal settle markers
  are omitted; failures use a safe generic message.
  All channels attached to the same Bot share its contact context, but replies
  go only to the channel that admitted the original input. Its persisted contact
  `turnID` is the reserved `channel:*`/`weixin:*` receipt ID, and exact receipt
  ownership by binding epoch gates delivery; another channel never broadcasts it.
  Only App/background turns without a channel origin are proactively pushed to
  all eligible bound platforms. Selection never uses the latest conversation turn.
  Each enterprise receipt keeps its own private reply target, so a later sender
  cannot redirect an earlier reply. The inbox target column is added in place for
  existing databases; legacy receipts without a target and without a fixed owner
  are not guessed from the latest sender. The feed watermark still advances over
  filtered replies. Channels are not separate conversation contexts.
- **Generation:** a transcript wipe changes `channelPage().generation`. Queued
  output from the previous generation is deleted, and late async work is fenced by
  epoch, lease and generation.
- **Unknown delivery:** a crash or abort during `sending`, or an ambiguous adapter
  error, marks the row `unknown`. It is never automatically resent and status
  reports `delivery_unknown`. `retry` only reconnects and does not clear it.
  Definitively failed rows may be retried explicitly after capped automatic attempts.
  Pending rows retain their sequence order, but `unknown` and `blocked` rows are
  bypassed so one failed notification cannot prevent later replies or Bot execution.
  Their durable state and error indicator survive later successful sends and restart.
  Saving the same account/owner preserves unknown rows; disconnecting discards that
  channel's queued replies as well as its credentials.
- **Reconnect:** connection failures retry with 1–30 second capped exponential
  backoff. Authentication failure and SDK `connection_replaced` become a sticky
  `error` until an explicit save or retry, so bad credentials or mutual-kick loops
  cannot hot-loop. Output is only attempted after `onReady`; a send failure never
  marks the lane connected. While sticky, new inbound receipts are not admitted
  and already durable but unadmitted work waits for an explicit reconnect.
- **Save and concurrency:** a save drains admitted inbound work and aborts the old
  receiver under a per-channel mutation lock. Owner/account changes revalidate the
  binding epoch after the wait; a conflict or failed write resumes the previous
  receiver instead of stranding it. `retry` and `disconnect` share the same lock
  and revalidate the epoch after draining.
- **Disconnect:** deletes local credentials, receipts and queued replies. It does
  not cancel already admitted contact work; late output is fenced and discarded.
- **Bot deletion:** `forget(assistantID)` removes every provider's local binding
  and queues for that Bot.
- **Shutdown:** `close()` stops new work, aborts platform I/O, awaits all tracked
  channel operations, releases the process lease and only then closes SQLite. The
  owning Host must close channels before `service.close()`.
- **Lease:** one process sharing the data directory owns channels for 60 seconds,
  renewed each tick (default 2 seconds). Another enabled process cannot steal a
  live account and responds `channel_in_use` until the lease expires.

## Not in this layer

Live typing/presence, platform media download, template cards, interactive
callbacks and per-provider protocol routing are intentionally absent. Those belong
to adapters or a shared SDK. This layer also does not promise server-side
exactly-once delivery or platform token revocation.

## Validation

Focused Vitest suite: `bunx vitest run --project @yuriai/web packages/web/server/lib/assistants/channels`.
It uses real SQLite and the real assistant service for the end-to-end
channel → Bot → durable reply path. Adapter wire tests live with their adapters and
do not prove real-account permissions, quotas or mobile rendering.

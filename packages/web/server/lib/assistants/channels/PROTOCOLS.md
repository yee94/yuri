# Enterprise channel protocol boundaries

This directory integrates the vendor-maintained Chat SDK adapters instead of
maintaining a second platform wire implementation. Platform framing, WebSocket
handshakes, protobuf, ping/pong and reconnect stay in the SDKs below; Yuri owns
authorization, projection, durable receipts, outbound ordering and error
classification.

## SDK inventory

| Provider | Package | Version | Role |
| --- | --- | --- | --- |
| Chat contract | `chat` | `4.44.0` | `Message` / `Author` / `Attachment` / `Adapter` / `NotImplementedError` |
| Feishu | `@larksuite/vercel-chat-adapter` | `0.3.0` | Chat SDK adapter wrapping `@larksuite/channel` |
| Feishu wire | `@larksuite/channel` | `0.7.1` | WebSocket long connection, 23-type normalization, resource download |
| WeCom | `@wecom/aibot-node-sdk` | `1.0.7` | Official smart-bot WebSocket and awaited send ACK; Yuri Chat Adapter extension |
| DingTalk | `dingtalk-stream` | `2.1.5` | Gateway open, WebSocket, ping/pong, subscription registration |

`@larksuite/channel` is a direct dependency of `packages/web` (`0.7.1`).
`sdk-adapters.js` imports `createLarkChannel`/`normalize` statically; there is no
runtime resolution fallback.

`transport.js` remains the owner of the small HTTP helpers
(`channelError`, `requestJSON`, `officialURL`). Channel adapters use
`requestJSON` for documented outbound REST calls (JSON or multipart) and do **not** use the
removed `socketLoop`; no adapter opens a raw WebSocket or decodes protobuf.

## Feishu

Wire evidence: `@larksuite/channel@0.7.1` and
`@larksuiteoapi/node-sdk@1.76.0` (`lib/index.js`), plus the official Go SDK
`larksuite/oapi-sdk-go@v3_main` (`ws/client_transport.go`).

- Bootstrap: `POST https://open.feishu.cn/callback/ws/endpoint` with
  `{AppID, AppSecret}`; response carries `URL` and
  `ClientConfig {PingInterval, ReconnectCount, ReconnectInterval, ReconnectNonce}`.
  The SDK dials the returned `wss://` URL; query holds `device_id`/`service_id`.
- Frames are `pbbp2.Frame` protobuf: `1 SeqID uint64`, `2 LogID uint64`,
  `3 service int32`, `4 method int32`, `5 headers`, `6 payloadEncoding`,
  `7 payloadType`, `8 payload`, `9 LogIDNew`; each header is
  `1 key`/`2 value`. `method` is `0 control` / `1 data`.
- Heartbeat: control frame with header `type=ping`; `pong` payload is JSON that
  updates interval/reconnect settings. `ping` frames received from the peer are
  not answered by the client.
- Delivery ACK: the official dispatcher replies with the same frame headers plus
  `biz_rt` and a JSON payload (`{code:200}`), and only after awaited handlers.
- Outbound: `POST /open-apis/im/v1/messages?receive_id_type=open_id` with
  `msg_type: text`, `content: {"text": ...}`. `uuid` dedupes for one hour and is
  capped at 50 characters (official API documentation); `outboundUuid()` keeps
  short row IDs verbatim and hashes longer ones to 40 hex characters.
  `tenant_access_token/internal` uses `{app_id, app_secret}` and caches until
  `expire - 180s`.
- Image output first uploads multipart `image_type=message` and `image` to
  `POST /open-apis/im/v1/images`, then sends `msg_type: image` with
  `content: {"image_key": ...}` and the same durable UUID policy. The app needs
  `im:resource` or `im:resource:upload` in addition to message-send permission.
  Upload failure never counts as a submitted chat message.
  Reference: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/create

ACK durability: the Chat adapter's normalized `message` path is not awaited by
the vendor dispatcher, so it cannot gate the ACK. `sdk-adapters.js` therefore
projects and persists through the public
`LarkChannel.onRawEvent('im.message.receive_v1')` hook. The hook is installed
from inside `channelFactory`, i.e. before the adapter calls `channel.connect()`,
so there is no unguarded boot window and no fallback path. The normalized
`message` handler registered by the vendor adapter is inert for Yuri (the raw
gate already owns delivery) and no private `_getChannel()` accessor is used.

The vendor dispatcher awaits the raw handler before replying, which is what
keeps the ACK behind the durable receipt. It also catches handler exceptions, so
a failed durable write cannot force a non-200 ACK frame; the bridge reports
`onError` instead, and the runtime aborts/reconnects that lane. Readiness is
re-armed from the channel's own `reconnected` event (`reconnecting` maps to
`network_error`), so a successful SDK reconnect never leaves `runtime.ready`
false.

`createLarkAdapter` disables the channel's own stale/dedup/lock/batch pipeline
(`safety.staleMessageWindowMs` maxed, `chatQueue` off, batch delays 0); Yuri owns
authorization and receipt dedupe.

Boundaries:

- Inbound text comes from the vendor normalization. Images/files/audio/video
  are reported as bounded public descriptors (`type`, `name`, `durationMs`) with
  `notDownloaded: true`; `file_key` is never projected or downloaded.
- The adapter's `Message.attachments` is empty today (the Chat adapter does not
  bridge `NormalizedMessage.resources`), so descriptors are read from the
  vendor's normalized `raw` payload. Acquiring bytes would require the vendor's
  internal `downloadResource` API; Yuri does not do that.
- The vendor adapter auto-reconnects its WebSocket itself. Yuri's runtime must
  not add a second reconnect loop for Feishu; the bridge maps the channel's
  `reconnecting` event to `onError('network_error')` and its `reconnected`
  event back to `onReady()`, so the UI does not stay `connected` during a gap and
  does not stay `reconnecting` after a successful resume. A 1s monitor reads the
  public `channel.getConnectionStatus()`; when the vendor exhausts its bounded
  reconnect attempts and reports `state: 'failed'`, the bridge reports
  `network_error` and returns from `connect()` so the runtime opens a fresh
  adapter. The bridge deliberately does not map every channel `error` event to a
  transport failure, because that event also covers non-fatal normalization and
  meeting errors; doing so would revoke readiness on a healthy connection.
- Outbound never retries automatically. `requestJSON` marks HTTP 5xx/timeouts
  during a send as ambiguous so the store records `delivery_unknown`.
- Aborting during `channel.connect()` is safe: the vendor's `disconnect()` is a
  no-op before the handshake completes, so the bridge closes the channel again
  once the aborted initialize settles. A canceled connect cannot leave a live
  socket behind.

## WeCom smart bot

Wire evidence: official `https://github.com/WecomTeam/aibot-node-sdk`,
`src/client.ts` (`sendMessage`) and `src/ws.ts` (`sendReply`/ACK handling).
`wecom-chat-adapter.js` implements the Chat SDK contract over its public `WSClient`.

- The SDK owns the official WebSocket, authentication, heartbeat, reconnect and
  request-ID ACK matching. No private `wsManager` fields or custom wire are used.
- `authenticated` establishes readiness; `disconnected`/`reconnecting` revoke it.
  Re-authentication restores readiness. Authentication failure and replacement are
  sticky errors; reconnect exhaustion returns control to Yuri's scheduler.
- Initialization has a deadline; abort closes the SDK connection and listeners.
- `sendMessage()` waits for the platform ACK. Only `errcode: 0` advances the
  outbox as sent (platform accepted, not proof the user read it). Nonzero ACKs are
  definite failures; timeout, cancellation or disconnection after submission are
  `delivery_unknown` and are never automatically resent.
- Native images use public `uploadMedia(buffer, {type:'image', filename})` and
  `sendMediaMessage(chatid, 'image', media_id)` from the installed official SDK.
  The SDK owns init/chunk/finish and the final message ACK; Yuri does not write
  its own chunk framing. Local-WebSocket tests exercise the full SDK upload plus
  final-ACK wait. Real-account acceptance/quotas still require platform testing.
- A configured owner fixes the private recipient; otherwise the runtime's private
  durable `target.userID` supplies it. Missing recipients fail before sending.
- Incoming messages preserve `msgid` for durable dedup, use standard Chat `Message`
  and platform voice transcription, and drop groups/disallowed senders. Media
  descriptors are explicitly `notDownloaded`; URLs and AES keys are not projected.
- Different credentials have independent live clients. The personal-WeChat
  single-entry/rebind rule remains confined to `weixin/`.
- The previous community adapter was removed because black-box testing proved
  its `postMessage()` resolved before ACK and ignored nonzero ACKs. Regression
  tests now drive the official SDK against a local WebSocket server, including
  successful consecutive sends, nonzero ACKs and cancellation.

## DingTalk

Image output uploads multipart `type=image`/`media` to the official legacy
`https://oapi.dingtalk.com/media/upload` endpoint, then uses the existing private
batch-send API with `msgKey: sampleImageMsg` and `msgParam: {photoURL: media_id}`.
The legacy upload API requires the access token in its query; it is ephemeral,
never persisted/logged or included in a transcript/error. Generated local images
need no publicly hosted URL. Platform size/format/permission failures remain
explicit delivery failures rather than a false text-only success. No automatic
lossy resize, new image dependency or public image-hosting service is introduced.
References: https://developers.dingtalk.com/document/app/upload-media-files and
https://open.dingtalk.com/document/orgapp/types-of-messages-sent-by-robots

Wire evidence: `dingtalk-stream@2.1.5` `dist/client.mjs` and
`src/client.ts` of `open-dingtalk/dingtalk-stream-sdk-nodejs`; OpenAPI metadata
from `@alicloud/dingtalk@2.2.48` (`robot_1_0`, `oauth2_1_0`).

- Gateway: `POST https://api.dingtalk.com/v1.0/gateway/connections/open` with
  `{clientId, clientSecret, ua, subscriptions}`; response `{endpoint, ticket}`
  and the SDK dials `${endpoint}?ticket=...`.
- The SDK owns ping/pong, `SYSTEM/CONNECTED|REGISTERED|disconnect|KEEPALIVE`
  and reconnect (disabled here with `autoReconnect: false`, because Yuri's
  runtime owns reconnect).
- Readiness: `REGISTERED` is the only authenticated signal. `connect()` waits
  for it with a `INIT_TIMEOUT_MS` deadline. The `onLost` hook and watchdog are
  installed before `client.connect()`, so a disconnect during the handshake is
  never missed. A socket that opens but never registers is reported as
  `network_error`, never `connected`.
- Session ownership: `createDingtalkSdkAdapter` creates one independent
  `DingTalkChatAdapter` per `clientID+clientSecret+ownerID`. There is no shared
  `this.session` singleton, so multiple bots connect in parallel; a duplicate
  live connect for the same config is rejected with `channel_in_use`. The live
  session map never evicts an active session.
- Initialization is abortable and bounded. Aborting during the SDK's endpoint
  request closes the session and a late `_connect()` is refused, so the
  underlying socket/timers cannot outlive the aborted connect.
- CALLBACK ACK: `2.1.5` does not auto-ack callbacks. `socketCallBackResponse`
  is called only after the Yuri delivery promise resolves; failures leave the
  callback unacknowledged for the platform retry. Unauthorized/malformed frames
  are acknowledged and dropped so they cannot retry forever.
- Outbound: `POST /v1.0/oauth2/accessToken` `{appKey, appSecret}` →
  `{accessToken, expireIn}` (cached until `expireIn - 300s`), then
  `POST /v1.0/robot/oToMessages/batchSend` with
  `{robotCode, userIds: [userID], msgKey: 'sampleText', msgParam}` and
  `x-acs-dingtalk-access-token`. The recipient is `config.ownerID` when configured,
  otherwise the runtime-derived `target.userID`. `invalidStaffIdList`,
  `flowControlledStaffIdList` and `filteredStaffIdList` are all treated as
  definite failures. HTTP 5xx/timeouts during send are ambiguous.
- Threads: `dingtalk:private:<owner>` / `dingtalk:group:<conversationId>`.
  `isDM()` is true only for the `private` prefix, so a group is never reported as
  a DM. `postMessage` throws `NotImplementedError` for group threads and
  `invalid_response` for any private thread that is not the configured owner.
- Postables: `renderFormatted`/`messageText` accept standard Chat shapes only —
  string, `{raw}`, `{markdown}` and `{ast}` (via `stringifyMarkdown`). The
  non-standard `{text}` field is not read.
- Projection: single chat only; `senderStaffId` (fallback `senderId`) must
  equal `ownerID` when configured, and the bot's own `chatbotUserId` is rejected. `audio` uses
  the platform's `recognition` text and marks `metadata.transcript =
  'platform'`; audio without recognition is `notDownloaded` and carries **no**
  invented transcript. `richText` is flattened to its text items. Other
  non-text messages yield `notDownloaded: true` plus `mediaType` and a bounded
  name. `sessionWebhook`, `robotCode`, `conversationId` and download codes are
  never projected.
- Unsupported Chat methods (`editMessage`, `deleteMessage`, `fetchMessages`,
  `fetchThread`, `addReaction`, `removeReaction`, `startTyping`) throw the Chat
  SDK `NotImplementedError` instead of pretending to work. `handleWebhook`
  returns 501; this adapter is long-connection only.

## Shared projection and logging

- Only `private`/single-chat messages with sender identities are delivered.
  A non-empty `ownerID` restricts this to one sender; empty uses platform access
  controls. Group messages, disallowed senders, bot/app senders and the bot's own
  events are dropped before any download or metadata expansion. Bot context is
  shared, not isolated per sender; administrators must verify platform availability.
- Inbound metadata is rebuilt from scratch with public fields only. Capability
  or secret handles (Feishu `file_key`, WeCom `aeskey`/`response_url`, DingTalk
  `sessionWebhook`/`robotCode`) are never copied, even when the vendor message
  carries them.
- Media is never downloaded automatically; every media message is explicitly
  marked `notDownloaded` rather than claiming the content was read.
- Logging: every vendor logger is replaced with an inert logger
  (`noopLogger()`). Vendor log arguments are never formatted or forwarded, so
  tokens, URLs, IDs, message content and upstream error bodies cannot reach Yuri
  logs through SDK logger objects. SDK errors are mapped to
  `auth_expired`/`invalid_response`/`network_error`/`connection_replaced`
  without forwarding raw upstream messages.

## Known limits

- Feishu: one extra normalization per inbound message (the vendor pipeline also
  normalizes). The vendor dispatcher swallows exceptions from raw handlers, so a
  failed durable write cannot force a non-200 ACK frame; the bridge reports
  `onError` and the runtime aborts the lane instead.
- Feishu: `uuid` is derived from the durable delivery row ID; if the same row is
  re-sent with different text, the platform would dedupe it. Yuri never mutates
  a queued row's text. Neither vendor SDK exposes an idempotent send, which is
  why the bridge uses the documented HTTP call with `uuid`.
- WeCom: real tenant authentication, proactive-message permissions and actual
  network reconnection remain unverified; local SDK/ACK tests are not tenant tests.
- DingTalk: no media download, no history fetch, and readiness depends on the
  platform emitting `REGISTERED` within the bounded window. Abort cleanup patches
  the SDK's internal `_connect` because `connect()` awaits an unabortable
  endpoint request before creating the socket.
- These adapters were validated with unit fixtures and the real SDK runtime
  packages (including the real `WeComFormatConverter`, Feishu `normalize`, Chat
  `Message`/`stringifyMarkdown`, and a real `@agentor/chat-wecom@0.1.3` run over
  an injected fake `WebSocket` for the ACK evidence), not with live
  Feishu/WeCom/DingTalk tenants. Real-account authentication, delivery and
  reconnect behavior still require manual verification.

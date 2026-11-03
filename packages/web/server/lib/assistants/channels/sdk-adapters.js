import { createHash } from 'node:crypto';
import { createLarkChannel, normalize } from '@larksuite/channel';
import { createDingtalkSdkAdapter } from './dingtalk-chat-adapter.js';
import { createWecomSdkAdapter as createOfficialWecomSdkAdapter } from './wecom-chat-adapter.js';
import { channelError, requestJSON } from './transport.js';

/**
 * Bridges the vendor-maintained SDKs into Yuri's channel contract.
 *
 * Feishu inbound uses the official `@larksuite/channel` long connection; the
 * Chat SDK adapter is kept for its standard `Message` parser only. Its raw-event
 * hook is public and installed from `channelFactory` before `connect()`, so the
 * platform ACK always waits for the durable receipt.
 *
 * WeCom uses the official SDK through `wecom-chat-adapter.js`, including awaited
 * platform send acknowledgements. No community fire-and-forget path is used.
 */

const FEISHU_ORIGIN = 'https://open.feishu.cn';
const FEISHU_TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
const FEISHU_MESSAGE_PATH = '/open-apis/im/v1/messages';
const TOKEN_CACHE_LIMIT = 4;
const TOKEN_EXPIRY_MARGIN_MS = 180_000;
const INIT_TIMEOUT_MS = 20_000;
const DISCONNECT_TIMEOUT_MS = 5_000;
const MONITOR_INTERVAL_MS = 1_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_RESOURCES = 8;
const MAX_NAME_CHARS = 120;

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function requireConfig(config) {
  if (!config || typeof config !== 'object') throw channelError('invalid_response');
  if (!nonEmptyString(config.clientID) || !nonEmptyString(config.clientSecret)
    || (config.ownerID !== undefined && typeof config.ownerID !== 'string')) {
    throw channelError('invalid_response');
  }
  return { clientID: config.clientID, clientSecret: config.clientSecret, ownerID: config.ownerID ?? '' };
}

function credentialKey(clientID, clientSecret) {
  return `${clientID}\u0000${clientSecret}`;
}

function truncateText(value, limit = MAX_TEXT_CHARS) {
  const chars = Array.from(typeof value === 'string' ? value : '');
  if (chars.length <= limit) return typeof value === 'string' ? value : '';
  return chars.slice(0, limit).join('');
}

function truncateName(value) {
  if (!nonEmptyString(value)) return undefined;
  return Array.from(value).slice(0, MAX_NAME_CHARS).join('');
}

/** Map vendor failures to the safe codes the channel runtime understands. */
function vendorCode(error) {
  const status = Number(error?.statusCode ?? error?.status ?? error?.response?.status);
  if (status === 401 || status === 403) return 'auth_expired';
  if (status >= 400) return 'network_error';
  const name = String(error?.name ?? '');
  if (/auth/i.test(name)) return 'auth_expired';
  return 'network_error';
}

/**
 * Inert logger. Vendor log messages can contain URLs, IDs or upstream bodies,
 * so nothing is forwarded: only Yuri's own error codes leave this module.
 */
function noopLogger() {
  const logger = {
    child: () => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    trace: () => {},
  };
  return logger;
}

function pruneCache(cache, limit) {
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

/** True only for Yuri channel errors, which always carry a boolean `ambiguous`. */
function isYuriError(error) {
  return typeof error?.code === 'string' && typeof error?.ambiguous === 'boolean';
}

function bounded(promise, signal, { timeoutMs = INIT_TIMEOUT_MS, ambiguous = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, channelError('network_error', ambiguous)), timeoutMs);
    timer.unref?.();
    const onAbort = () => finish(reject, channelError('cancelled', ambiguous));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, isYuriError(error) ? error : channelError('network_error', ambiguous)),
    );
  });
}

async function settleQuietly(promise) {
  try {
    await bounded(Promise.resolve(promise), undefined, { timeoutMs: DISCONNECT_TIMEOUT_MS });
  } catch {}
}

async function feishuAccessToken(tokens, { clientID, clientSecret, signal, fetchImpl }) {
  const key = credentialKey(clientID, clientSecret);
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  tokens.delete(key);
  const json = await requestJSON(`${FEISHU_ORIGIN}${FEISHU_TOKEN_PATH}`, {
    body: { app_id: clientID, app_secret: clientSecret },
    signal,
    fetchImpl,
  });
  if (json?.code !== 0 || !nonEmptyString(json?.tenant_access_token)) throw channelError('auth_expired');
  const expiresIn = Number(json.expire);
  tokens.set(key, {
    value: json.tenant_access_token,
    expiresAt: Date.now() + Math.max(60_000, (Number.isFinite(expiresIn) ? expiresIn * 1000 : 0) - TOKEN_EXPIRY_MARGIN_MS),
  });
  // Tokens are pure caches: evicting one only costs a re-fetch, never a
  // connection. Active sockets are never pruned.
  pruneCache(tokens, TOKEN_CACHE_LIMIT);
  return json.tenant_access_token;
}

/** Standard Chat `Message` → Yuri projection. */
function projectFeishu(message) {
  const normalized = message?.raw;
  if (!normalized || normalized.chatType !== 'p2p' || normalized.senderType !== 'user') return null;
  const senderID = message.author?.userId ?? normalized.senderId;
  const resources = Array.isArray(normalized.resources)
    ? normalized.resources.slice(0, MAX_RESOURCES).map((resource) => {
      const projected = { type: nonEmptyString(resource?.type) ? resource.type : 'file' };
      const name = truncateName(resource?.fileName);
      if (name) projected.name = name;
      const duration = Number(resource?.durationMs);
      if (Number.isFinite(duration) && duration >= 0) projected.durationMs = duration;
      return projected;
    })
    : [];
  const metadata = { platform: 'feishu', chatType: 'private' };
  if (resources.length > 0) {
    metadata.notDownloaded = true;
    metadata.resources = resources;
  }
  const mentionNames = Array.isArray(normalized.mentions)
    ? normalized.mentions.map((mention) => truncateName(mention?.name)).filter(Boolean).slice(0, MAX_RESOURCES)
    : [];
  if (mentionNames.length > 0) metadata.mentions = mentionNames;
  return {
    id: String(message?.id ?? normalized.messageId ?? ''),
    senderID: String(senderID ?? ''),
    chatType: 'private',
    text: truncateText(message?.text ?? normalized.content),
    metadata,
  };
}

function acceptsOwner(projected, ownerID) {
  return Boolean(projected) && projected.senderID.length > 0 && (!ownerID || projected.senderID === ownerID);
}

/**
 * Minimal ChatInstance substitute. Chat core state, locks, dedupe keys and
 * thread history are not used; the Feishu adapter gets a logger and inert
 * message sinks because the raw gate owns delivery.
 */
function createLarkHost() {
  const logger = noopLogger();
  return {
    getLogger: () => logger,
    async processMessage() {},
    async processAction() {},
    processReaction() {},
  };
}

/**
 * Feishu bridge.
 *
 * ACK gating: `@larksuite/channel` replies to Feishu only after awaited
 * `onRawEvent` handlers, while the normalized `message` pipeline is not
 * awaited. The gate is registered from `channelFactory`, i.e. before the
 * adapter calls `connect()`, so there is no unguarded window.
 */
export function createFeishuSdkAdapter({
  adapterFactory,
  channelFactory,
  normalizeEvent = normalize,
  fetchImpl = fetch,
} = {}) {
  const tokens = new Map();

  return {
    async connect({ config, signal, onReady, onMessage, onError } = {}) {
      const { clientID, clientSecret, ownerID } = requireConfig(config);
      signal?.throwIfAborted();
      let adapter;
      let channel;
      let offRaw;
      let initPromise;
      let stopped = false;

      const stop = async () => {
        if (stopped) return;
        stopped = true;
        const activeAdapter = adapter;
        const activeChannel = channel;
        adapter = undefined;
        channel = undefined;
        try {
          offRaw?.();
        } catch {}
        offRaw = undefined;
        await settleQuietly(activeAdapter?.disconnect?.());
        // `channel.disconnect()` is a no-op while the handshake is still in
        // flight. Once the aborted initialize settles, close the socket it may
        // have opened, so an abort cannot leak a connection.
        if (initPromise) {
          void initPromise
            .then(() => settleQuietly(activeChannel?.disconnect?.()))
            .catch(() => {});
        }
      };

      const createChannel = channelFactory ?? ((options) => createLarkChannel({ ...options, retry: { maxAttempts: 1 } }));

      try {
        const factory = adapterFactory ?? (await import('@larksuite/vercel-chat-adapter')).createLarkAdapter;
        adapter = await factory({
          appId: clientID,
          appSecret: clientSecret,
          logger: noopLogger(),
          channelFactory: (options) => {
            const created = createChannel(options);
            if (!created || typeof created.onRawEvent !== 'function' || typeof created.getBotIdentity !== 'function') {
              throw channelError('invalid_response');
            }
            channel = created;
            offRaw = created.onRawEvent('im.message.receive_v1', async (raw) => {
              if (stopped || !adapter) return;
              const normalized = await normalizeEvent(raw, {
                botIdentity: created.getBotIdentity(),
                stripBotMentions: true,
              });
              const projected = projectFeishu(adapter.parseMessage(normalized));
              if (!acceptsOwner(projected, ownerID)) return;
              await onMessage?.(projected);
            });
            return created;
          },
        });
        initPromise = adapter.initialize(createLarkHost());
        await bounded(initPromise, signal);
        if (signal?.aborted || stopped) {
          await stop();
          return;
        }
        // Re-arm readiness on the SDK's own reconnect events; otherwise a
        // transient error would leave runtime.ready false forever.
        channel?.on?.('reconnecting', () => onError?.(channelError('network_error')));
        channel?.on?.('reconnected', () => onReady?.());
        onReady?.();
        await new Promise((resolve) => {
          let settled = false;
          let monitor;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearInterval(monitor);
            signal?.removeEventListener('abort', finish);
            stop().finally(resolve);
          };
          // The vendor retries a bounded number of times and then sets a
          // terminal `failed` state without emitting `reconnected`. Hand the
          // lane back to Yuri's runtime so it can open a fresh adapter.
          monitor = setInterval(() => {
            if (settled) return;
            let status;
            try {
              status = channel?.getConnectionStatus?.();
            } catch {
              return;
            }
            if (status?.state !== 'failed') return;
            onError?.(channelError('network_error'));
            finish();
          }, MONITOR_INTERVAL_MS);
          monitor.unref?.();
          signal?.addEventListener('abort', finish, { once: true });
          if (signal?.aborted) finish();
        });
      } catch (error) {
        await stop();
        throw isYuriError(error) ? error : channelError(vendorCode(error));
      }
    },

    /**
     * Feishu has no public idempotent send in either SDK: the Chat adapter
     * always converts to markdown/post and retries internally, and
     * `@larksuite/channel` exposes no `uuid`. The documented HTTP call keeps
     * `msg_type: text` and a stable `uuid` for one attempt.
     */
    async send({ config, target, text, image, id, signal, beforeSend } = {}) {
      const { clientID, clientSecret, ownerID } = requireConfig(config);
      const userID = ownerID || target?.userID;
      if (!nonEmptyString(userID)) throw channelError('invalid_response');
      const token = await feishuAccessToken(tokens, { clientID, clientSecret, signal, fetchImpl });
      let imageKey;
      if (image) {
        const form = new FormData();
        form.set('image_type', 'message');
        form.set('image', new Blob([image.buffer], { type: image.mime }), image.filename);
        const uploaded = await requestJSON(`${FEISHU_ORIGIN}/open-apis/im/v1/images`, {
          body: form, headers: { Authorization: `Bearer ${token}` }, signal, fetchImpl,
        });
        if (uploaded?.code !== 0 || !nonEmptyString(uploaded?.data?.image_key)) throw channelError('delivery_failed');
        imageKey = uploaded.data.image_key;
      }
      const uuid = outboundUuid(id);
      beforeSend?.();
      const json = await requestJSON(`${FEISHU_ORIGIN}${FEISHU_MESSAGE_PATH}?receive_id_type=open_id`, {
        body: {
          receive_id: userID,
          msg_type: image ? 'image' : 'text',
          content: JSON.stringify(image ? { image_key: imageKey } : { text: typeof text === 'string' ? text : '' }),
          ...(uuid ? { uuid } : {}),
        },
        headers: { Authorization: `Bearer ${token}` },
        signal,
        fetchImpl,
        sending: true,
      });
      if (json?.code !== 0) {
        throw channelError([99991663, 99991664, 99991661, 10003, 10014].includes(json?.code) ? 'auth_expired' : 'invalid_response');
      }
    },
  };
}

/** Message de-duplication ID: stable per outbound row, <= 50 chars as required. */
export function outboundUuid(id) {
  const value = typeof id === 'string' ? id : id == null ? '' : String(id);
  if (!value) return undefined;
  if (value.length <= 50) return value;
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

/**
 * Provider registry consumed by the assistant channel routes.
 */
export function createAssistantChannelAdapters(options = {}) {
  const { feishu = {}, wecom = {}, dingtalk = {} } = options;
  return {
    feishu: createFeishuSdkAdapter(feishu),
    wecom: createOfficialWecomSdkAdapter(wecom),
    dingtalk: createDingtalkSdkAdapter(dingtalk),
  };
}

export const createWecomSdkAdapter = createOfficialWecomSdkAdapter;

import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantChannelStore } from './store.js';
import { encodeWeixinTOON } from '../weixin/toon.js';
import { isMessageChannelTurn } from '../message-channel-origin.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const PROVIDER = /^[a-z][a-z0-9_]{1,31}$/;
const MAX_PLATFORM_ID = 256;
const MAX_ACCOUNT_FIELD = 512;
const MAX_SECRET = 4096;
const MAX_TEXT = 20_000;
const MAX_CHUNK = 3500;
const MAX_TARGET_BYTES = 16_384;
const BACKLOG_MAX = 100;
const AUTH_ERRORS = new Set(['auth_failed', 'auth_expired']);
const STICKY_ERRORS = new Set(['auth_failed', 'auth_expired', 'unsupported_provider', 'connection_replaced']);
const CONNECTION_ERRORS = new Set(['network_error', 'connection_closed', 'invalid_response', 'rate_limited', 'channel_in_use']);
const SAFE_ERRORS = new Set([
  'auth_failed', 'auth_expired', 'network_error', 'upstream_error', 'invalid_response',
  'rate_limited', 'delivery_failed', 'delivery_unknown', 'connection_closed',
  'connection_replaced', 'unsupported_provider', 'validation_error', 'account_in_use',
  'not_found', 'channel_in_use', 'channel_disabled', 'cancelled', 'backlog_full',
  'binding_changed',
]);

export class ChannelError extends Error {
  constructor(code, { ambiguous = false } = {}) {
    super(code);
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

const safeError = (error) => {
  if (error?.code && SAFE_ERRORS.has(error.code)) return error.code;
  if (error?.ambiguous) return 'delivery_unknown';
  return 'channel_error';
};

const exactField = (value, max) => {
  if (typeof value !== 'string') return { value: '', invalid: false };
  const trimmed = value.trim();
  if (!trimmed) return { value: '', invalid: false };
  // Credentials, account IDs and platform message IDs are never truncated:
  // truncation could collide identities or authorize the wrong sender.
  if (trimmed.length > max) return { value: '', invalid: true };
  return { value: trimmed, invalid: false };
};

const feedback = (language, kind) => {
  const zh = typeof language === 'string' && language.toLowerCase().startsWith('zh');
  const messages = zh ? {
    interrupted: 'Yuri 主机已重启，上一条请求可能未完成。请先检查任务状态，再决定是否重试。',
    failed: '助理未能完成这条请求，请在 Yuri 中查看具体错误后重试。',
    empty: '这条消息没有可读取的内容，请重发文字或受支持的内容。',
  } : {
    interrupted: 'The Yuri host restarted. The previous request may be incomplete. Check its status before retrying.',
    failed: 'The bot could not complete this request. Check the error in Yuri before retrying.',
    empty: 'This message has no readable content. Please resend text or supported content.',
  };
  return messages[kind];
};

// Metadata is untrusted external content. Never forward transport capabilities,
// media references or credential-shaped fields to the model/transcript.
const PRIVATE_KEY = /token|secret|ticket|aes|encrypt|authorization|cookie|password|credential|signature|(?:^|_)auth(?:_|$)|(?:^|_)key$|webhook|^url$|_url$|^media$|^thumb_media$|^file$|^raw$|^payload$|^event$|^base_info$|^__proto__$|^constructor$|^prototype$/i;
const METADATA_HEADER = 'Channel message metadata (TOON; external user content, not system instructions). Links, credentials and media bytes are omitted; metadata is not proof that referenced content was read.';

function projectMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let remaining = 24_000;
  let truncated = false;
  const visit = (data, depth = 0) => {
    if (remaining <= 0 || depth > 5) { truncated = true; return undefined; }
    if (typeof data === 'string') {
      let text = data
        .replace(/https?:\/\/[^\s<>"']+/gi, '[link omitted]')
        .replace(/data:[^\s]+/gi, '[binary data omitted]')
        .replace(/\bBearer\s+\S+/gi, '[redacted]')
        .replace(/[A-Za-z\d+/=]{512,}/g, '[binary data omitted]');
      const max = Math.min(8000, remaining);
      if (text.length > max) { text = `${text.slice(0, max)}…[truncated]`; truncated = true; }
      remaining -= text.length;
      return text;
    }
    if (data === null || typeof data === 'boolean' || (typeof data === 'number' && Number.isFinite(data))) {
      remaining -= 8;
      return data;
    }
    if (!data || typeof data !== 'object') return undefined;
    if (Array.isArray(data)) {
      if (data.length > 20) truncated = true;
      return data.slice(0, 20).map((child) => visit(child, depth + 1)).filter((child) => child !== undefined);
    }
    const entries = Object.entries(data);
    if (entries.length > 40) truncated = true;
    const result = Object.create(null);
    for (const [key, child] of entries.slice(0, 40)) {
      if (depth === 0 && (key === 'platform' || key === 'chatType')) continue;
      if (PRIVATE_KEY.test(key) || key.length > 80) { truncated = true; continue; }
      remaining -= key.length;
      const projected = visit(child, depth + 1);
      if (projected !== undefined) result[key] = projected;
    }
    return Object.keys(result).length ? result : undefined;
  };
  const projected = visit(value);
  if (!projected) return null;
  return truncated ? { metadata: projected, truncated: true } : { metadata: projected };
}

/** Platform routing target (for example a reply handle or webhook). Private DB only. */
function serializeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  let bytes = 0;
  const visit = (data, depth = 0) => {
    if (depth > 3) return undefined;
    if (typeof data === 'string') {
      if (data.length > 2048) return undefined;
      bytes += data.length;
      return data;
    }
    if (typeof data === 'number' && Number.isFinite(data)) { bytes += 8; return data; }
    if (typeof data === 'boolean') { bytes += 4; return data; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
    const result = Object.create(null);
    for (const [key, child] of Object.entries(data).slice(0, 20)) {
      if (key.length > 80 || /^(?:__proto__|constructor|prototype)$/.test(key)) continue;
      const projected = visit(child, depth + 1);
      if (projected !== undefined) result[key] = projected;
      if (bytes > MAX_TARGET_BYTES) return undefined;
    }
    return result;
  };
  const target = visit(value);
  if (!target || bytes > MAX_TARGET_BYTES) return '';
  return JSON.stringify(target);
}

const parseTarget = (value) => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch { return undefined; }
};

const chunkText = (text) => {
  const chars = Array.from(text);
  const chunks = [];
  for (let index = 0; index < chars.length; index += MAX_CHUNK) {
    chunks.push(chars.slice(index, index + MAX_CHUNK).join(''));
  }
  return chunks;
};

/**
 * Generic Host-owned long-connection channel framework for WeCom, Feishu and
 * DingTalk. Platform wire behavior lives in injected adapters; this module owns
 * ownership, durability, deduplication, authorization and delivery semantics.
 */
export function createAssistantChannelsRuntime({
  directory,
  service,
  adapters = {},
  refreshAllowedRoots = async () => {},
  env = process.env,
  clock = Date.now,
  intervalMs = 2000,
} = {}) {
  const configured = String(env.YURI_CHANNELS_ENABLED ?? '').trim().toLowerCase();
  const development = env.NODE_ENV === 'development'
    || ['1', 'true'].includes(String(env.YURI_ELECTRON_DEV ?? '').trim().toLowerCase());
  const enabled = configured ? ['1', 'true'].includes(configured) : !development;
  const assertProvider = (provider) => {
    if (typeof provider !== 'string' || !PROVIDER.test(provider)) throw new ChannelError('validation_error');
    return provider;
  };
  if (!enabled) {
    // Do not open the private store, acquire a lease, or erase production config.
    const disabled = async (assistantID, provider) => {
      assertProvider(provider);
      throw new ChannelError('channel_disabled');
    };
    return {
      status: (assistantID, provider) => {
        assertProvider(provider);
        return {
          provider, status: 'disabled', error: null, configured: false,
          hasSecret: false, transport: 'websocket',
        };
      },
      save: disabled, retry: disabled, disconnect: disabled, transfer: disabled,
      forget: async () => {}, onTurnEvent: () => {}, close: async () => {},
    };
  }

  const store = createAssistantChannelStore(directory);
  const owner = randomUUID();
  const receivers = new Map();
  const bindingWork = new Map();
  const inboundWork = new Map();
  const operations = new Set();
  const recovered = new Set();
  const retiring = new Set();
  const lifetime = new AbortController();
  let closed = false;
  let ownsLease = false;
  let closePromise;

  const channelKey = (assistantID, provider) => `${assistantID}:${provider}`;
  const track = (promise) => {
    operations.add(promise);
    void promise.finally(() => operations.delete(promise)).catch(() => {});
    return promise;
  };
  const pause = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});
  const backoff = (failures) => Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
  const configOf = (row) => ({
    clientID: row.client_id,
    clientSecret: row.client_secret,
    ownerID: row.owner_id,
    language: row.language,
  });
  const assertOwner = () => {
    if (closed) throw new ChannelError('channel_in_use');
    if (!ownsLease) ownsLease = store.acquire(owner, clock());
    if (!ownsLease || !store.owns(owner, clock())) throw new ChannelError('channel_in_use');
  };
  const canControl = (binding) => ownsLease && store.owns(owner, clock())
    && store.get(binding.assistant_id, binding.provider)?.epoch === binding.epoch;
  const isCurrent = (binding) => !closed
    && !retiring.has(channelKey(binding.assistant_id, binding.provider))
    && canControl(binding);
  const isSticky = (row) => row?.status === 'error' && STICKY_ERRORS.has(row.error);
  const derivedError = (row) => store.hasUnknown(row.epoch) ? 'delivery_unknown'
    : row.error ? row.error
      : store.hasBlocked(row.epoch) ? 'delivery_failed' : null;
  // Preserve actionable delivery/SDK errors across reconnects; only clear
  // transient connection errors once the adapter is authenticated again.
  const settledError = (epoch, current) => store.hasUnknown(epoch) ? 'delivery_unknown'
    : store.hasBlocked(epoch) ? 'delivery_failed'
      : CONNECTION_ERRORS.has(current) ? null
        : current ?? null;

  const stopReceiver = (key) => {
    const entry = receivers.get(key);
    entry?.controller.abort();
    receivers.delete(key);
    return entry?.done;
  };
  const setError = (binding, error) => {
    if (!isCurrent(binding)) return;
    const code = safeError(error);
    const status = STICKY_ERRORS.has(code) ? 'error'
      : CONNECTION_ERRORS.has(code) ? 'reconnecting'
        : 'connected';
    store.patch(binding.epoch, { status, error: code, updated_at: clock() });
  };

  /** Persist a durable receipt before the adapter acknowledges the platform. */
  const acceptInbound = async (binding, message) => {
    if (!isCurrent(binding)) throw new ChannelError('channel_in_use');
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new ChannelError('invalid_response');
    }
    // The optional owner narrows platform access; sender identity and private
    // chat are still required when no additional Yuri restriction is configured.
    if (message.chatType !== 'private') return false;
    const sender = exactField(message.senderID, MAX_ACCOUNT_FIELD);
    if (sender.invalid || !sender.value || (binding.owner_id && sender.value !== binding.owner_id)) return false;
    const platform = exactField(message.id, MAX_PLATFORM_ID);
    if (platform.invalid || !platform.value) return false;
    const id = `channel:${binding.provider}:${digest(JSON.stringify([
      binding.client_id, binding.owner_id || sender.value, platform.value,
    ]))}`;
    // A platform replay of an already durable receipt must still be acknowledged
    // when the backlog is full; it must not consume a new slot or execute again.
    if (store.hasReceipt(id)) return true;
    if (store.backlog(binding.epoch) >= BACKLOG_MAX) throw new ChannelError('backlog_full');
    const text = typeof message.text === 'string' ? message.text.slice(0, MAX_TEXT) : '';
    const projected = projectMetadata(message.metadata);
    const payload = projected
      ? `${METADATA_HEADER}\n${encodeWeixinTOON(projected)}`
      : '';
    const target = serializeTarget({ ...message.target, userID: sender.value });
    store.accept(binding, [{ id, text, payload, target }]);
    return true;
  };

  const connectLoop = async (binding, entry) => {
    const key = channelKey(binding.assistant_id, binding.provider);
    const adapter = adapters[binding.provider];
    let failures = 0;
    while (!closed && !entry.controller.signal.aborted && isCurrent(binding)) {
      const row = store.get(binding.assistant_id, binding.provider);
      if (!row || row.epoch !== binding.epoch || isSticky(row)) return;
      if (!adapter) {
        store.patch(binding.epoch, { status: 'error', error: 'unsupported_provider', updated_at: clock() });
        return;
      }
      entry.fatal = null;
      entry.ready = false;
      store.patch(binding.epoch, {
        status: failures ? 'reconnecting' : 'connecting',
        error: derivedError(row),
        updated_at: clock(),
      });
      try {
        await adapter.connect({
          config: configOf(row),
          signal: entry.controller.signal,
          onReady: () => {
            if (!isCurrent(binding) || entry.controller.signal.aborted) return;
            const live = store.get(binding.assistant_id, binding.provider);
            // A late ready callback must not resurrect a replaced/auth-sticky lane.
            if (!live || live.epoch !== binding.epoch || isSticky(live)) return;
            entry.ready = true;
            failures = 0;
            store.patch(binding.epoch, {
              status: 'connected',
              // Authentication must not erase an unknown/failed delivery or an
              // SDK-provided sticky error such as a replaced connection.
              error: settledError(binding.epoch, live.error),
              updated_at: clock(),
            });
            // Flush already durable backlog without waiting for the next tick.
            void track(tick());
          },
          onMessage: (message) => (entry.controller.signal.aborted
            ? Promise.reject(new ChannelError('cancelled'))
            : acceptInbound(binding, message)),
          onError: (error) => {
            if (!isCurrent(binding)) return;
            const code = safeError(error);
            // A transport error means this connection is no longer a valid output
            // lane until the adapter authenticates again.
            entry.ready = false;
            if (STICKY_ERRORS.has(code)) {
              entry.fatal = code;
              store.patch(binding.epoch, { status: 'error', error: code, updated_at: clock() });
              entry.controller.abort();
              return;
            }
            store.patch(binding.epoch, {
              status: 'reconnecting',
              error: store.hasUnknown(binding.epoch) ? 'delivery_unknown' : code,
              updated_at: clock(),
            });
          },
        });
        entry.ready = false;
        if (closed || entry.controller.signal.aborted || entry.fatal || !isCurrent(binding)) return;
        store.patch(binding.epoch, {
          status: 'reconnecting',
          error: store.hasUnknown(binding.epoch) ? 'delivery_unknown' : 'connection_closed',
          updated_at: clock(),
        });
        failures += 1;
      } catch (error) {
        entry.ready = false;
        if (closed || entry.controller.signal.aborted || !isCurrent(binding)) return;
        const code = safeError(error);
        if (STICKY_ERRORS.has(code)) {
          store.patch(binding.epoch, { status: 'error', error: code, updated_at: clock() });
          return;
        }
        store.patch(binding.epoch, {
          status: 'reconnecting',
          error: store.hasUnknown(binding.epoch) ? 'delivery_unknown' : code,
          updated_at: clock(),
        });
        failures += 1;
      }
      await pause(backoff(Math.max(0, failures - 1)), entry.controller.signal);
      if (closed || entry.controller.signal.aborted || !isCurrent(binding)) return;
      if (receivers.get(key) === entry) entry.ready = false;
    }
  };

  const startReceiver = (binding) => {
    const key = channelKey(binding.assistant_id, binding.provider);
    if (receivers.has(key) || retiring.has(key)) return;
    const controller = new AbortController();
    const entry = { controller, fatal: null, ready: false, done: null };
    receivers.set(key, entry);
    entry.done = track(connectLoop(binding, entry)).finally(() => {
      if (receivers.get(key) === entry) receivers.delete(key);
    }).catch(() => {});
  };

  const assertGeneration = (binding, generation) => {
    if (generation === null) return;
    if (closed || service.channelPage(binding.assistant_id, { tipOnly: true }).generation !== generation) {
      throw new ChannelError('cancelled');
    }
  };

  const processIncoming = async (binding, generation) => {
    for (const receipt of store.pending(binding.epoch)) {
      if (!isCurrent(binding)) return;
      const live = store.get(binding.assistant_id, binding.provider);
      if (!live || live.epoch !== binding.epoch || isSticky(live)) return;
      if (!receipt.text && !receipt.payload) {
        store.enqueue(binding.epoch, `${receipt.id}:empty`, feedback(binding.language, 'empty'), receipt.target);
        store.finishTurn(receipt.id);
        continue;
      }
      try {
        assertGeneration(binding, generation);
        const parts = [];
        if (receipt.text) parts.push({ type: 'text', text: receipt.text });
        if (receipt.payload) parts.push({ type: 'text', text: receipt.payload });
        await refreshAllowedRoots();
        if (!isCurrent(binding)) return;
        assertGeneration(binding, generation);
        const ready = store.get(binding.assistant_id, binding.provider);
        if (!ready || ready.epoch !== binding.epoch || isSticky(ready)) return;
        // Fence the crash gap before admitting. Restart never replays admitted tools.
        store.markInbox(receipt.id, 'admitted');
        const result = await service.send(binding.assistant_id, {
          messageID: receipt.id,
          parts,
          language: binding.language,
        });
        if (isCurrent(binding) && result?.replayed) {
          store.enqueue(binding.epoch, `${receipt.id}:interrupted`, feedback(binding.language, 'interrupted'), receipt.target);
          store.finishTurn(receipt.id);
        }
      } catch {
        if (!isCurrent(binding)) return;
        const failed = store.get(binding.assistant_id, binding.provider);
        if (!failed || failed.epoch !== binding.epoch || isSticky(failed)) return;
        store.enqueue(binding.epoch, `${receipt.id}:failed`, feedback(binding.language, 'failed'), receipt.target);
        store.finishTurn(receipt.id);
      }
    }
  };

  const enqueuePage = (binding, page) => {
    if (!binding.owner_id && !binding.target) {
      store.collect(binding, page, [], clock());
      return;
    }
    const deliveries = page.messages.flatMap((message) => {
      const receipt = store.receipt(message.turnID, binding.epoch);
      if (isMessageChannelTurn(message.turnID) && !receipt) return [];
      // A channel reply uses its own durable sender, not another later sender.
      if (receipt && !receipt.target && !binding.owner_id) return [];
      const text = message.status === 'error' ? feedback(binding.language, 'failed')
        : message.text?.trim() && !message.text.trim().startsWith('oc.settle.') ? message.text.trim()
          : message.cards.map((card) => card.title || card.name || '').filter(Boolean).join('\n');
      return chunkText(text).filter(Boolean).map((chunk, index) => ({
        id: `yuri_${digest(`${binding.epoch}:${page.generation}:${message.messageID}:${index}`)}`,
        text: chunk,
        ...(receipt ? { target: receipt.target || '' } : {}),
      }));
    });
    store.collect(binding, page, deliveries, clock());
  };

  const flush = async (binding) => {
    const key = channelKey(binding.assistant_id, binding.provider);
    const adapter = adapters[binding.provider];
    const initial = receivers.get(key);
    // Never send before the adapter has authenticated this connection; a
    // reconnect keeps rows durable and onReady resumes the same ordered queue.
    if (!initial?.ready) return;
    for (;;) {
      if (closed || !isCurrent(binding)) return;
      const receiver = receivers.get(key);
      if (!receiver?.ready) return;
      const row = store.get(binding.assistant_id, binding.provider);
      if (!row || row.epoch !== binding.epoch || isSticky(row)) return;
      const delivery = store.nextDelivery(binding.epoch);
      if (!delivery) return;
      // Head-of-line ordering: unknown/blocked rows are never bypassed. retry
      // may re-queue a definitively failed row, but never an unknown one.
      if (delivery.state !== 'pending') return;
      if (!adapter) {
        store.patch(binding.epoch, { status: 'error', error: 'unsupported_provider', updated_at: clock() });
        return;
      }
      store.markDelivery(delivery.id, 'sending');
      const signal = AbortSignal.any([lifetime.signal, receiver.controller.signal]);
      try {
        await adapter.send({
          config: configOf(row),
          target: parseTarget(delivery.target),
          text: delivery.text,
          id: delivery.id,
          signal,
        });
        if (!isCurrent(binding)) {
          if (store.get(binding.assistant_id, binding.provider)?.epoch === binding.epoch) {
            // The platform may have accepted it; never retry automatically.
            store.markDelivery(delivery.id, 'unknown');
            store.patch(binding.epoch, { error: 'delivery_unknown', updated_at: clock() });
          }
          return;
        }
        store.sent(delivery.id);
        store.patch(binding.epoch, {
          error: settledError(binding.epoch, row.error),
          updated_at: clock(),
        });
      } catch (error) {
        if (!isCurrent(binding)) {
          if (store.get(binding.assistant_id, binding.provider)?.epoch === binding.epoch) {
            // A crash/abort during send is indeterminate, not a safe retry.
            store.markDelivery(delivery.id, 'unknown');
            store.patch(binding.epoch, { error: 'delivery_unknown', updated_at: clock() });
          }
          return;
        }
        const code = safeError(error);
        if (STICKY_ERRORS.has(code)) {
          store.markDelivery(delivery.id, 'blocked');
          receiver.ready = false;
          receiver.controller.abort();
          store.patch(binding.epoch, { status: 'error', error: code, updated_at: clock() });
        } else if (code === 'delivery_unknown' || error?.ambiguous) {
          store.markDelivery(delivery.id, 'unknown');
          store.patch(binding.epoch, { error: 'delivery_unknown', updated_at: clock() });
        } else {
          store.failDelivery(delivery.id);
          // A send failure never proves the connection is ready/connected.
          store.patch(binding.epoch, {
            error: store.hasBlocked(binding.epoch) ? 'delivery_failed' : code,
            updated_at: clock(),
          });
        }
        return;
      }
    }
  };

  const processBinding = async (binding) => {
    if (!isCurrent(binding)) return;
    let page;
    try {
      page = service.channelPage(binding.assistant_id, {
        afterOrdinal: binding.ordinal,
        generation: binding.generation,
      });
    } catch (error) {
      if (error?.code === 'not_found') { await forget(binding.assistant_id); return; }
      throw error;
    }
    if (!isCurrent(binding)) return;
    enqueuePage(binding, page);
    const key = channelKey(binding.assistant_id, binding.provider);
    if (!inboundWork.has(key)) {
      const work = track(processIncoming(binding, page.generation)).catch((error) => setError(binding, error));
      inboundWork.set(key, work);
      void work.finally(() => {
        if (inboundWork.get(key) === work) inboundWork.delete(key);
      }).catch(() => {});
    }
    await flush(binding);
  };

  let ticking = false;
  let pendingTick = false;
  const tick = async () => {
    if (closed) return;
    if (ticking) { pendingTick = true; return; }
    ticking = true;
    try {
      ownsLease = store.acquire(owner, clock());
      if (!ownsLease) {
        for (const key of [...receivers.keys()]) stopReceiver(key);
        return;
      }
      const bindings = store.listAll();
      const keys = new Set(bindings.map((binding) => channelKey(binding.assistant_id, binding.provider)));
      for (const key of [...receivers.keys()]) if (!keys.has(key)) stopReceiver(key);
      for (const binding of bindings) {
        if (!recovered.has(binding.epoch)) {
          store.recover(binding.epoch, feedback(binding.language, 'interrupted'));
          if (store.hasUnknown(binding.epoch)) {
            store.patch(binding.epoch, { error: 'delivery_unknown', updated_at: clock() });
          }
          recovered.add(binding.epoch);
        }
        const key = channelKey(binding.assistant_id, binding.provider);
        if (retiring.has(key) || isSticky(binding)) continue;
        if (!receivers.has(key)) startReceiver(binding);
      }
      // One slow Bot cannot prevent another account receiving or replying.
      await Promise.allSettled(bindings.map((binding) => {
        const key = channelKey(binding.assistant_id, binding.provider);
        if (bindingWork.has(key) || retiring.has(key)) return undefined;
        const work = processBinding(binding).catch((error) => setError(binding, error));
        bindingWork.set(key, work);
        return work.finally(() => {
          if (bindingWork.get(key) === work) bindingWork.delete(key);
        });
      }));
    } finally {
      ticking = false;
      if (pendingTick && !closed) {
        pendingTick = false;
        void track(tick());
      }
    }
  };

  const status = (assistantID, provider) => {
    assertProvider(provider);
    // Routes already validate the Bot; this also rejects deleted Bots.
    service.channelPage(assistantID, { tipOnly: true });
    const base = { provider, transport: 'websocket' };
    const row = store.get(assistantID, provider);
    if (!row) {
      const sources = store.listAll().filter((candidate) => candidate.provider === provider && candidate.assistant_id !== assistantID);
      const names = sources.length ? new Map(service.snapshot().assistants.map((bot) => [bot.id, bot.name])) : new Map();
      const transferSources = sources.filter((source) => names.has(source.assistant_id)).map((source) => ({
        assistantID: source.assistant_id, name: names.get(source.assistant_id), revision: source.epoch, clientID: source.client_id,
      }));
      return { ...base, status: 'disconnected', error: null, configured: false, hasSecret: false,
        ...(transferSources.length ? { transferSources } : {}) };
    }
    const identity = {
      configured: true,
      clientID: row.client_id,
      ownerID: row.owner_id,
      hasSecret: Boolean(row.client_secret),
    };
    if (!adapters[provider]) {
      return { ...base, ...identity, status: 'error', error: 'unsupported_provider' };
    }
    if (!ownsLease || !store.owns(owner, clock())) {
      return { ...base, ...identity, status: 'reconnecting', error: 'channel_in_use' };
    }
    return {
      ...base,
      ...identity,
      status: row.status,
      error: derivedError(row),
    };
  };

  const save = async (assistantID, provider, input) => {
    assertProvider(provider);
    assertOwner();
    if (!adapters[provider]) throw new ChannelError('unsupported_provider');
    service.channelPage(assistantID, { tipOnly: true });
    const existing = store.get(assistantID, provider);
    const clientIDField = exactField(input?.clientID, MAX_ACCOUNT_FIELD);
    const ownerIDField = exactField(input?.ownerID, MAX_ACCOUNT_FIELD);
    const secret = typeof input?.clientSecret === 'string' ? input.clientSecret.trim() : '';
    const language = typeof input?.language === 'string' && input.language.trim()
      ? input.language.trim().slice(0, 32) : 'en';
    if (clientIDField.invalid || ownerIDField.invalid || secret.length > MAX_SECRET
      || !clientIDField.value || (input?.ownerID !== undefined && typeof input.ownerID !== 'string')) {
      throw new ChannelError('validation_error');
    }
    const clientID = clientIDField.value;
    const ownerID = ownerIDField.value;
    const accountChanged = Boolean(existing && existing.client_id !== clientID);
    // A new account must bring its own secret; never reuse a previous account's
    // credential after the client ID changes.
    if (!existing && !secret) throw new ChannelError('validation_error');
    if (accountChanged && !secret) throw new ChannelError('validation_error');
    const clientSecret = secret || existing.client_secret;
    const sameIdentity = Boolean(existing && !accountChanged && existing.owner_id === ownerID);
    const expectedEpoch = existing?.epoch ?? null;
    const key = channelKey(assistantID, provider);
    if (retiring.has(key)) throw new ChannelError('channel_in_use');
    const account = store.listAll().find((row) => row.provider === provider && row.client_id === clientID);
    if (account && account.assistant_id !== assistantID) throw new ChannelError('account_in_use');
    retiring.add(key);
    let bound = false;
    try {
      await stopReceiver(key);
      await Promise.allSettled([bindingWork.get(key), inboundWork.get(key)]);
      assertOwner();
      const live = store.get(assistantID, provider);
      if (expectedEpoch === null ? Boolean(live) : live?.epoch !== expectedEpoch) {
        throw new ChannelError('binding_changed');
      }
      if (live) store.recoverSending(live.epoch);
      const page = service.channelPage(assistantID, { tipOnly: true });
      const next = store.bind({
        assistant_id: assistantID,
        provider,
        client_id: clientID,
        client_secret: clientSecret,
        owner_id: ownerID,
        language,
        // Same owner/account keeps its watermark. A new owner or account starts
        // at the current transcript tip, so replies from the disconnected
        // previous owner are never leaked to the new destination.
        generation: sameIdentity ? live.generation : page.generation,
        ordinal: sameIdentity ? live.ordinal : page.tipOrdinal,
        updated_at: clock(),
      });
      // This process already drained and owns the migrated receipts. Do not run
      // crash recovery on the rotated epoch and falsely report an interruption
      // for work that is still admitted.
      recovered.add(next.epoch);
      bound = true;
    } finally {
      retiring.delete(key);
      // Account conflict, a failed write or a stale binding must not strand the
      // previous receiver; resume it from its untouched row.
      if (!bound && !closed) void track(tick());
    }
    void track(tick());
    return status(assistantID, provider);
  };

  const transfer = async (assistantID, provider, input) => {
    assertProvider(provider);
    assertOwner();
    if (!adapters[provider]) throw new ChannelError('unsupported_provider');
    const { sourceAssistantID, revision } = input ?? {};
    if (typeof sourceAssistantID !== 'string' || typeof revision !== 'string'
      || !sourceAssistantID || !revision || sourceAssistantID === assistantID) throw new ChannelError('validation_error');
    service.channelPage(assistantID, { tipOnly: true });
    service.channelPage(sourceAssistantID, { tipOnly: true });
    const source = store.get(sourceAssistantID, provider);
    if (!source || source.epoch !== revision || store.get(assistantID, provider)) throw new ChannelError('binding_changed');
    const keys = [channelKey(sourceAssistantID, provider), channelKey(assistantID, provider)];
    if (keys.some((key) => retiring.has(key))) throw new ChannelError('channel_in_use');
    for (const key of keys) retiring.add(key);
    try {
      await Promise.allSettled(keys.flatMap((key) => [stopReceiver(key), bindingWork.get(key), inboundWork.get(key)]));
      assertOwner();
      service.channelPage(sourceAssistantID, { tipOnly: true });
      const page = service.channelPage(assistantID, { tipOnly: true });
      const moved = store.transfer({ sourceAssistantID, assistantID, provider, revision,
        generation: page.generation, ordinal: page.tipOrdinal, updatedAt: clock() });
      recovered.add(moved.epoch);
    } finally {
      for (const key of keys) retiring.delete(key);
      if (!closed) void track(tick());
    }
    return status(assistantID, provider);
  };

  const retry = async (assistantID, provider) => {
    assertProvider(provider);
    assertOwner();
    if (!adapters[provider]) throw new ChannelError('unsupported_provider');
    service.channelPage(assistantID, { tipOnly: true });
    const key = channelKey(assistantID, provider);
    if (retiring.has(key)) throw new ChannelError('channel_in_use');
    const binding = store.get(assistantID, provider);
    if (!binding) throw new ChannelError('not_found');
    const expectedEpoch = binding.epoch;
    retiring.add(key);
    try {
      await stopReceiver(key);
      await Promise.resolve(bindingWork.get(key)).catch(() => {});
      assertOwner();
      const live = store.get(assistantID, provider);
      if (!live) throw new ChannelError('not_found');
      if (live.epoch !== expectedEpoch) throw new ChannelError('binding_changed');
      // Explicit reconnect only. Blocked (definitely failed) replies may retry,
      // but an indeterminate send stays unknown and is never automatically resent.
      store.retry(live.epoch);
      store.patch(live.epoch, {
        status: 'reconnecting',
        error: store.hasUnknown(live.epoch) ? 'delivery_unknown' : null,
        updated_at: clock(),
      });
    } finally {
      retiring.delete(key);
      // Even a failed revalidation must not leave the previous lane stopped.
      if (!closed) void track(tick());
    }
    return status(assistantID, provider);
  };

  const disconnect = async (assistantID, provider) => {
    assertProvider(provider);
    assertOwner();
    service.channelPage(assistantID, { tipOnly: true });
    const key = channelKey(assistantID, provider);
    if (retiring.has(key)) throw new ChannelError('channel_in_use');
    const binding = store.get(assistantID, provider);
    const expectedEpoch = binding?.epoch ?? null;
    retiring.add(key);
    try {
      const done = stopReceiver(key);
      await Promise.allSettled([
        done,
        bindingWork.get(key),
        inboundWork.get(key),
      ]);
      assertOwner();
      const live = store.get(assistantID, provider);
      if (live && live.epoch !== expectedEpoch) throw new ChannelError('binding_changed');
      // Deletes local credentials and queues only; already admitted model work
      // continues server-side and is not cancelled.
      if (live) store.unlink(assistantID, provider);
    } finally {
      retiring.delete(key);
      if (!closed) void track(tick());
    }
    return status(assistantID, provider);
  };

  const forget = async (assistantID) => {
    if (closed) return;
    if (!ownsLease) ownsLease = store.acquire(owner, clock());
    if (!ownsLease || !store.owns(owner, clock())) return;
    const rows = store.listByAssistant(assistantID);
    if (!rows.length) return;
    const keys = rows.map((row) => channelKey(assistantID, row.provider));
    for (const key of keys) retiring.add(key);
    try {
      const done = keys.map((key) => stopReceiver(key));
      await Promise.allSettled([
        ...done,
        ...keys.map((key) => bindingWork.get(key)),
        ...keys.map((key) => inboundWork.get(key)),
      ]);
      store.forget(assistantID);
    } finally {
      for (const key of keys) retiring.delete(key);
    }
  };

  const onTurnEvent = (event) => {
    if (closed || !ownsLease) return;
    const type = event?.type;
    const properties = event?.properties ?? event;
    if (type !== 'yuri:contact-turn-end') return;
    const turnID = properties?.turnID;
    if (typeof turnID !== 'string' || !turnID) return;
    // Receipts map 1:1 to durable user message IDs.
    const result = store.finishTurn(turnID);
    // Do not schedule channel work for unrelated contact turns in this Host.
    if (result.changes) void track(tick());
  };

  const timer = setInterval(() => { void track(tick()); }, intervalMs);
  timer.unref?.();
  void track(tick());

  return {
    status,
    save: (assistantID, provider, input) => track(save(assistantID, provider, input)),
    transfer: (assistantID, provider, input) => track(transfer(assistantID, provider, input)),
    retry: (assistantID, provider) => track(retry(assistantID, provider)),
    disconnect: (assistantID, provider) => track(disconnect(assistantID, provider)),
    forget: (assistantID) => track(forget(assistantID)),
    onTurnEvent,
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      clearInterval(timer);
      lifetime.abort();
      for (const key of [...receivers.keys()]) stopReceiver(key);
      // Drain channel operations before the owning assistant service closes.
      closePromise = Promise.allSettled([...operations]).then(() => {
        store.release(owner);
        store.close();
      });
      return closePromise;
    },
  };
}

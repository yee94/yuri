import { WSClient } from '@wecom/aibot-node-sdk';
import { Message, NotImplementedError, parseMarkdown, stringifyMarkdown } from 'chat';
import { channelError } from './transport.js';

/**
 * WeCom smart-bot adapter on the official `@wecom/aibot-node-sdk`.
 *
 * The official `WSClient` owns the WebSocket, authentication, heartbeat,
 * reconnect and the per-`req_id` ACK queue. This adapter only projects messages,
 * enforces the owner private-chat scope and maps SDK events/Acks onto Yuri's
 * safe channel errors.
 */

const THREAD_PREFIX = 'wecom:';
const INIT_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_RESOURCES = 8;
const MAX_NAME_CHARS = 120;

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function truncate(value, limit = MAX_TEXT_CHARS) {
  if (!nonEmptyString(value)) return '';
  return Array.from(value).slice(0, limit).join('');
}

function truncateName(value) {
  if (!nonEmptyString(value)) return undefined;
  return Array.from(value).slice(0, MAX_NAME_CHARS).join('');
}

function credentialKey(clientID, clientSecret) {
  return `${clientID}\u0000${clientSecret}`;
}

function isYuriError(error) {
  return typeof error?.code === 'string' && typeof error?.ambiguous === 'boolean';
}

/** Inert logger: the SDK logs frame bodies and IDs, so nothing is forwarded. */
function noopLogger() {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

function requireConfig(config) {
  if (!config || typeof config !== 'object') throw channelError('invalid_response');
  if (!nonEmptyString(config.clientID) || !nonEmptyString(config.clientSecret)) {
    throw channelError('invalid_response');
  }
  if (config.ownerID !== undefined && typeof config.ownerID !== 'string') throw channelError('invalid_response');
  return { clientID: config.clientID, clientSecret: config.clientSecret, ownerID: config.ownerID ?? '' };
}

function threadIdOf(chatType, id) {
  return `${THREAD_PREFIX}${chatType}:${id}`;
}

function decodeThreadId(threadId) {
  if (typeof threadId !== 'string' || !threadId.startsWith(THREAD_PREFIX)) throw channelError('invalid_response');
  const rest = threadId.slice(THREAD_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) throw channelError('invalid_response');
  const chatType = rest.slice(0, separator);
  const id = rest.slice(separator + 1);
  if ((chatType !== 'private' && chatType !== 'group') || !id) throw channelError('invalid_response');
  return { chatType, id };
}

function resourceName(body) {
  return truncateName(body?.file?.filename ?? body?.file?.name);
}

function inboundContent(body, msgtype) {
  if (msgtype === 'text') return { text: truncate(body?.text?.content), resources: [] };
  if (msgtype === 'voice') {
    const transcript = truncate(body?.voice?.content);
    return transcript
      ? { text: transcript, resources: [], transcript: 'platform' }
      : { text: '', resources: [{ type: 'audio' }] };
  }
  if (msgtype === 'image') return { text: '', resources: [{ type: 'image' }] };
  if (msgtype === 'video') return { text: '', resources: [{ type: 'video' }] };
  if (msgtype === 'file') {
    const name = resourceName(body);
    return { text: '', resources: [{ type: 'file', ...(name ? { name } : {}) }] };
  }
  if (msgtype === 'mixed') {
    const lines = [];
    const resources = [];
    const items = Array.isArray(body?.mixed?.msg_item) ? body.mixed.msg_item.slice(0, 64) : [];
    for (const item of items) {
      if (item?.msgtype === 'text') {
        const line = truncate(item?.text?.content);
        if (line) lines.push(line);
      } else if (item?.msgtype === 'image') {
        resources.push({ type: 'image' });
      }
    }
    return { text: lines.join('\n'), resources };
  }
  return { text: '', resources: [] };
}

function readBody(body) {
  if (!body || typeof body !== 'object') return null;
  const senderID = body?.from?.userid;
  if (!nonEmptyString(senderID)) return null;
  const msgtype = nonEmptyString(body.msgtype) ? body.msgtype : '';
  if (!['single', 'group'].includes(body.chattype) || !nonEmptyString(body.msgid)) return null;
  const chatType = body.chattype === 'group' ? 'group' : 'private';
  const chatID = chatType === 'group' ? String(body.chatid ?? senderID) : senderID;
  const content = inboundContent(body, msgtype);
  const createdAt = Number(body.create_time);
  return {
    id: String(body.msgid ?? ''),
    senderID,
    chatType,
    chatID,
    threadId: threadIdOf(chatType, chatID),
    msgtype,
    text: truncate(content.text),
    resources: content.resources.slice(0, MAX_RESOURCES),
    transcript: content.transcript,
    createdAt: Number.isFinite(createdAt) && createdAt > 0
      ? new Date(createdAt > 1e12 ? createdAt : createdAt * 1000)
      : new Date(),
  };
}

/** Public raw projection: no download URL, aeskey, response_url or quote body. */
function sanitizeRaw(data) {
  const raw = {
    msgid: data.id,
    chattype: data.chatType === 'group' ? 'group' : 'single',
    from: { userid: data.senderID },
    msgtype: data.msgtype,
  };
  if (data.chatType === 'group') raw.chatid = data.chatID;
  if (data.text) raw.text = { content: data.text };
  if (data.transcript) raw.voice = { content: data.text };
  if (data.resources.length > 0) raw.attachments = data.resources;
  return raw;
}

function buildMessage(data) {
  return new Message({
    id: data.id,
    threadId: data.threadId,
    text: data.text,
    formatted: parseMarkdown(data.text),
    raw: sanitizeRaw(data),
    author: {
      userId: data.senderID,
      userName: data.senderID,
      fullName: data.senderID,
      isBot: false,
      isMe: false,
    },
    metadata: {
      dateSent: data.createdAt,
      edited: false,
      platform: 'wecom',
      ...(data.transcript ? { transcript: 'platform' } : {}),
      ...(data.resources.length > 0 ? { notDownloaded: true } : {}),
    },
    attachments: data.resources,
  });
}

/** Yuri projection used by the runtime. Metadata is public-only. */
function buildProjection(data) {
  return {
    id: data.id,
    senderID: data.senderID,
    chatType: 'private',
    text: data.text,
    metadata: {
      platform: 'wecom',
      chatType: 'private',
      ...(data.transcript ? { transcript: 'platform' } : {}),
      ...(data.resources.length > 0 ? { notDownloaded: true, resources: data.resources } : {}),
    },
  };
}

/** Accept standard Chat postables only; cards/unknown shapes are explicit. */
function messageText(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') {
    throw new NotImplementedError('wecom: unsupported postable message', 'postMessage');
  }
  if (message.files?.length || message.attachments?.length) throw new NotImplementedError('wecom: media sending is not supported');
  if (typeof message.raw === 'string') return message.raw;
  if (typeof message.markdown === 'string') return message.markdown;
  if (message.ast) return stringifyMarkdown(message.ast);
  throw new NotImplementedError('wecom: unsupported postable message', 'postMessage');
}

function lifecycleCode(error) {
  if (error?.code === 'WS_AUTH_FAILURE_EXHAUSTED') return 'auth_expired';
  if (error?.code === 'WS_RECONNECT_EXHAUSTED') return 'reconnect_exhausted';
  if (/Authentication failed/i.test(String(error?.message ?? ''))) return 'auth_expired';
  return 'network_error';
}

/**
 * Map an official `sendMessage` rejection.
 * - non-zero ACK frame: definite failure
 * - not connected before the write: definite network failure
 * - timeout / close / manual abort: unknown (the frame may be on the wire)
 */
function sendError(error) {
  if (error && typeof error === 'object' && Number.isFinite(error.errcode)) {
    return error.errcode === 0 ? null : channelError('delivery_failed');
  }
  if (error?.code === 'WS_AUTH_FAILURE_EXHAUSTED') return channelError('auth_expired');
  if (/Authentication failed/i.test(String(error?.message ?? ''))) return channelError('auth_expired');
  if (/WebSocket not connected/i.test(String(error?.message ?? ''))) return channelError('network_error');
  return channelError('delivery_unknown', true);
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      // The frame may already be on the wire; never retry automatically.
      reject(channelError('delivery_unknown', true));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export class WecomChatAdapter {
  name = 'wecom';

  userName;

  persistMessageHistory = false;

  constructor({
    clientId,
    clientSecret,
    userName,
    ownerId,
    wsUrl,
    wsOptions,
    reconnectInterval,
    maxReconnectAttempts,
    maxAuthFailureAttempts,
    requestTimeout,
  } = {}) {
    this.clientId = nonEmptyString(clientId) ? clientId : undefined;
    this.clientSecret = nonEmptyString(clientSecret) ? clientSecret : undefined;
    this.ownerId = nonEmptyString(ownerId) ? ownerId : undefined;
    this.userName = nonEmptyString(userName) ? userName : 'Yuri';
    this.wsUrl = wsUrl;
    this.wsOptions = wsOptions;
    this.reconnectInterval = reconnectInterval;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.maxAuthFailureAttempts = maxAuthFailureAttempts;
    this.requestTimeout = requestTimeout;
    this.chat = null;
    this.client = null;
    this.controller = null;
    this.handle = null;
    this.ready = false;
    this.replaced = false;
    this.fatal = null;
  }

  // ── Chat SDK Adapter contract ────────────────────────────────────────────

  async initialize(chat) {
    if (this.client) throw channelError('channel_in_use');
    this.chat = chat ?? null;
    const controller = new AbortController();
    this.controller = controller;
    const handle = await this._open({
      signal: controller.signal,
      onReady: () => {},
      onError: () => {},
      onMessage: (projection, message) => this.chat?.processMessage?.(
        this,
        message.threadId,
        () => Promise.resolve(message),
      ),
    });
    this.handle = handle;
    void handle.done.then(() => {
      if (this.handle === handle) {
        this.handle = null;
        this.controller = null;
        void handle.close();
      }
    });
  }

  encodeThreadId(data) {
    const chatType = data?.chatType === 'group' ? 'group' : 'private';
    const id = data?.id ?? data?.chatId;
    if (!nonEmptyString(id)) throw channelError('invalid_response');
    return threadIdOf(chatType, id);
  }

  decodeThreadId(threadId) {
    return decodeThreadId(threadId);
  }

  channelIdFromThreadId(threadId) {
    return decodeThreadId(threadId).id;
  }

  isDM(threadId) {
    return decodeThreadId(threadId).chatType === 'private';
  }

  openDM(userId) {
    return threadIdOf('private', userId);
  }

  async handleWebhook() {
    return new Response(JSON.stringify({ error: 'wecom adapter is long-connection only; webhook not supported' }), {
      status: 501,
      headers: { 'content-type': 'application/json' },
    });
  }

  parseMessage(raw) {
    const data = readBody(raw?.body ?? raw);
    if (!data) throw channelError('invalid_response');
    return buildMessage(data);
  }

  renderFormatted(content) {
    if (typeof content === 'string') return content;
    if (content && typeof content === 'object' && content.type === 'root') return stringifyMarkdown(content);
    return messageText(content);
  }

  async postMessage(threadId, message) {
    const { chatType, id } = decodeThreadId(threadId);
    if (chatType !== 'private') {
      throw new NotImplementedError('wecom: group messages are not supported; only the owner private chat', 'postMessage');
    }
    if (this.ownerId && id !== this.ownerId) throw channelError('invalid_response');
    const text = messageText(message);
    const ack = await this.send({ config: { clientID: this.clientId, clientSecret: this.clientSecret, ownerID: this.ownerId }, target: { userID: id }, text });
    return { id: ack.headers?.req_id ?? '', threadId, raw: {} };
  }

  async editMessage() {
    throw new NotImplementedError('wecom: editMessage is not supported', 'editMessage');
  }

  async deleteMessage() {
    throw new NotImplementedError('wecom: deleteMessage is not supported', 'deleteMessage');
  }

  async fetchMessages() {
    throw new NotImplementedError('wecom: fetchMessages is not supported', 'fetchMessages');
  }

  async fetchThread() {
    throw new NotImplementedError('wecom: fetchThread is not supported', 'fetchThread');
  }

  async addReaction() {
    throw new NotImplementedError('wecom: addReaction is not supported', 'addReaction');
  }

  async removeReaction() {
    throw new NotImplementedError('wecom: removeReaction is not supported', 'removeReaction');
  }

  async startTyping() {
    throw new NotImplementedError('wecom: typing indicators are not supported', 'startTyping');
  }

  async disconnect() {
    this.controller?.abort();
    const handle = this.handle;
    this.handle = null;
    this.controller = null;
    await handle?.close?.();
  }

  // ── Yuri channel bridge ─────────────────────────────────────────────────

  async connect({ config, signal, onReady, onMessage, onError } = {}) {
    const normalized = requireConfig(config);
    if ((this.ownerId ?? '') !== (normalized.ownerID ?? '')) throw channelError('invalid_response');
    if (this.client) throw channelError('channel_in_use');

    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    this.controller = controller;

    try {
      const handle = await this._open({
        signal: controller.signal,
        onReady,
        onError,
        onMessage: (projection) => onMessage?.(projection),
      });
      this.handle = handle;
      await handle.done;
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      this.controller = null;
      const handle = this.handle;
      this.handle = null;
      await handle?.close?.();
    }
  }

  async send({ config, target, text, signal } = {}) {
    const normalized = requireConfig(config);
    const chatId = this.ownerId || target?.userID;
    if (!nonEmptyString(chatId)) throw channelError('invalid_response');
    // A caller-supplied target can never move an owner-bound assistant.
    if (this.ownerId && target?.userID && target.userID !== this.ownerId) throw channelError('invalid_response');
    if ((this.ownerId ?? '') !== (normalized.ownerID ?? '')) throw channelError('invalid_response');

    if (signal?.aborted) throw channelError('cancelled');
    const client = this.client;
    if (!client || !client.isConnected || !this.ready) throw channelError('network_error');

    const content = typeof text === 'string' ? text : '';
    let frame;
    try {
      // `sendMessage` resolves only after the platform ACK with errcode 0.
      frame = await withAbort(client.sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content },
      }), signal);
    } catch (error) {
      throw sendError(error) ?? channelError('delivery_unknown', true);
    }
    if (!frame || frame.errcode !== 0) throw channelError('delivery_failed');
    return frame;
  }

  // ── internals ───────────────────────────────────────────────────────────

  _createClient() {
    if (!this.clientId || !this.clientSecret) throw channelError('invalid_response');
    return new WSClient({
      botId: this.clientId,
      secret: this.clientSecret,
      ...(nonEmptyString(this.wsUrl) ? { wsUrl: this.wsUrl } : {}),
      ...(this.wsOptions ? { wsOptions: this.wsOptions } : {}),
      ...(this.reconnectInterval != null ? { reconnectInterval: this.reconnectInterval } : {}),
      ...(this.maxReconnectAttempts != null ? { maxReconnectAttempts: this.maxReconnectAttempts } : {}),
      ...(this.maxAuthFailureAttempts != null ? { maxAuthFailureAttempts: this.maxAuthFailureAttempts } : {}),
      ...(this.requestTimeout != null ? { requestTimeout: this.requestTimeout } : {}),
      logger: noopLogger(),
    });
  }

  _deliver(frame, onMessage, onError) {
    const data = readBody(frame?.body);
    // Group chats are never executed; the runtime remains owner-private only.
    if (!data || data.chatType !== 'private') return;
    if (this.ownerId && data.senderID !== this.ownerId) return;
    const message = buildMessage(data);
    const projection = buildProjection(data);
    let result;
    try {
      result = onMessage?.(projection, message);
    } catch {
      onError?.(channelError('network_error'));
      return;
    }
    if (result && typeof result.then === 'function') {
      result.catch(() => onError?.(channelError('network_error')));
    }
  }

  async _open({ signal, onReady, onError, onMessage }) {
    const client = this._createClient();
    let closed = false;
    let phase = 'connecting';
    let fatal = null;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const cleanups = [];
    let deadline;
    let onAbort;

    const bind = (event, handler) => {
      client.on(event, handler);
      cleanups.push(() => {
        try {
          client.off?.(event, handler) ?? client.removeListener(event, handler);
        } catch {}
      });
    };

    const close = async () => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      for (const off of cleanups.splice(0)) off();
      this.client = null;
      this.ready = false;
      resolveDone();
      try {
        client.disconnect();
      } catch {}
    };

    const settle = (error) => {
      if (closed) return;
      if (error?.code) fatal = error.code;
      if (phase === 'connecting') {
        phase = 'settled';
        rejectReady(error ?? channelError('network_error'));
      } else if (phase === 'live') {
        phase = 'settled';
        resolveDone();
      }
    };

    this.client = client;
    this.ready = false;
    this.replaced = false;
    this.fatal = null;

    bind('authenticated', () => {
      if (closed) return;
      clearTimeout(deadline);
      this.ready = true;
      try {
        onReady?.();
      } catch {}
      if (phase === 'connecting') {
        phase = 'live';
        resolveReady();
      }
    });

    bind('disconnected', (reason) => {
      if (closed) return;
      this.ready = false;
      if (/new connection established/i.test(String(reason ?? ''))) {
        this.replaced = true;
        onError?.(channelError('connection_replaced'));
        settle(channelError('connection_replaced'));
        return;
      }
      if (!this.replaced) onError?.(channelError('network_error'));
    });

    bind('reconnecting', () => {
      if (closed) return;
      this.ready = false;
      if (!this.replaced) onError?.(channelError('network_error'));
    });

    // Backup for the explicit server-replaced event.
    bind('event.disconnected_event', () => {
      if (closed) return;
      this.replaced = true;
      onError?.(channelError('connection_replaced'));
      settle(channelError('connection_replaced'));
    });

    bind('error', (error) => {
      if (closed) return;
      this.ready = false;
      const code = lifecycleCode(error);
      if (code === 'auth_expired') {
        this.fatal = 'auth_expired';
        onError?.(channelError('auth_expired'));
        settle(channelError('auth_expired'));
        return;
      }
      if (code === 'reconnect_exhausted') {
        onError?.(channelError('network_error'));
        settle(channelError('network_error'));
        return;
      }
      onError?.(channelError('network_error'));
    });

    bind('message', (frame) => {
      if (closed || !this.ready || this.replaced || this.fatal) return;
      this._deliver(frame, onMessage, onError);
    });

    deadline = setTimeout(() => settle(channelError('network_error')), INIT_TIMEOUT_MS);
    deadline.unref?.();
    onAbort = () => settle(channelError('cancelled'));
    if (signal?.aborted) {
      await close();
      throw channelError('cancelled');
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      client.connect();
    } catch (error) {
      await close();
      throw isYuriError(error) ? error : channelError('network_error');
    }

    try {
      await ready;
    } catch (error) {
      await close();
      throw error;
    }
    if (closed) throw channelError('cancelled');
    return { close, done, fatal: () => fatal };
  }
}

/**
 * Registry-facing factory. One official WSClient per bot credential; a second
 * live connection for the same credential is rejected instead of replacing the
 * first. Different accounts/credentials connect independently.
 */
export function createWecomSdkAdapter(options = {}) {
  const sessions = new Map();

  return {
    async connect(args = {}) {
      const config = requireConfig(args.config);
      const key = credentialKey(config.clientID, config.clientSecret);
      if (sessions.has(key)) throw channelError('channel_in_use');
      const adapter = new WecomChatAdapter({
        ...options,
        clientId: config.clientID,
        clientSecret: config.clientSecret,
        ownerId: config.ownerID,
      });
      const entry = { adapter };
      sessions.set(key, entry);
      try {
        await adapter.connect(args);
      } finally {
        if (sessions.get(key) === entry) sessions.delete(key);
      }
    },

    async send(args = {}) {
      const config = requireConfig(args.config);
      const entry = sessions.get(credentialKey(config.clientID, config.clientSecret));
      if (!entry) throw channelError('network_error');
      await entry.adapter.send(args);
    },
  };
}

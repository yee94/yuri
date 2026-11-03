import { Message, NotImplementedError, parseMarkdown, stringifyMarkdown } from 'chat';
import { channelError, requestJSON } from './transport.js';

/**
 * DingTalk adapter implementing the Chat SDK `Adapter` contract, backed by the
 * official `dingtalk-stream` long-connection client.
 *
 * Owner scope: only the configured owner's single chat is admitted. Group
 * threads are parsed as `group` and never reported as DMs, but outbound and
 * delivery support only the owner private chat.
 */

const DINGTALK_ORIGIN = 'https://api.dingtalk.com';
const TOKEN_PATH = '/v1.0/oauth2/accessToken';
const BATCH_SEND_PATH = '/v1.0/robot/oToMessages/batchSend';
const ROBOT_TOPIC = '/v1.0/im/bot/messages/get';
const TOKEN_EXPIRY_MARGIN_MS = 300_000;
const INIT_TIMEOUT_MS = 20_000;
const DISCONNECT_TIMEOUT_MS = 5_000;
const WATCHDOG_MS = 2_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_NAME_CHARS = 120;

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function truncate(value, limit = MAX_TEXT_CHARS) {
  if (!nonEmptyString(value)) return '';
  return Array.from(value).slice(0, limit).join('');
}

/** True only for Yuri channel errors, which always carry a boolean `ambiguous`. */
function isYuriError(error) {
  return typeof error?.code === 'string' && typeof error?.ambiguous === 'boolean';
}

function credentialKey(clientId, clientSecret) {
  return `${clientId}\u0000${clientSecret}`;
}

function sessionKey(config) {
  return `${config.clientID}\u0000${config.clientSecret}\u0000${config.ownerID}`;
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
    const onAbort = () => finish(reject, channelError('cancelled', ambiguous));
    const timer = setTimeout(() => finish(reject, channelError('network_error', ambiguous)), timeoutMs);
    timer.unref?.();
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

/** Accept every standard `AdapterPostableMessage` shape. */
function messageText(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  if (typeof message.raw === 'string') return message.raw;
  if (typeof message.markdown === 'string') return message.markdown;
  if (message.ast) return stringifyMarkdown(message.ast);
  return '';
}

function parseBody(frame) {
  if (!nonEmptyString(frame?.data)) return null;
  try {
    const parsed = JSON.parse(frame.data);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function attachmentType(msgtype) {
  if (msgtype === 'picture') return 'image';
  if (msgtype === 'audio') return 'audio';
  if (msgtype === 'video') return 'video';
  return 'file';
}

function richTextContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.text ?? item.content ?? '';
      return '';
    }).filter(Boolean).join('\n');
  }
  if (value && typeof value === 'object') return richTextContent(value.richText ?? value.text ?? value.content);
  return '';
}

/**
 * Public text projection. Platform speech recognition is used when the
 * platform supplies it; a media message without recognition never receives an
 * invented transcript.
 */
function bodyText(body) {
  const msgtype = nonEmptyString(body?.msgtype) ? body.msgtype : '';
  if (msgtype === 'text') return { text: truncate(body?.text?.content) };
  if (msgtype === 'audio') {
    const recognition = body?.audio?.content?.recognition
      ?? body?.audio?.recognition
      ?? body?.content?.recognition
      ?? body?.recognition;
    return nonEmptyString(recognition)
      ? { text: truncate(recognition), transcript: 'platform' }
      : { text: '' };
  }
  if (msgtype === 'richText') {
    const rich = richTextContent(body?.richText ?? body?.content);
    return rich ? { text: truncate(rich), format: 'richText' } : { text: '' };
  }
  if (msgtype === 'markdown') {
    return { text: truncate(body?.markdown?.text ?? body?.text?.content) };
  }
  return { text: '' };
}

function projectDingtalk(message, body, ownerID) {
  if (!message || !body || body.conversationType !== '1') return null;
  const senderID = message.author?.userId;
  if (!nonEmptyString(senderID) || (ownerID && senderID !== ownerID)) return null;
  if (nonEmptyString(body.chatbotUserId) && (body.chatbotUserId === body.senderId || body.chatbotUserId === senderID)) return null;
  const metadata = { platform: 'dingtalk', chatType: 'private' };
  const mediaType = nonEmptyString(body.msgtype) ? body.msgtype : '';
  const text = bodyText(body);
  if (text.transcript) metadata.transcript = text.transcript;
  if (text.format) metadata.format = text.format;
  if (mediaType && mediaType !== 'text' && mediaType !== 'richText' && mediaType !== 'markdown' && !text.transcript) {
    metadata.notDownloaded = true;
    metadata.mediaType = truncate(mediaType, 40);
  }
  const subject = truncate(body.content?.title, MAX_NAME_CHARS);
  if (subject) metadata.subject = subject;
  const attachments = (message.attachments ?? []).slice(0, 8).map((attachment) => {
    const projected = { type: attachment.type };
    const name = truncate(attachment.name, MAX_NAME_CHARS);
    if (name) projected.name = name;
    return projected;
  });
  if (attachments.length > 0) {
    metadata.notDownloaded = true;
    metadata.resources = attachments;
  }
  return {
    id: String(message.id ?? ''),
    senderID: String(senderID),
    chatType: 'private',
    text: truncate(text.text),
    metadata,
  };
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function ack(client, frame) {
  const messageId = frame?.headers?.messageId;
  if (!messageId || typeof client.socketCallBackResponse !== 'function') return;
  try {
    client.socketCallBackResponse(messageId, {});
  } catch {}
}

function credentialsFrom(config, fallback = {}) {
  const clientId = config?.clientID ?? fallback.clientId;
  const clientSecret = config?.clientSecret ?? fallback.clientSecret;
  if (!nonEmptyString(clientId) || !nonEmptyString(clientSecret)) throw channelError('invalid_response');
  return { clientId, clientSecret };
}

export class DingTalkChatAdapter {
  name = 'dingtalk';

  userName;

  persistMessageHistory = false;

  constructor({ clientId, clientSecret, userName, ownerId, clientFactory, fetchImpl = fetch, tokenCache } = {}) {
    this.clientId = nonEmptyString(clientId) ? clientId : undefined;
    this.clientSecret = nonEmptyString(clientSecret) ? clientSecret : undefined;
    this.ownerId = nonEmptyString(ownerId) ? ownerId : undefined;
    this.userName = nonEmptyString(userName) ? userName : 'Yuri';
    this.clientFactory = clientFactory;
    this.fetchImpl = fetchImpl;
    this.tokens = tokenCache instanceof Map ? tokenCache : new Map();
    this.chat = null;
    this.session = null;
  }

  // ── Chat SDK Adapter contract ───────────────────────────────────────────

  async initialize(chat) {
    const credentials = credentialsFrom(undefined, this);
    if (!nonEmptyString(this.ownerId)) throw channelError('invalid_response');
    if (this.session) throw channelError('channel_in_use');
    this.chat = chat;
    let lost = false;
    const session = await this._open({
      credentials,
      onLost: () => {
        lost = true;
        void this.disconnect();
      },
      deliver: async (body, message) => {
        if (body.conversationType !== '1' || message.author.userId !== this.ownerId) return true;
        await this.chat?.processMessage?.(this, message.threadId, () => Promise.resolve(message));
        return true;
      },
    });
    if (lost) {
      await settleQuietly(session.close());
      throw channelError('network_error');
    }
    this.session = session;
  }

  encodeThreadId(data) {
    const chatType = data?.chatType === 'group' ? 'group' : 'private';
    const id = nonEmptyString(data?.id) ? data.id : '';
    if (!id) throw channelError('invalid_response');
    return `dingtalk:${chatType}:${id}`;
  }

  decodeThreadId(threadId) {
    if (typeof threadId !== 'string' || !threadId.startsWith('dingtalk:')) throw channelError('invalid_response');
    const rest = threadId.slice('dingtalk:'.length);
    const separator = rest.indexOf(':');
    if (separator <= 0) throw channelError('invalid_response');
    const chatType = rest.slice(0, separator);
    const id = rest.slice(separator + 1);
    if ((chatType !== 'private' && chatType !== 'group') || !id) throw channelError('invalid_response');
    return { chatType, id };
  }

  channelIdFromThreadId(threadId) {
    return this.decodeThreadId(threadId).id;
  }

  isDM(threadId) {
    return this.decodeThreadId(threadId).chatType === 'private';
  }

  async handleWebhook() {
    return new Response(JSON.stringify({ error: 'dingtalk adapter is long-connection only; webhook not supported' }), {
      status: 501,
      headers: { 'content-type': 'application/json' },
    });
  }

  parseMessage(raw) {
    const body = raw ?? {};
    const senderID = nonEmptyString(body.senderStaffId) ? body.senderStaffId : String(body.senderId ?? '');
    const privateChat = body.conversationType === '1';
    const text = bodyText(body);
    const msgtype = nonEmptyString(body.msgtype) ? body.msgtype : '';
    const attachments = msgtype && msgtype !== 'text' && msgtype !== 'richText' && msgtype !== 'markdown' && !text.transcript
      ? [{
        type: attachmentType(msgtype),
        ...(nonEmptyString(body.content?.fileName) ? { name: truncate(body.content.fileName, MAX_NAME_CHARS) } : {}),
      }]
      : [];
    return new Message({
      id: String(body.msgId ?? ''),
      threadId: this.encodeThreadId({
        chatType: privateChat ? 'private' : 'group',
        id: privateChat ? senderID : String(body.conversationId ?? senderID),
      }),
      text: truncate(text.text),
      formatted: parseMarkdown(text.text),
      raw: body,
      author: {
        userId: senderID,
        userName: nonEmptyString(body.senderNick) ? body.senderNick : senderID,
        fullName: nonEmptyString(body.senderNick) ? body.senderNick : senderID,
        isBot: nonEmptyString(body.chatbotUserId) && body.chatbotUserId === body.senderId,
        isMe: false,
      },
      metadata: { dateSent: new Date(Number(body.createAt) || Date.now()), edited: false },
      attachments,
    });
  }

  async postMessage(threadId, message) {
    const { chatType, id } = this.decodeThreadId(threadId);
    if (chatType !== 'private') {
      throw new NotImplementedError('dingtalk: group messages are not supported; only the owner private chat', 'postMessage');
    }
    if (!nonEmptyString(this.ownerId) || id !== this.ownerId) throw channelError('invalid_response');
    const json = await this._sendText({ credentials: credentialsFrom(undefined, this), userId: this.ownerId, text: messageText(message) });
    return { id: String(json?.processQueryKey ?? ''), threadId, raw: json ?? {} };
  }

  async editMessage() {
    throw new NotImplementedError('dingtalk: editMessage is not supported', 'editMessage');
  }

  async deleteMessage() {
    throw new NotImplementedError('dingtalk: deleteMessage is not supported', 'deleteMessage');
  }

  async fetchMessages() {
    throw new NotImplementedError('dingtalk: fetchMessages is not supported', 'fetchMessages');
  }

  async fetchThread() {
    throw new NotImplementedError('dingtalk: fetchThread is not supported', 'fetchThread');
  }

  async addReaction() {
    throw new NotImplementedError('dingtalk: addReaction is not supported', 'addReaction');
  }

  async removeReaction() {
    throw new NotImplementedError('dingtalk: removeReaction is not supported', 'removeReaction');
  }

  async startTyping() {
    throw new NotImplementedError('dingtalk: typing indicators are not supported', 'startTyping');
  }

  renderFormatted(content) {
    if (typeof content === 'string') return content;
    if (content && typeof content === 'object' && content.type === 'root') return stringifyMarkdown(content);
    return messageText(content);
  }

  openDM(userId) {
    return this.encodeThreadId({ chatType: 'private', id: userId });
  }

  async disconnect() {
    const session = this.session;
    this.session = null;
    await settleQuietly(session?.close?.());
  }

  // ── Yuri channel bridge ────────────────────────────────────────────────

  async connect({ config, signal, onReady, onMessage, onError } = {}) {
    const credentials = credentialsFrom(config);
    if (config.ownerID !== undefined && typeof config.ownerID !== 'string') throw channelError('invalid_response');
    if ((this.ownerId ?? '') !== (config.ownerID ?? '')) throw channelError('invalid_response');
    signal?.throwIfAborted();
    if (this.session) throw channelError('channel_in_use');

    let settleLost;
    const lost = new Promise((resolve) => { settleLost = resolve; });
    let lostFlag = false;
    try {
      const session = await this._open({
        credentials,
        signal,
        onError,
        onLost: () => { lostFlag = true; settleLost('lost'); },
        deliver: async (body, message) => {
          const projected = projectDingtalk(message, body, config.ownerID);
          if (!projected) return true;
          await onMessage?.(projected);
          return true;
        },
      });
      this.session = session;
      if (signal?.aborted || lostFlag) {
        await this.disconnect();
        return;
      }
      onReady?.();
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', finish);
          this.disconnect().finally(resolve);
        };
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
        void lost.then(finish);
      });
    } catch (error) {
      await this.disconnect();
      throw isYuriError(error) ? error : channelError('network_error');
    }
  }

  async send({ config, target, text, signal } = {}) {
    const credentials = credentialsFrom(config);
    const userId = config.ownerID || target?.userID;
    if (!nonEmptyString(userId)) throw channelError('invalid_response');
    await this._sendText({ credentials, userId, text: typeof text === 'string' ? text : '', signal });
  }

  // ── internals ──────────────────────────────────────────────────────────

  async _createClient(credentials) {
    if (this.clientFactory) {
      return this.clientFactory({ clientId: credentials.clientId, clientSecret: credentials.clientSecret, ua: 'yuri' });
    }
    const { DWClient } = await import('dingtalk-stream');
    return new DWClient({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      ua: 'yuri',
      keepAlive: true,
      autoReconnect: false,
      subscriptions: [{ type: 'CALLBACK', topic: ROBOT_TOPIC }],
    });
  }

  async _open({ credentials, signal, deliver, onError, onLost }) {
    const client = await this._createClient(credentials);
    if (!client || typeof client.connect !== 'function' || typeof client.registerCallbackListener !== 'function') {
      throw channelError('invalid_response');
    }
    const deadline = Date.now() + INIT_TIMEOUT_MS;
    let closed = false;
    let ready = false;
    let lost = false;
    let watchdog;
    const session = {
      client,
      async close() {
        if (closed) return;
        closed = true;
        ready = false;
        clearInterval(watchdog);
        try {
          client.disconnect?.();
        } catch {}
      },
    };

    // `DWClient.connect()` awaits the endpoint request before creating the
    // socket, and swallows endpoint failures. Aborting during that window would
    // otherwise let a late socket open on a session we already released.
    const originalConnectSocket = typeof client._connect === 'function' ? client._connect.bind(client) : null;
    if (originalConnectSocket) {
      client._connect = (...args) => (closed
        ? Promise.reject(new Error('dingtalk session closed'))
        : originalConnectSocket(...args));
    }

    const originalOnSystem = typeof client.onSystem === 'function' ? client.onSystem.bind(client) : null;
    if (originalOnSystem) {
      client.onSystem = (...args) => {
        try {
          originalOnSystem(...args);
        } finally {
          const topic = args[0]?.headers?.topic;
          if (topic === 'REGISTERED') ready = true;
          if (topic === 'disconnect' && !closed) {
            lost = true;
            onError?.(channelError('network_error'));
            onLost?.();
          }
        }
      };
    }

    client.registerCallbackListener(ROBOT_TOPIC, async (frame) => {
      if (closed) return;
      const body = parseBody(frame);
      if (!body) {
        onError?.(channelError('invalid_response'));
        ack(client, frame);
        return;
      }
      const message = this.parseMessage(body);
      try {
        await deliver(body, message);
        ack(client, frame);
      } catch {
        onError?.(channelError('network_error'));
        // No ACK: leave the callback for the platform retry.
      }
    });

    watchdog = setInterval(() => {
      if (closed || !ready) return;
      if (client.connected === false || client.registered === false) {
        onError?.(channelError('network_error'));
        onLost?.();
      }
    }, WATCHDOG_MS);
    watchdog.unref?.();

    try {
      await bounded(client.connect(), signal, { timeoutMs: Math.max(1, deadline - Date.now()) });
      while (!ready && !closed) {
        if (signal?.aborted) throw channelError('cancelled');
        if (lost) throw channelError('network_error');
        if (client.registered) {
          ready = true;
          break;
        }
        if (Date.now() > deadline) throw channelError('network_error');
        await delay(25, signal);
      }
      if (!ready) throw channelError('network_error');
    } catch (error) {
      await session.close();
      throw isYuriError(error)
        ? error
        : channelError(/auth/i.test(String(error?.message ?? '')) ? 'auth_expired' : 'network_error');
    }
    return session;
  }

  async _accessToken(credentials, { signal } = {}) {
    const key = credentialKey(credentials.clientId, credentials.clientSecret);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    this.tokens.delete(key);
    const json = await requestJSON(`${DINGTALK_ORIGIN}${TOKEN_PATH}`, {
      body: { appKey: credentials.clientId, appSecret: credentials.clientSecret },
      signal,
      fetchImpl: this.fetchImpl,
    });
    if (!nonEmptyString(json?.accessToken)) throw channelError('auth_expired');
    const expiresIn = Number(json.expireIn);
    this.tokens.set(key, {
      value: json.accessToken,
      expiresAt: Date.now() + Math.max(60_000, (Number.isFinite(expiresIn) ? expiresIn * 1000 : 0) - TOKEN_EXPIRY_MARGIN_MS),
    });
    return json.accessToken;
  }

  async _sendText({ credentials, userId, text, signal } = {}) {
    const token = await this._accessToken(credentials, { signal });
    const json = await requestJSON(`${DINGTALK_ORIGIN}${BATCH_SEND_PATH}`, {
      body: {
        robotCode: credentials.clientId,
        userIds: [userId],
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: text }),
      },
      headers: { 'x-acs-dingtalk-access-token': token },
      signal,
      fetchImpl: this.fetchImpl,
      sending: true,
    });
    if (!json || typeof json !== 'object') throw channelError('invalid_response');
    const rejected = ['invalidStaffIdList', 'flowControlledStaffIdList', 'filteredStaffIdList']
      .some((field) => Array.isArray(json[field]) && json[field].includes(userId));
    if (rejected) throw channelError('network_error');
    return json;
  }
}

/**
 * Registry-facing factory: one independent adapter session per live config.
 * Sessions are keyed by credentials + owner and are never evicted while live;
 * a duplicate live connect is rejected instead of replacing the first.
 */
export function createDingtalkSdkAdapter(options = {}) {
  const tokens = new Map();
  const sessions = new Map();

  return {
    async connect(args) {
      if (!args?.config) throw channelError('invalid_response');
      const key = sessionKey(args.config);
      if (sessions.has(key)) throw channelError('channel_in_use');
      const adapter = new DingTalkChatAdapter({
        ...options,
        clientId: args.config.clientID,
        clientSecret: args.config.clientSecret,
        ownerId: args.config.ownerID,
        tokenCache: tokens,
      });
      const entry = { adapter, closed: false };
      sessions.set(key, entry);
      try {
        await adapter.connect(args);
      } finally {
        entry.closed = true;
        if (sessions.get(key) === entry) sessions.delete(key);
      }
    },

    async send({ config, target, text, signal } = {}) {
      if (!config) throw channelError('invalid_response');
      const adapter = new DingTalkChatAdapter({
        ...options,
        clientId: config.clientID,
        clientSecret: config.clientSecret,
        ownerId: config.ownerID,
        tokenCache: tokens,
      });
      await adapter.send({ config, target, text, signal });
    },
  };
}

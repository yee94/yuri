import { createHash, randomUUID } from 'node:crypto';
import { Message, NotImplementedError, stringifyMarkdown } from 'chat';
import { WeixinError } from './api.js';
import { normalizeWeixinInput } from './inbound.js';
import { encodeWeixinTOON } from './toon.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const unsupported = async () => { throw new NotImplementedError('WeChat iLink does not expose this operation'); };

/**
 * Chat SDK Adapter extension for the QR-authorized iLink Bot protocol.
 * Durable receipt/cursor transactions and tool execution remain Yuri-owned.
 */
export function createWeixinChatAdapter({ api, getBinding, clock = Date.now }) {
  const receipts = new WeakMap();
  let chat;
  let closed = false;
  const binding = () => {
    const value = !closed && getBinding();
    if (!value) throw new WeixinError('cancelled');
    return value;
  };
  const encodeThreadId = ({ accountID, peerID }) => `weixin:${encodeURIComponent(accountID)}:${encodeURIComponent(peerID)}`;
  const decodeThreadId = (threadID) => {
    const pieces = threadID.split(':');
    if (pieces.length !== 3 || pieces[0] !== 'weixin') throw new WeixinError('validation_error');
    try { return { accountID: decodeURIComponent(pieces[1]), peerID: decodeURIComponent(pieces[2]) }; }
    catch { throw new WeixinError('validation_error'); }
  };
  const adapter = {
    name: 'weixin', userName: 'Yuri',
    initialize: async (instance) => { chat = instance; },
    disconnect: async () => { closed = true; chat = undefined; },
    encodeThreadId, decodeThreadId,
    channelIdFromThreadId: (threadID) => { decodeThreadId(threadID); return threadID; },
    isDM: (threadID) => { decodeThreadId(threadID); return true; },
    openDM: async (userID) => {
      const current = binding();
      if (userID !== current.peer_id) throw new WeixinError('validation_error');
      return encodeThreadId({ accountID: current.account_id, peerID: userID });
    },
    handleWebhook: async () => new Response(JSON.stringify({ error: 'weixin_long_poll_only' }),
      { status: 501, headers: { 'Content-Type': 'application/json' } }),
    parseMessage: (raw) => {
      const current = binding();
      if (raw?.message_type !== 1 || raw.from_user_id !== current.peer_id || raw.group_id) throw new WeixinError('validation_error');
      const platformID = typeof raw.message_id === 'string' && raw.message_id ? raw.message_id
        : Array.isArray(raw.item_list) ? raw.item_list.find((item) => typeof item?.msg_id === 'string' && item.msg_id)?.msg_id : '';
      if (!platformID || platformID.length > 256) throw new WeixinError('validation_error');
      const normalized = normalizeWeixinInput(raw);
      const payload = normalized.payload ? JSON.parse(normalized.payload) : null;
      const context = typeof raw.context_token === 'string' && raw.context_token.length <= 65_536 ? raw.context_token : '';
      const text = [normalized.text, payload ? encodeWeixinTOON({ items: payload.items, truncated: payload.truncated }) : ''].filter(Boolean).join('\n');
      const message = new Message({
        id: `weixin:${digest(JSON.stringify([current.account_id, current.peer_id, platformID]))}`,
        threadId: encodeThreadId({ accountID: current.account_id, peerID: current.peer_id }), text,
        formatted: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }] },
        raw: { items: payload?.items ?? [], truncated: payload?.truncated ?? false },
        author: { userId: current.peer_id, userName: current.peer_id, fullName: '', isBot: false, isMe: false },
        metadata: { dateSent: new Date(clock()), edited: false },
        attachments: (payload?.media ?? []).map((source) => ({
          type: source.kind === 'voice' ? 'audio' : source.kind,
          ...(source.filename ? { name: source.filename } : {}),
          // Capability references stay in this private closure, never serialized.
          fetchData: async () => {
            const active = binding();
            if (active.epoch !== current.epoch) throw new WeixinError('cancelled');
            const media = await api.downloadMedia(source);
            if (binding().epoch !== current.epoch) throw new WeixinError('cancelled');
            return media.buffer;
          },
        })),
      });
      receipts.set(message, { id: message.id, ...normalized, context });
      return message;
    },
    renderFormatted: (content) => stringifyMarkdown(content),
    postMessage: async (threadID, message, { id = `yuri_${randomUUID()}`, signal } = {}) => {
      const current = binding();
      const target = decodeThreadId(threadID);
      if (target.accountID !== current.account_id || target.peerID !== current.peer_id) throw new WeixinError('validation_error');
      if (message?.files?.length || message?.attachments?.length) return unsupported();
      const text = typeof message === 'string' ? message : typeof message?.raw === 'string' ? message.raw
        : typeof message?.markdown === 'string' ? message.markdown : message?.ast ? stringifyMarkdown(message.ast) : null;
      if (text === null) return unsupported();
      if (!text || Array.from(text).length > 3500) throw new WeixinError('validation_error');
      await api.sendText(current, { id, text }, signal);
      return { id, raw: { id } };
    },
    fetchThread: async (threadID) => { decodeThreadId(threadID); return { id: threadID, channelId: threadID, isDM: true, metadata: {} }; },
    fetchMessages: unsupported, editMessage: unsupported, deleteMessage: unsupported,
    addReaction: unsupported, removeReaction: unsupported, startTyping: unsupported,
    // iLink-specific extensions: preserve cursor-atomic batch admission and IDs.
    poll: (signal) => api.getUpdates(binding(), signal),
    dispatch: async (raw) => {
      if (!chat) throw new WeixinError('cancelled');
      const message = adapter.parseMessage(raw);
      await chat.processMessage(adapter, message.threadId, message);
    },
    receipt: (message) => {
      const receipt = receipts.get(message);
      if (!receipt) throw new WeixinError('validation_error');
      return receipt;
    },
  };
  return adapter;
}

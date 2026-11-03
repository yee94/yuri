import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWeixinAPI, WeixinError, weixinOrigin } from './api.js';
import { createWeixinStore } from './store.js';
import { createWeixinTyping } from './typing.js';
import { normalizeWeixinInput, prepareWeixinInput } from './inbound.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const messageID = (account, peer, id) => `weixin:${digest(JSON.stringify([account, peer, id]))}`;
const chunks = (text) => {
  const chars = Array.from(text);
  const result = [];
  for (let index = 0; index < chars.length; index += 3500) result.push(chars.slice(index, index + 3500).join(''));
  return result;
};
const feedback = (language, kind) => {
  const messages = language.startsWith('zh') ? {
    interrupted: 'Yuri 主机已重启，上一条请求可能未完成。请先检查任务状态，再决定是否重试。',
    failed: '助理未能完成这条请求，请在 Yuri 中查看具体错误后重试。',
    empty: '这条微信消息没有可读取的内容，请重发文字、图片或文章链接。',
  } : {
    interrupted: 'The Yuri host restarted. The previous request may be incomplete. Check its status before retrying.',
    failed: 'The bot could not complete this request. Check the error in Yuri before retrying.',
    empty: 'This WeChat message has no readable content. Please resend text, an image, or an article link.',
  };
  return messages[kind];
};
const safeError = (error) => error instanceof WeixinError ? error.code
  : ['account_in_use', 'not_found', 'no_provider'].includes(error?.code) ? error.code : 'channel_error';

export function createWeixinRuntime({ directory, service, refreshAllowedRoots = async () => {}, api = createWeixinAPI(), clock = Date.now, intervalMs = 2000, env = process.env } = {}) {
  const configured = String(env.YURI_WEIXIN_ENABLED ?? '').trim().toLowerCase();
  const development = env.NODE_ENV === 'development' || ['1', 'true'].includes(String(env.YURI_ELECTRON_DEV ?? '').trim().toLowerCase());
  const enabled = configured ? ['1', 'true'].includes(configured) : !development;
  if (!enabled) {
    // Do not open the shared store, acquire a lease, or remove production bindings.
    const disabled = () => { throw new WeixinError('channel_disabled'); };
    return {
      status: () => ({ status: 'disabled', error: null }),
      startLogin: disabled, verify: disabled, retry: disabled, disconnect: disabled, transfer: disabled,
      forget: async () => {}, onTurnEvent: () => {}, close: async () => {},
    };
  }
  const store = createWeixinStore(directory);
  const owner = randomUUID();
  const logins = new Map();
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
  const track = (promise) => {
    operations.add(promise);
    void promise.finally(() => operations.delete(promise)).catch(() => {});
    return promise;
  };
  const assertOwner = () => {
    if (closed || !ownsLease || !store.owns(owner, clock())) throw new WeixinError('channel_in_use');
  };
  const canControl = (binding) => ownsLease && store.owns(owner, clock())
    && store.get(binding.assistant_id)?.epoch === binding.epoch;
  const isCurrent = (binding) => !closed && !retiring.has(binding.assistant_id) && canControl(binding);
  const typing = createWeixinTyping({ api, clock, getBinding: store.get, isCurrent, canCancel: canControl });
  const pause = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});
  const stopReceiver = (assistantID) => {
    const entry = receivers.get(assistantID);
    entry?.controller.abort();
    receivers.delete(assistantID);
    return entry?.done;
  };
  const setError = (binding, error) => {
    if (!isCurrent(binding)) return;
    if (store.get(binding.assistant_id)?.status === 'expired') return;
    const code = safeError(error);
    store.patch(binding.epoch, {
      status: code === 'auth_expired' ? 'expired' : code === 'network_error' ? 'reconnecting' : 'connected',
      error: code, updated_at: clock(),
    });
    if (code === 'auth_expired') void track(typing.forget(binding.assistant_id));
  };

  const receive = async (initial, signal) => {
    let failures = 0;
    while (!signal.aborted && isCurrent(initial)) {
      const binding = store.get(initial.assistant_id);
      if (!binding || binding.status === 'expired') return;
      if (store.backlog(binding.epoch) >= 100) { await pause(2000, signal); continue; }
      try {
        const response = await api.getUpdates(binding, signal);
        if (signal.aborted || !isCurrent(binding)) return;
        if (store.get(binding.assistant_id)?.status === 'expired') return;
        const incoming = response.msgs ?? [];
        const cursor = response.get_updates_buf ?? binding.cursor;
        if (!Array.isArray(incoming) || incoming.length > 500 || typeof cursor !== 'string'
          || cursor.length > 512_000) throw new WeixinError('invalid_response');
        const messages = [];
        for (const msg of incoming) {
          if (!msg || typeof msg !== 'object') continue;
          // The QR-confirmed owner is the only principal allowed to execute tools.
          if (msg.message_type !== 1 || msg.from_user_id !== binding.peer_id || msg.group_id) continue;
          const platformID = typeof msg.message_id === 'string' && msg.message_id ? msg.message_id
            : Array.isArray(msg.item_list) ? msg.item_list.find((item) => typeof item?.msg_id === 'string' && item.msg_id)?.msg_id : '';
          if (!platformID || platformID.length > 256) continue;
          const context = typeof msg.context_token === 'string' && msg.context_token.length <= 65_536 ? msg.context_token : '';
          messages.push({ id: messageID(binding.account_id, binding.peer_id, platformID), ...normalizeWeixinInput(msg), context });
        }
        // Persist receipt and context before acknowledging the platform cursor.
        store.accept(binding, cursor || binding.cursor, messages);
        if (messages.some((message) => message.context)) store.unblock(binding.epoch);
        const lastError = store.get(binding.assistant_id)?.error;
        store.patch(binding.epoch, {
          status: 'connected', error: store.hasUnknown(binding.epoch) ? 'delivery_unknown'
            : lastError === 'network_error' ? null : lastError, updated_at: clock(),
        });
        failures = 0;
        if (!incoming.length) await pause(250, signal);
      } catch (error) {
        if (signal.aborted || !isCurrent(binding)) return;
        setError(binding, error);
        if (safeError(error) === 'auth_expired') return;
        await pause(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), signal);
      }
    }
  };

  const processIncoming = async (binding, generation) => {
    for (const receipt of store.pending(binding.epoch)) {
      if (!isCurrent(binding)) return;
      if (!receipt.text && !receipt.payload) {
        store.enqueue(binding.epoch, `${receipt.id}:empty`, feedback(binding.language, 'empty'));
        store.finishTurn(receipt.id);
        continue;
      }
      try {
        const receiverSignal = receivers.get(binding.assistant_id)?.controller.signal;
        const signal = receiverSignal ? AbortSignal.any([lifetime.signal, receiverSignal]) : lifetime.signal;
        const assertCurrent = () => {
          if (!isCurrent(binding) || signal.aborted || store.get(binding.assistant_id)?.status === 'expired'
            || service.channelPage(binding.assistant_id, { tipOnly: true }).generation !== generation) throw new WeixinError('cancelled');
        };
        const parts = await prepareWeixinInput(receipt, { api, service, assistantID: binding.assistant_id, signal, assertCurrent });
        await refreshAllowedRoots();
        assertCurrent();
        // Fence the crash gap. Never replay admitted tool side effects on restart.
        store.markInbox(receipt.id, 'admitted');
        const result = await service.send(binding.assistant_id, {
          messageID: receipt.id, parts, language: binding.language,
        });
        if (isCurrent(binding) && result.replayed) {
          store.enqueue(binding.epoch, `${receipt.id}:interrupted`, feedback(binding.language, 'interrupted'));
          store.finishTurn(receipt.id);
        }
      } catch {
        if (!isCurrent(binding)) return;
        store.enqueue(binding.epoch, `${receipt.id}:failed`, feedback(binding.language, 'failed'));
        store.finishTurn(receipt.id);
      }
    }
  };

  const processBinding = async (binding) => {
    if (!isCurrent(binding)) return;
    let page;
    try { page = service.channelPage(binding.assistant_id, { afterOrdinal: binding.ordinal, generation: binding.generation }); }
    catch (error) {
      if (error?.code === 'not_found') { await forget(binding.assistant_id); return; }
      throw error;
    }
    if (binding.status === 'expired') return;
    const deliveries = page.messages.flatMap((message) => {
      const text = message.status === 'error' ? feedback(binding.language, 'failed')
        : message.text?.trim() && !message.text.trim().startsWith('oc.settle.') ? message.text.trim()
          : message.cards.map((card) => card.title || card.name || '').filter(Boolean).join('\n');
      return chunks(text).map((chunk, index) => ({
        id: `yuri_${digest(`${binding.epoch}:${page.generation}:${message.messageID}:${index}`)}`, text: chunk,
      }));
    });
    store.collect(binding, page, deliveries);
    if (!inboundWork.has(binding.assistant_id)) {
      const work = track(processIncoming(binding, page.generation)).catch((error) => setError(binding, error));
      inboundWork.set(binding.assistant_id, work);
      void work.finally(() => {
        if (inboundWork.get(binding.assistant_id) === work) inboundWork.delete(binding.assistant_id);
      }).catch(() => {});
    }
    const current = store.get(binding.assistant_id);
    if (!isCurrent(binding) || current.status === 'expired' || !current.context_token) return;
    const delivery = store.nextDelivery(binding.epoch);
    if (!delivery || delivery.state !== 'pending') return;
    store.markDelivery(delivery.id, 'sending');
    try {
      const receiverSignal = receivers.get(binding.assistant_id)?.controller.signal;
      await api.sendText(current, delivery, receiverSignal ? AbortSignal.any([lifetime.signal, receiverSignal]) : lifetime.signal);
      if (!isCurrent(binding) && !(retiring.has(binding.assistant_id) && canControl(binding))) return;
      store.sent(delivery.id);
      store.patch(binding.epoch, { error: null, updated_at: clock() });
    } catch (error) {
      if (!isCurrent(binding)) {
        if (retiring.has(binding.assistant_id) && canControl(binding)) {
          // A failed move may resume this binding. Never strand an aborted send
          // in 'sending', or automatically replay a request already on the wire.
          store.markDelivery(delivery.id, 'unknown');
          store.patch(binding.epoch, error?.code === 'auth_expired'
            ? { status: 'expired', error: 'auth_expired' } : { error: 'delivery_unknown' });
        }
        return;
      }
      // Network ambiguity is user-retryable, not an automatic duplicate reply.
      store.markDelivery(delivery.id, error?.ambiguous ? 'unknown' : 'blocked');
      setError(binding, error?.ambiguous ? new WeixinError('delivery_unknown') : error);
    }
  };

  const tick = async () => {
    if (closed) return;
    ownsLease = store.acquire(owner, clock());
    if (!ownsLease) {
      for (const id of receivers.keys()) stopReceiver(id);
      for (const login of logins.values()) login.controller.abort();
      logins.clear();
      void track(typing.clear());
      return;
    }
    const bindings = store.list();
    const ids = new Set(bindings.map((binding) => binding.assistant_id));
    for (const id of receivers.keys()) if (!ids.has(id)) stopReceiver(id);
    for (const binding of bindings) {
      if (!recovered.has(binding.epoch)) {
        store.recover(binding.epoch, feedback(binding.language, 'interrupted'));
        if (store.hasUnknown(binding.epoch)) store.patch(binding.epoch, { error: 'delivery_unknown' });
        recovered.add(binding.epoch);
      }
      if (binding.status !== 'expired' && !retiring.has(binding.assistant_id) && !receivers.has(binding.assistant_id)) {
        const controller = new AbortController();
        const entry = { controller };
        receivers.set(binding.assistant_id, entry);
        entry.done = track(receive(binding, controller.signal)).finally(() => {
          if (receivers.get(binding.assistant_id) === entry) receivers.delete(binding.assistant_id);
        }).catch(() => {});
      }
    }
    // One slow Bot cannot prevent another account receiving or replying.
    await Promise.allSettled(bindings.map((binding) => {
      if (bindingWork.has(binding.assistant_id) || retiring.has(binding.assistant_id)) return;
      const work = processBinding(binding).catch((error) => setError(binding, error));
      bindingWork.set(binding.assistant_id, work);
      return work.finally(() => {
        if (bindingWork.get(binding.assistant_id) === work) bindingWork.delete(binding.assistant_id);
      });
    }));
  };

  const status = (assistantID) => {
    service.channelPage(assistantID, { tipOnly: true });
    const login = logins.get(assistantID);
    const binding = store.get(assistantID);
    const sources = !binding ? store.list().filter((row) => row.assistant_id !== assistantID && row.status !== 'expired') : [];
    const names = sources.length ? new Map(service.snapshot().assistants.map((row) => [row.id, row.name])) : new Map();
    const transferSources = sources.filter((row) => names.has(row.assistant_id)).map((row) => ({
      assistantID: row.assistant_id, name: names.get(row.assistant_id), revision: row.epoch,
    }));
    const available = transferSources.length ? { transferSources } : {};
    if (login) return { status: login.status, qrCode: login.qrCode, expiresAt: login.expiresAt, error: login.error ?? null, ...available };
    if (!binding) return { status: 'disconnected', error: null, ...available };
    return {
      status: ownsLease ? binding.status : 'reconnecting',
      error: ownsLease ? (store.hasUnknown(binding.epoch) ? 'delivery_unknown' : binding.error) : 'channel_in_use',
    };
  };

  const pollLogin = async (assistantID, login) => {
    let origin = weixinOrigin();
    let redirects = 0;
    while (!login.controller.signal.aborted && clock() < login.expiresAt && logins.get(assistantID) === login) {
      try {
        const verifyCode = login.verifyCode;
        const response = await api.getQRStatus(origin, login.qrcode, verifyCode, login.controller.signal);
        if (login.verifyCode === verifyCode) login.verifyCode = '';
        assertOwner();
        if (logins.get(assistantID) !== login || login.controller.signal.aborted) return;
        if (response.status === 'confirmed') {
          const { bot_token: token, ilink_bot_id: account, ilink_user_id: peer } = response;
          if (![token, account, peer].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 8192)) {
            throw new WeixinError('invalid_response');
          }
          const page = service.channelPage(assistantID, { tipOnly: true });
          store.bind({ assistant_id: assistantID, account_id: account, peer_id: peer, token,
            base_url: weixinOrigin(response.baseurl || origin), language: login.language,
            generation: page.generation, ordinal: page.tipOrdinal, updated_at: clock() });
          logins.delete(assistantID);
          void track(tick());
          return;
        }
        if (response.status === 'scaned_but_redirect' && response.redirect_host && redirects++ < 3) {
          origin = weixinOrigin(response.redirect_host);
        } else if (response.status === 'need_verifycode') {
          login.status = 'verify';
        } else if (response.status === 'scaned') {
          login.status = 'scanned';
        } else if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(response.status)) {
          login.status = 'expired';
          login.error = response.status === 'binded_redirect' ? 'already_bound' : null;
          login.qrCode = null;
          return;
        }
        login.error = null;
      } catch (error) {
        if (login.controller.signal.aborted || closed) return;
        login.error = safeError(error);
        if (['account_in_use', 'not_found', 'invalid_response', 'channel_in_use'].includes(login.error)) {
          login.status = 'error'; login.qrCode = null; return;
        }
      }
      await pause(1000, login.controller.signal);
    }
    if (logins.get(assistantID) === login) { login.status = 'expired'; login.qrCode = null; }
  };

  const startLogin = async (assistantID, language = 'en') => {
    service.channelPage(assistantID, { tipOnly: true });
    assertOwner();
    if (retiring.has(assistantID)) throw new WeixinError('channel_in_use');
    const previous = logins.get(assistantID);
    if (previous && ['waiting', 'scanned', 'verify'].includes(previous.status) && previous.expiresAt > clock()) return status(assistantID);
    if (store.get(assistantID) && store.get(assistantID).status !== 'expired') throw new WeixinError('already_bound');
    previous?.controller.abort();
    stopReceiver(assistantID);
    const login = { controller: new AbortController(), status: 'waiting', qrCode: null,
      qrcode: '', verifyCode: '', language: String(language).slice(0, 32), expiresAt: clock() + 480_000 };
    logins.set(assistantID, login);
    try {
      const data = await api.getQRCode(login.controller.signal, store.list().map((binding) => binding.token));
      assertOwner();
      if (logins.get(assistantID) !== login) throw new WeixinError('cancelled');
      if (typeof data.qrcode !== 'string' || !data.qrcode || data.qrcode.length > 8192
        || typeof data.qrcode_img_content !== 'string' || !data.qrcode_img_content || data.qrcode_img_content.length > 8192) {
        throw new WeixinError('invalid_response');
      }
      login.qrcode = data.qrcode;
      login.qrCode = data.qrcode_img_content;
      void track(pollLogin(assistantID, login));
      return status(assistantID);
    } catch (error) {
      if (logins.get(assistantID) === login) { login.status = 'error'; login.error = safeError(error); login.qrCode = null; }
      throw error;
    }
  };
  const forget = async (assistantID) => {
    if (retiring.has(assistantID)) throw new WeixinError('channel_in_use');
    retiring.add(assistantID);
    logins.get(assistantID)?.controller.abort();
    logins.delete(assistantID);
    stopReceiver(assistantID);
    try {
      await typing.forget(assistantID);
      store.unlink(assistantID);
    } finally { retiring.delete(assistantID); }
  };
  const disconnect = async (assistantID) => {
    service.channelPage(assistantID, { tipOnly: true });
    assertOwner();
    await forget(assistantID);
    return status(assistantID);
  };
  const transfer = async (assistantID, input) => {
    assertOwner();
    const { sourceAssistantID, revision, language = 'en' } = input ?? {};
    if (typeof sourceAssistantID !== 'string' || typeof revision !== 'string' || sourceAssistantID === assistantID) {
      throw new WeixinError('validation_error');
    }
    service.channelPage(assistantID, { tipOnly: true });
    service.channelPage(sourceAssistantID, { tipOnly: true });
    if (retiring.has(assistantID) || retiring.has(sourceAssistantID)) throw new WeixinError('channel_in_use');
    const source = store.get(sourceAssistantID);
    if (!source || source.epoch !== revision || source.status === 'expired' || store.get(assistantID)) throw new WeixinError('binding_changed');
    retiring.add(sourceAssistantID);
    retiring.add(assistantID);
    logins.get(assistantID)?.controller.abort();
    logins.delete(assistantID);
    try {
      await Promise.allSettled([stopReceiver(sourceAssistantID), bindingWork.get(sourceAssistantID), inboundWork.get(sourceAssistantID), typing.forget(sourceAssistantID)]);
      assertOwner();
      // Revalidate after draining: deletion or a stale confirmation must not move credentials.
      service.channelPage(sourceAssistantID, { tipOnly: true });
      const page = service.channelPage(assistantID, { tipOnly: true });
      store.transfer({ sourceAssistantID, expectedEpoch: revision, assistantID,
        generation: page.generation, ordinal: page.tipOrdinal, language: String(language).slice(0, 32), updatedAt: clock() });
    } finally {
      retiring.delete(sourceAssistantID);
      retiring.delete(assistantID);
      if (!closed) void track(tick());
    }
    return status(assistantID);
  };
  const timer = setInterval(() => { void track(tick()); }, intervalMs);
  timer.unref?.();
  void track(tick());
  return {
    status, startLogin, disconnect, forget,
    transfer: (assistantID, input) => track(transfer(assistantID, input)),
    verify: (assistantID, code) => {
      assertOwner();
      const login = logins.get(assistantID);
      if (!login || login.status !== 'verify' || typeof code !== 'string' || !/^\d{4,12}$/.test(code)) throw new WeixinError('validation_error');
      login.verifyCode = code;
      return status(assistantID);
    },
    retry: (assistantID) => {
      assertOwner();
      if (retiring.has(assistantID)) throw new WeixinError('channel_in_use');
      const binding = store.get(assistantID);
      if (!binding) throw new WeixinError('not_found');
      if (binding.status === 'expired') throw new WeixinError('auth_expired');
      store.retry(binding.epoch);
      store.patch(binding.epoch, { error: null });
      void track(tick());
      return status(assistantID);
    },
    onTurnEvent: (event) => {
      if (closed || !ownsLease) return;
      if (event.type === 'yuri:contact-turn-end') store.finishTurn(event.properties?.turnID ?? event.turnID);
      typing.onTurnEvent(event);
    },
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      clearInterval(timer);
      lifetime.abort();
      for (const login of logins.values()) login.controller.abort();
      for (const id of receivers.keys()) stopReceiver(id);
      closePromise = Promise.allSettled([...operations, typing.close()]).then(() => { store.release(owner); store.close(); });
      return closePromise;
    },
  };
}

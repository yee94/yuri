import { randomUUID } from 'node:crypto';

export const SESSION_LINK_PROBE_CHANNEL = 'yuri:session-link:probe';
export const SESSION_LINK_PROBE_RESULT_CHANNEL = 'yuri:session-link:probe-result';

const originOf = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
};

const runtimeKeyOf = (window) => {
  const runtime = window.__yuriRuntimeConfig || {};
  return runtime.relayHostId ? `relay:${runtime.relayHostId}` : `api:${originOf(runtime.apiBaseUrl)}`;
};

const normalizeResult = (payload) => {
  if (payload?.status === 'found' && typeof payload.directory === 'string' && payload.directory.trim()) {
    return { status: 'found', directory: payload.directory.trim() };
  }
  return { status: payload?.status === 'not-found' ? 'not-found' : 'error' };
};

/**
 * Pick the window that owns a session from per-window probe answers. Hits on
 * several runtimes are ambiguous; a miss is authoritative only when every
 * window answered.
 */
export const selectSessionLinkTarget = (results) => {
  const found = results.filter((result) => result.status === 'found');
  if (new Set(found.map((result) => runtimeKeyOf(result.window))).size > 1) return { outcome: 'ambiguous' };
  if (found.length > 0) {
    const chosen = found.find((result) => result.window.isFocused?.()) || found[0];
    return { outcome: 'found', window: chosen.window, directory: chosen.directory };
  }
  return { outcome: results.some((result) => result.status === 'error') ? 'unconfirmed' : 'not-found' };
};

/**
 * Ask each workspace window whether its own runtime knows a session id. Only
 * the probed window's main frame may answer its request.
 */
export const createSessionLinkProbe = ({ ipcMain, timeoutMs = 4_000, createId = randomUUID }) => {
  const pending = new Map();

  ipcMain.on(SESSION_LINK_PROBE_RESULT_CHANNEL, (event, payload) => {
    const entry = pending.get(typeof payload?.requestId === 'string' ? payload.requestId : '');
    if (!entry || event.sender !== entry.contents) return;
    if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) return;
    entry.finish(normalizeResult(payload));
  });

  const probeWindow = (window, sessionId) => new Promise((resolve) => {
    const contents = window.webContents;
    const requestId = createId();
    let timer = null;
    const onGone = () => finish({ status: 'error' });
    const send = () => {
      if (!pending.has(requestId)) return;
      try {
        contents.send(SESSION_LINK_PROBE_CHANNEL, { requestId, sessionId });
      } catch {
        finish({ status: 'error' });
      }
    };
    function finish(result) {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      clearTimeout(timer);
      contents.removeListener?.('destroyed', onGone);
      contents.removeListener?.('did-finish-load', send);
      resolve({ window, ...result });
    }
    pending.set(requestId, { contents, finish });
    timer = setTimeout(() => finish({ status: 'error' }), timeoutMs);
    contents.once?.('destroyed', onGone);
    if (contents.isLoading()) contents.once('did-finish-load', send);
    else send();
  });

  return {
    locate: async (windows, sessionId) =>
      selectSessionLinkTarget(await Promise.all(windows.map((window) => probeWindow(window, sessionId)))),
  };
};

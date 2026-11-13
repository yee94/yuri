import { parseSseEventEnvelope } from './protocol.js';

export const DEFAULT_UPSTREAM_STALL_TIMEOUT_MS = 20_000;
export const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;
export const UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS = DEFAULT_UPSTREAM_STALL_TIMEOUT_MS * 3;
export const DEFAULT_UPSTREAM_RECONNECT_DELAY_MS = 250;

function resolveTimeoutMs(value, fallback) {
  const resolved = typeof value === 'function' ? value() : value;
  return Number.isFinite(resolved) ? resolved : fallback;
}

function waitForReconnectDelay(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, Math.max(0, typeof ms === 'function' ? ms() : ms));
    const onAbort = () => {
      clearTimeout(timeout);
      finish();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  return { ...headers };
}

async function cancelResponseBody(response) {
  if (response?.body && typeof response.body.cancel === 'function') {
    await response.body.cancel().catch(() => {});
  }
}

export function createUpstreamSseReader({
  buildUrl,
  getHeaders = () => ({}),
  fetchImpl = fetch,
  parseBlock = parseSseEventEnvelope,
  initialLastEventId = '',
  signal,
  connectTimeoutMs = DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS,
  stallTimeoutMs = DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
  reconnectDelayMs = DEFAULT_UPSTREAM_RECONNECT_DELAY_MS,
  onEvent,
  onConnect,
  onDisconnect,
  onError,
}) {
  let running = null;
  let stopped = false;
  let activeController = null;
  let lastEventId = typeof initialLastEventId === 'string' ? initialLastEventId : '';
  let stopListenerAttached = false;

  function detachStopListener() {
    if (!stopListenerAttached) return;
    signal?.removeEventListener('abort', stop);
    stopListenerAttached = false;
  }

  function attachStopListener() {
    if (!signal || signal.aborted || stopListenerAttached) return;
    signal.addEventListener('abort', stop, { once: true });
    stopListenerAttached = true;
  }

  function stop() {
    stopped = true;
    detachStopListener();
    if (activeController && !activeController.signal.aborted) {
      activeController.abort();
    }
  }

  const start = () => {
    if (running) {
      return running;
    }

    attachStopListener();
    stopped = false;
    running = (async () => {
      while (!stopped && !signal?.aborted) {
        const controller = new AbortController();
        activeController = controller;
        const abortActive = () => controller.abort();
        signal?.addEventListener('abort', abortActive, { once: true });

        let abortReason = null;
        let connectTimer = null;
        let stallTimer = null;
        const clearConnectTimer = () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
        };
        const startConnectTimer = () => {
          const currentConnectTimeoutMs = resolveTimeoutMs(connectTimeoutMs, DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS);
          if (currentConnectTimeoutMs <= 0) {
            return;
          }

          connectTimer = setTimeout(() => {
            abortReason = 'upstream_connect_timeout';
            controller.abort();
          }, currentConnectTimeoutMs);
        };
        const clearStallTimer = () => {
          if (stallTimer) {
            clearTimeout(stallTimer);
            stallTimer = null;
          }
        };
        const resetStallTimer = () => {
          clearStallTimer();
          const currentStallTimeoutMs = resolveTimeoutMs(stallTimeoutMs, DEFAULT_UPSTREAM_STALL_TIMEOUT_MS);
          if (currentStallTimeoutMs <= 0) {
            return;
          }

          stallTimer = setTimeout(() => {
            abortReason = 'upstream_stalled';
            controller.abort();
          }, currentStallTimeoutMs);
        };

        try {
          const url = buildUrl();
          const headers = {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...normalizeHeaders(getHeaders()),
          };
          if (lastEventId) {
            headers['Last-Event-ID'] = lastEventId;
          }

          startConnectTimer();
          let response;
          try {
            response = await fetchImpl(url.toString(), {
              headers,
              signal: controller.signal,
            });
          } finally {
            clearConnectTimer();
          }

          if (!response?.ok || !response.body) {
            onError?.({
              type: 'upstream_unavailable',
              status: response?.status ?? 0,
              response,
            });
            await cancelResponseBody(response);
            await waitForReconnectDelay(reconnectDelayMs, signal);
            continue;
          }

          const connectionContext = onConnect?.({ response, lastEventId });

          const decoder = new TextDecoder();
          const reader = response.body.getReader();
          let buffer = '';

          resetStallTimer();

          while (!stopped && !signal?.aborted) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }

            if (!value?.length) {
              continue;
            }

            resetStallTimer();
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

            let separatorIndex = buffer.indexOf('\n\n');
            while (separatorIndex !== -1 && !stopped && !signal?.aborted) {
              const block = buffer.slice(0, separatorIndex);
              buffer = buffer.slice(separatorIndex + 2);
              const envelope = parseBlock(block);
              if (envelope?.payload) {
                if (typeof envelope.eventId === 'string' && envelope.eventId.length > 0) {
                  lastEventId = envelope.eventId;
                }
                onEvent?.({
                  block,
                  envelope,
                  payload: envelope.payload,
                  eventId: envelope.eventId,
                  directory: envelope.directory,
                  connectionContext,
                });
              }
              separatorIndex = buffer.indexOf('\n\n');
            }
          }

          if (!stopped && !signal?.aborted && buffer.trim().length > 0) {
            const block = buffer.trim();
            const envelope = parseBlock(block);
            if (envelope?.payload) {
              if (typeof envelope.eventId === 'string' && envelope.eventId.length > 0) {
                lastEventId = envelope.eventId;
              }
              onEvent?.({
                block,
                envelope,
                payload: envelope.payload,
                eventId: envelope.eventId,
                directory: envelope.directory,
                connectionContext,
              });
            }
          }
        } catch (error) {
          if (!stopped && !signal?.aborted && abortReason !== 'upstream_stalled' && abortReason !== 'upstream_connect_timeout') {
            onError?.({
              type: 'stream_error',
              error,
            });
          }
        } finally {
          clearConnectTimer();
          clearStallTimer();
          signal?.removeEventListener('abort', abortActive);
          if (activeController === controller) {
            activeController = null;
          }
          onDisconnect?.({ reason: abortReason ?? (stopped || signal?.aborted ? 'stopped' : 'closed') });
        }

        if (!stopped && !signal?.aborted) {
          await waitForReconnectDelay(reconnectDelayMs, signal);
        }
      }
    })().finally(() => {
      detachStopListener();
      running = null;
    });

    return running;
  };

  return {
    start,
    stop,
    getLastEventId() {
      return lastEventId;
    },
  };
}

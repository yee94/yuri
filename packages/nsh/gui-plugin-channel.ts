import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';
import type { GuiPluginCapturedSender, GuiPluginWireRequest, GuiPluginWireResponse } from './gui-plugin-transport';
import { guiPluginResponseHeaders } from './gui-plugin-transport';

/** WKScriptMessageHandlerWithReply is injected only into the content main frame.
 * No Window/global bridge lookup and no NSH application bridge enter plugins. */
export type GuiPluginReplyPort = { postMessage(input: Readonly<Record<string, unknown>>): Promise<unknown> };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function createGuiPluginChannel(input: {
  scope: RuntimeScope;
  port: GuiPluginReplyPort;
  isCurrent(expectedHost: RuntimeScope): boolean;
}) {
  const captured = runtimeScopeFrom(input.scope);
  if (!captured) throw new Error('scope_required');
  const expectedHost: RuntimeScope = captured;
  const pending = new Map<string, AbortController>();
  const streams = new Set<string>();
  let closed = false, sequence = 0;
  const current = (scope: RuntimeScope) => !closed && scope.hostID === expectedHost.hostID && scope.lease === expectedHost.lease && input.isCurrent(expectedHost);
  const check = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!current(expectedHost)) throw new Error('runtime_host_scope_stale');
  };
  check();
  const sender: GuiPluginCapturedSender = {
    isCurrent: current,
    async send(scope: RuntimeScope, request: GuiPluginWireRequest, signal: AbortSignal): Promise<GuiPluginWireResponse> {
      check(signal);
      if (!current(scope)) throw new Error('runtime_host_scope_stale');
      const id = String(++sequence), local = new AbortController();
      pending.set(id, local);
      const combined = AbortSignal.any([signal, local.signal]);
      // A cancellation message targets this exact owner/request, never the latest surface.
      const cancel = () => { void input.port.postMessage({ name: 'cancel', expectedHost, id }).catch(() => {}); };
      combined.addEventListener('abort', cancel, { once: true });
      try {
        check(combined);
        const result = await input.port.postMessage({ name: 'request', expectedHost, id, input: request });
        check(combined);
        if (!record(result)) throw new Error('GUI_PLUGIN_INVALID_RESPONSE');
        const headKeys = result.stream === true ? ['status', 'mime', 'headers', 'stream'] : ['status', 'mime', 'headers', 'base64'];
        if (Object.keys(result).some(key => !headKeys.includes(key))) { await input.port.postMessage({ name: 'cancel', expectedHost, id }); throw new Error('GUI_PLUGIN_INVALID_RESPONSE'); }
        let headers: Readonly<Record<string, string>>;
        try { headers = guiPluginResponseHeaders(result.headers); }
        catch (error) { await input.port.postMessage({ name: 'cancel', expectedHost, id }); throw error; }
        if (record(result) && typeof result.status === 'number' && typeof result.mime === 'string' && result.stream === true) {
          streams.add(id);
          const cancelStream = async () => { streams.delete(id); await input.port.postMessage({ name: 'cancel', expectedHost, id }); };
          const abort = () => { void cancelStream().catch(() => {}); };
          signal.addEventListener('abort', abort, { once: true });
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                check(signal);
                const chunk = await input.port.postMessage({ name: 'chunk', expectedHost, id });
                check(signal);
                if (!record(chunk) || Object.keys(chunk).some(key => !['done', 'base64'].includes(key)) || typeof chunk.done !== 'boolean' || typeof chunk.base64 !== 'string' || chunk.base64.length > 87384 || chunk.base64.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(chunk.base64)) throw new Error('GUI_PLUGIN_INVALID_CHUNK');
                const bytes = Uint8Array.from(atob(chunk.base64), char => char.charCodeAt(0));
                if (bytes.length) controller.enqueue(bytes);
                if (chunk.done) { streams.delete(id); signal.removeEventListener('abort', abort); controller.close(); }
              } catch (error) { signal.removeEventListener('abort', abort); void cancelStream().catch(() => {}); controller.error(error); }
            },
            async cancel() { signal.removeEventListener('abort', abort); await cancelStream(); },
          });
          return { status: result.status, mime: result.mime, base64: '', headers, stream };
        }
        if (!record(result) || typeof result.status !== 'number' || typeof result.mime !== 'string' || typeof result.base64 !== 'string') throw new Error('GUI_PLUGIN_INVALID_RESPONSE');
        return { status: result.status, mime: result.mime, base64: result.base64, headers };
      } finally { combined.removeEventListener('abort', cancel); pending.delete(id); }
    },
  };
  return {
    sender,
    async state(phase: string) {
      check();
      const result = await input.port.postMessage({ name: 'state', expectedHost, phase });
      check();
      if (result !== true) throw new Error('GUI_PLUGIN_INVALID_RESPONSE');
    },
    close() { if (closed) return; for (const controller of pending.values()) controller.abort(); pending.clear(); for (const id of streams) void input.port.postMessage({ name: 'cancel', expectedHost, id }).catch(() => {}); streams.clear(); closed = true; },
  };
}

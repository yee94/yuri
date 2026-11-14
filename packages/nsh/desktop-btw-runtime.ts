import type { SessionSwitchModelInput } from '../ui/src/lib/opencode/v2-types';
import { normalizeDirectoryKey } from '../ui/src/lib/pathNormalization';
import { sameRuntimeScope, runtimeScopeFrom, type RuntimeScope } from './runtime-scope';
import { createDesktopHttpClient, DesktopHttpError, type DesktopHttpGrant, type DesktopHttpResponse } from './desktop-http-core';
import type { NativeBtwRequestScope, NativeBtwRuntime, NativeBtwScope, NativeBtwSelection } from './desktop-btw';

export class DesktopBtwResponseError extends Error {
  constructor(readonly phase: 'model' | 'agent' | 'generate', readonly response: DesktopHttpResponse) {
    super(`desktop_btw_${phase}_response_${response.status}`); this.name = 'DesktopBtwResponseError';
  }
}

/** Captured operation port only: inject applySelection/generate into the existing store, never a second store. */
export function createDesktopBtwRuntime(options: {
  grant: DesktopHttpGrant | undefined;
  expectedHost: RuntimeScope;
  scope: NativeBtwScope;
  runtime: () => NativeBtwRuntime;
  runtimeScope: () => RuntimeScope | null;
  current: () => boolean;
  onIssue: (error: DesktopHttpError | DesktopBtwResponseError) => void;
}) {
  const runtime = Object.freeze({ ...options.runtime() }), target = Object.freeze({ sessionId: options.scope.sessionId, directory: options.scope.directory ?? null });
  let expectedHost: RuntimeScope | null;
  try { expectedHost = runtimeScopeFrom(options.expectedHost); } catch { return undefined; }
  if (!expectedHost || !target.sessionId.trim() || !runtime.transport || !Number.isSafeInteger(runtime.generation)) return undefined;
  if (options.scope.runtime && (options.scope.runtime.transport !== runtime.transport || options.scope.runtime.generation !== runtime.generation)) return undefined;
  const capturedHost = expectedHost;
  const current = () => options.current() && options.runtime().transport === runtime.transport && options.runtime().generation === runtime.generation
    && sameRuntimeScope(options.runtimeScope(), capturedHost);
  const http = createDesktopHttpClient({ grant: options.grant, expectedHost: capturedHost, current, onIssue: options.onIssue });
  if (!http) return undefined;
  const guard = (scope: NativeBtwRequestScope, signal: AbortSignal) => {
    if (signal.aborted) throw new DesktopHttpError('aborted', 'not-dispatched');
    if (!http.current() || scope.sessionID !== target.sessionId || normalizeDirectoryKey(scope.directory) !== normalizeDirectoryKey(target.directory)
      || scope.runtime.transport !== runtime.transport || scope.runtime.generation !== runtime.generation) throw new DesktopHttpError('stale', 'not-dispatched');
  };
  const report = (error: DesktopBtwResponseError) => { try { options.onIssue(error); } catch { /* The port still rejects with the structured response. */ } };
  async function post(phase: 'model' | 'agent' | 'generate', scope: NativeBtwRequestScope, body: unknown, signal: AbortSignal, status: number) {
    guard(scope, signal);
    const response = await http!.request({ path: `/api/session/${encodeURIComponent(target.sessionId)}/${phase}`, method: 'POST', body }, { signal });
    guard(scope, signal);
    if (response.status !== status) { const error = new DesktopBtwResponseError(phase, response); report(error); throw error; }
    return response;
  }
  return {
    current: http.current,
    dispose: http.retire,
    async applySelection(scope: NativeBtwRequestScope, selected: NativeBtwSelection, request: { signal: AbortSignal }) {
      guard(scope, request.signal);
      // Installed SDK ModelRef is { providerID, id, variant?: string }, not { modelID }.
      const model: SessionSwitchModelInput['model'] = { providerID: selected.providerID, id: selected.modelID,
        ...(typeof selected.variant === 'string' && selected.variant.trim() ? { variant: selected.variant.trim() } : {}) };
      const agent = selected.agent?.trim();
      if (!model.providerID || !model.id) throw new DesktopHttpError('invalid-request', 'not-dispatched');
      await post('model', scope, { model }, request.signal, 204);
      if (agent) await post('agent', scope, { agent }, request.signal, 204);
    },
    async generate(scope: NativeBtwRequestScope, body: { sessionID: string; prompt: string }, request: { signal: AbortSignal }): Promise<{ text: string }> {
      guard(scope, request.signal);
      if (body.sessionID !== target.sessionId || typeof body.prompt !== 'string') throw new DesktopHttpError('invalid-request', 'not-dispatched');
      const response = await post('generate', scope, { prompt: body.prompt }, request.signal, 200);
      const envelope = response.body as { data?: { text?: unknown } } | null;
      if (!envelope || typeof envelope.data?.text !== 'string') { const error = new DesktopBtwResponseError('generate', response); report(error); throw error; }
      return { text: envelope.data.text };
    },
  };
}
export type DesktopBtwRuntime = NonNullable<ReturnType<typeof createDesktopBtwRuntime>>;

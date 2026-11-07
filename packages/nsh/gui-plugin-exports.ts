import type { ViewExportAPI, ViewExportOptions } from '../ui/src/lib/view-export/types';
import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';

/** Container-owned exports stay independent of Host RPC and plugin main.
 * The genuine native export implementation must be supplied by its owner;
 * absence leaves the existing host contracts inactive. */
export function captureGuiPluginExports(input: {
  scope: RuntimeScope;
  signal: AbortSignal;
  isCurrent(expectedHost: RuntimeScope): boolean;
  capture(expectedHost: RuntimeScope): ViewExportAPI | undefined;
}): ViewExportAPI | undefined {
  const captured = runtimeScopeFrom(input.scope);
  if (!captured) throw new Error('scope_required');
  const expectedHost: RuntimeScope = captured;
  const check = (signal = input.signal) => {
    signal.throwIfAborted(); input.signal.throwIfAborted();
    if (!input.isCurrent(expectedHost)) throw new Error('runtime_host_scope_stale');
  };
  check();
  const api = input.capture(expectedHost);
  if (!api) return undefined;
  const options = (value: ViewExportOptions = {}): ViewExportOptions => {
    const signal = AbortSignal.any([input.signal, ...(value.signal ? [value.signal] : [])]);
    check(signal);
    return { signal, onProgress: progress => { check(signal); value.onProgress?.(progress); } };
  };
  return {
    async capabilities() { check(); const value = await api.capabilities(); check(); return value; },
    async exportPDF(value, config) {
      const configNow = options(config);
      const result = await api.exportPDF({ ...value, snapshot: { ...value.snapshot } }, configNow);
      check(configNow.signal); return result;
    },
    async exportLongImage(value, config) {
      const configNow = options(config);
      const result = await api.exportLongImage({ ...value, snapshot: { ...value.snapshot } }, configNow);
      check(configNow.signal); return result;
    },
  };
}

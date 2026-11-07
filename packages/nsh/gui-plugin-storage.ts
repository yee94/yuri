import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';

export type GuiPluginStorageOperation = { method: 'get'; key: string } | { method: 'set'; key: string; value: string }
  | { method: 'remove'; key: string } | { method: 'keys' } | { method: 'clear' };

/** Official GuiPluginStorage requires synchronous get/set with write failure
 * before adoption. WK's scoped native prompt lane provides that atomic contract;
 * an asynchronous fire-and-forget localStorage mirror would be incorrect. */
export function createGuiPluginStorage(input: {
  scope: RuntimeScope;
  isCurrent(expectedHost: RuntimeScope): boolean;
  transact(expectedHost: RuntimeScope, operation: GuiPluginStorageOperation): unknown;
}): Storage {
  const captured = runtimeScopeFrom(input.scope);
  if (!captured) throw new Error('scope_required');
  const expectedHost: RuntimeScope = captured;
  const run = (operation: GuiPluginStorageOperation) => {
    if (!input.isCurrent(expectedHost)) throw new Error('runtime_host_scope_stale');
    const result = input.transact(expectedHost, operation);
    if (!input.isCurrent(expectedHost)) throw new Error('runtime_host_scope_stale');
    return result;
  };
  const keys = (): string[] => {
    const result = run({ method: 'keys' });
    if (!Array.isArray(result) || !result.every((key): key is string => typeof key === 'string')) throw new Error('GUI_STORAGE_INVALID_RESPONSE');
    return result;
  };
  return {
    get length() { return keys().length; },
    key(index) { return keys()[index] ?? null; },
    getItem(key) { const value = run({ method: 'get', key }); if (value !== null && typeof value !== 'string') throw new Error('GUI_STORAGE_INVALID_RESPONSE'); return value; },
    setItem(key, value) { if (run({ method: 'set', key, value }) !== true) throw new Error('GUI_STORAGE_WRITE_FAILED'); },
    removeItem(key) { if (run({ method: 'remove', key }) !== true) throw new Error('GUI_STORAGE_WRITE_FAILED'); },
    clear() { if (run({ method: 'clear' }) !== true) throw new Error('GUI_STORAGE_WRITE_FAILED'); },
  };
}

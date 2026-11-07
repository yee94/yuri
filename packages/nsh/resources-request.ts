import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';

/** Bind at resource owner construction, never at a later click/retry. A copied,
 * immutable receipt also prevents mutation of an external props object. */
export function bindResourceRead(scope: RuntimeScope | null, call: (name: string, body: Record<string, unknown>) => Promise<unknown>) {
  const expectedHost = runtimeScopeFrom(scope);
  return async (path: string, requestId: string): Promise<unknown> => {
    if (!expectedHost) throw new Error('scope_required');
    return await call('resources.read', { path, requestId, expectedHost });
  };
}

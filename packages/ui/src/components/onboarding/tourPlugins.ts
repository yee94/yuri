import { queryClient, queryKeys } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

export const tourPlugins = [
  { name: 'Magpie', spec: 'opencode-magpie-plugin' },
  { name: 'Eficy', spec: '@eficy/opencode2-plugin' },
  { name: 'yee-profile', spec: '@yee94/opencode-profile' },
] as const;

/** Configuration writes are idempotent; OpenCode owns activation. */
export async function saveRecommendedPlugins(specs: readonly string[], signal: AbortSignal) {
  if (!specs.length) return true;
  signal.throwIfAborted();
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const response = await runtimeFetch('/api/config/plugins', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ specs }),
    signal,
  });
  if (response.status !== 204) return false;
  if (generation === getRuntimeGeneration() && transport === getRuntimeTransportIdentity()) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.plugins.list(null, transport).slice(0, 3), refetchType: 'none' });
  }
  return true;
}

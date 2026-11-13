import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { getRuntimeAuthGeneration } from '@/lib/runtime-auth';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { runtimeFetch, type RuntimeFetchOptions } from '@/lib/runtime-fetch';

/** Capture once per operation/options factory; never resolve an active project after await. */
export const captureProjectScope = (entry?: HostRuntimeEntry) => {
  const generation = getRuntimeGeneration();
  const auth = getRuntimeAuthGeneration();
  const transport = getRuntimeTransportIdentity();
  const assertCurrent = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (generation !== getRuntimeGeneration() || auth !== getRuntimeAuthGeneration()
      || transport !== getRuntimeTransportIdentity()) throw new DOMException('Project scope superseded', 'AbortError');
    // Registry SDK access is synchronous and checks its captured Hub generation.
    if (entry) entry.sdk();
  };
  return {
    assertCurrent,
    key: <T extends readonly unknown[]>(key: T) => entry ? [...key, 'host-location', ...entry.queryScope] : key,
    fetch: async (path: string, init?: RuntimeFetchOptions) => {
      assertCurrent(init?.signal ?? undefined);
      const response = await (entry ? entry.fetch(path, init) : runtimeFetch(path, init));
      assertCurrent(init?.signal ?? undefined);
      return response;
    },
    json: async <T>(path: string, init?: RuntimeFetchOptions): Promise<T> => {
      assertCurrent(init?.signal ?? undefined);
      const response = await (entry ? entry.fetch(path, init) : runtimeFetch(path, init));
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string; code?: string } | null;
        assertCurrent(init?.signal ?? undefined);
        throw new Error(payload?.error || payload?.code || `Project request failed (${response.status})`);
      }
      const result = await response.json() as T;
      assertCurrent(init?.signal ?? undefined);
      return result;
    },
  };
};

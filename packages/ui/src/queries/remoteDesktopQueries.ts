import { useQuery } from '@tanstack/react-query';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

export const remoteDesktopQueryOptions = (transport: string, generation: number) => ({
  queryKey: [transport, 'remote-desktop', generation] as const,
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<{ supported: boolean; enabled: boolean }> => {
    const assertScope = () => {
      if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) throw new Error('runtime_changed');
    };
    assertScope();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await runtimeFetch('/api/remote-desktop', { signal: controller.signal, headers: { Accept: 'application/json' } });
          assertScope();
          if ([404, 501].includes(response.status) || !response.headers.get('content-type')?.includes('application/json')) throw new Error('unsupported');
          if (!response.ok) throw new Error('connection_failed');
          const value: unknown = await response.json();
          assertScope();
          if (!value || typeof value !== 'object' || !('supported' in value) || typeof value.supported !== 'boolean') throw new Error('unsupported');
          return { supported: value.supported, enabled: 'enabled' in value && value.enabled === true };
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { abort(); reject(new Error('connection_failed')); }, 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
    }
  },
  staleTime: 30000,
  retry: false,
});

export const useRemoteDesktopCapability = (transport: string, generation: number) => useQuery(remoteDesktopQueryOptions(transport, generation));

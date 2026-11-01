import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { configureDesktopRemoteDesktop } from '@/lib/desktop';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

const assertScope = (transport: string, generation: number) => {
  if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) throw new Error('runtime_changed');
};

export const remoteDesktopSetupOptions = (transport: string, generation: number) => ({
  queryKey: [transport, 'remote-desktop-setup', generation] as const,
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    assertScope(transport, generation);
    signal.throwIfAborted();
    const status = await configureDesktopRemoteDesktop({ type: 'status' });
    signal.throwIfAborted();
    assertScope(transport, generation);
    return status;
  },
  retry: false,
  refetchOnWindowFocus: 'always' as const,
});

type SetupAction = { type: 'enabled'; enabled: boolean } | { type: 'permission'; permission: 'screen' | 'accessibility' };

export function useRemoteDesktopSetup() {
  const transport = getRuntimeTransportIdentity(), generation = getRuntimeGeneration();
  const options = remoteDesktopSetupOptions(transport, generation);
  const client = useQueryClient();
  const query = useQuery(options);
  const mutation = useMutation({
    mutationKey: [transport, 'remote-desktop-setup-action', generation],
    mutationFn: async (action: SetupAction) => {
      assertScope(transport, generation);
      const result = await configureDesktopRemoteDesktop(action);
      assertScope(transport, generation);
      return result;
    },
    onSuccess: status => {
      if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) return;
      client.setQueryData(options.queryKey, status);
      void client.invalidateQueries({ queryKey: [transport, 'remote-desktop', generation] });
    },
    onError: () => {
      if (transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration()) {
        void client.invalidateQueries({ queryKey: options.queryKey });
      }
    },
  });
  return { query, mutation };
}

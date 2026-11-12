import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useEvent, useMountedState } from '@reactuses/core';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';

type Selection = { hostId: string; step: 'machine' | 'directory' };
type Attempt = { owner: HostRuntimeRegistry; selection: Selection };
const initialSelection = (): Selection => ({ hostId: '', step: 'machine' });

/** Machine readiness precedes mounting either directory reader. Query owns the attempt. */
export function useDirectoryMachineModel(open: boolean, registry: HostRuntimeRegistry | null, onOpenChange: (open: boolean) => void) {
  const [selection, setSelection] = useState(initialSelection);
  const isMounted = useMountedState();
  useEffect(() => {
    if (!open) setSelection(initialSelection());
  }, [open]);
  const mutationKey = [getRuntimeTransportIdentity(), 'remote-projects', registry?.hubId ?? '', 'directory-picker', 'connect', selection.hostId];
  const assertSelected = useEvent(({ owner, selection: captured }: Attempt) => {
    owner.assertCurrent();
    const host = owner.getHost(captured.hostId);
    if (!isMounted() || !open || owner !== registry || captured !== selection
      || !host || host.available === false) {
      throw new Error('Remote machine selection changed during connection');
    }
  });
  const connection = useMutation({
    mutationKey,
    retry: false,
    mutationFn: async (attempt: Attempt) => {
      assertSelected(attempt);
      await attempt.owner.connectHost(attempt.selection.hostId, { verify: true });
      assertSelected(attempt);
      setSelection({ ...attempt.selection, step: 'directory' });
    },
  }, queryClient);
  const selectHost = useEvent((hostId: string) => {
    connection.reset();
    setSelection({ hostId, step: 'machine' });
  });
  const back = useEvent(() => {
    connection.reset();
    setSelection({ ...selection, step: 'machine' });
  });
  const changeOpen = useEvent((next: boolean) => {
    if (!next) {
      connection.reset();
      setSelection(initialSelection());
    }
    onOpenChange(next);
  });
  const next = useEvent(() => {
    if (!open || selection.step !== 'machine') return;
    if (!selection.hostId) {
      setSelection({ ...selection, step: 'directory' });
      return;
    }
    const host = registry?.getHost(selection.hostId);
    if (!registry || !host || host.available === false || host.state === 'unauthorized' || host.state === 'incompatible'
      || queryClient.isMutating({ mutationKey, exact: true })) return;
    connection.mutate({ owner: registry, selection });
  });
  const currentAttempt = connection.variables?.owner === registry && connection.variables?.selection === selection;
  return { ...selection, selectHost, back, changeOpen, next,
    pending: currentAttempt && connection.isPending, error: currentAttempt ? connection.error : null };
}

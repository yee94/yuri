import { useDirectoryStore } from '@/sync/sync-context';
import { useTranscriptProjection } from '@/sync/transcript-repository-observers';
import { projectBlockingShellIds, shellIdsEqual } from './workStatusShells';

export const useBlockingShellIds = (sessionId: string | null, directory: string | null): readonly string[] => {
  const store = useDirectoryStore(directory || undefined, { bootstrap: false });
  return useTranscriptProjection(
    sessionId ?? '',
    directory ?? '',
    store,
    projectBlockingShellIds,
    shellIdsEqual,
    { enabled: Boolean(sessionId && directory) },
  );
};

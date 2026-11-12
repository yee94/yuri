import { useEffect, useMemo } from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';
import { createProjectFilesAPI } from './project-files';
import { createProjectGitAPI } from '@/lib/gitApiProject';
import { createProjectTerminalAPI } from '@/lib/terminalApi';
import type { TerminalAPI } from './types';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';

export function useProjectDirectory() {
  return useEffectiveDirectory();
}

/** Project capabilities never change the window's machine-management runtime. */
export function useProjectRuntimeAPIs() {
  const runtime = useRuntimeAPIs();
  const context = useHostRuntime();
  const entry = context?.entry.location.hostId ? context.entry : undefined;
  const scoped = useMemo(() => {
    if (!entry) return null;
    // Socket/auth owners are created on demand, not by rendering Files or Git.
    let owner: ReturnType<typeof createProjectTerminalAPI> | undefined;
    let disposed = false;
    const getTerminal = () => {
      if (disposed) throw new DOMException('Project terminal owner ended', 'AbortError');
      return owner ??= createProjectTerminalAPI(entry);
    };
    const terminal: TerminalAPI = {
      createSession: (options) => getTerminal().createTerminalSession(options),
      restartSession: (id, options) => getTerminal().restartTerminalSession(id, options),
      connect: (id, handlers, options) => ({ close: getTerminal().connectTerminalStream(id, handlers.onEvent, handlers.onError, {
        maxRetries: options?.retry?.maxRetries,
        initialRetryDelay: options?.retry?.initialDelayMs,
        maxRetryDelay: options?.retry?.maxDelayMs,
        connectionTimeout: options?.connectionTimeoutMs,
      }) }),
      sendInput: (id, input) => getTerminal().sendTerminalInput(id, input),
      resize: async ({ sessionId, cols, rows }) => { await getTerminal().resizeTerminal(sessionId, cols, rows); },
      close: (id) => getTerminal().closeTerminal(id),
    };
    return { files: createProjectFilesAPI(entry), git: createProjectGitAPI(entry), terminal,
      activate: () => { disposed = false; },
      dispose: () => { disposed = true; owner?.dispose(); owner = undefined; } };
  }, [entry]);
  useEffect(() => { scoped?.activate(); return () => scoped?.dispose(); }, [scoped]);
  return useMemo(() => scoped
    ? { ...runtime, files: scoped.files, git: scoped.git, terminal: scoped.terminal,
      github: undefined, editor: undefined, projectScope: entry }
    : { ...runtime, projectScope: undefined }, [runtime, scoped, entry]);
}

import { queryOptions } from '@tanstack/react-query';
import { opencodeClient } from '@/lib/opencode/client';
import { queryKeys } from '@/lib/queryRuntime';
import type { Part } from '@/lib/opencode/v2-types';

export type WorkStatusShell = {
  id: string;
  directory: string;
  startedAt?: number;
};

const EMPTY_SHELL_IDS: readonly string[] = [];

/**
 * Shells of running `shell` tool calls. The call still blocks its turn, so
 * the shell is foreground work; it becomes background once the call settles
 * (timeout or moved to the background by the user).
 */
export const projectBlockingShellIds = (data: {
  messageOrder: readonly string[];
  partsByMessageID: Readonly<Record<string, readonly Part[] | undefined>>;
}): readonly string[] => {
  const ids: string[] = [];
  for (const messageID of data.messageOrder) {
    for (const part of data.partsByMessageID[messageID] ?? []) {
      if (part?.type !== 'tool' || part.tool !== 'shell' || part.state?.status !== 'running') continue;
      const shellID = (part.state.metadata as Record<string, unknown> | undefined)?.shellID;
      if (typeof shellID === 'string' && shellID) ids.push(shellID);
    }
  }
  return ids.length === 0 ? EMPTY_SHELL_IDS : ids;
};

export const shellIdsEqual = (left: readonly string[], right: readonly string[]): boolean =>
  left === right || (left.length === right.length && left.every((id, index) => id === right[index]));

export function workStatusShellInfoQueryOptions(directory: string, shellID: string) {
  return queryOptions({
    queryKey: queryKeys.workStatusShell.info(directory, shellID),
    queryFn: async ({ signal }) => {
      const response = await opencodeClient.getScopedSdkClient(directory).shell.get(
        { id: shellID, location: { directory } },
        { signal },
      );
      const data = response?.data;
      if (!data || typeof data.command !== 'string') throw new Error('shell.get returned no data');
      return { command: data.command, status: data.status, exit: data.exit };
    },
    staleTime: 30_000,
  });
}

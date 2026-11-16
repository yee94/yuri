import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { opencodeClient } from '@/lib/opencode/client';
import type { TerminalChunk, TerminalTab } from '@/stores/useTerminalStore';

type ShellLog = NonNullable<TerminalTab['shellLog']>;
type Snapshot = { cursor: number; size: number; chunks: TerminalChunk[]; status: string; endsWithCR: boolean };

// Captured stdout is not PTY output: LF needs CR, but existing CRLF and
// progress-line carriage returns (including split chunks) must stay intact.
export function shellLogNewlines(text: string, previousEndsWithCR = false): string {
  return text.replace(/\n/g, (newline, offset: number) =>
    (offset === 0 ? previousEndsWithCR : text[offset - 1] === '\r') ? newline : '\r\n');
}

export function shellLogQueryOptions(shell: ShellLog, client: QueryClient) {
  const queryKey = [shell.transport, 'shellLog', shell.directory, shell.id] as const;
  return queryOptions({
    queryKey,
    queryFn: async ({ signal }): Promise<Snapshot> => {
      const previous = client.getQueryData<Snapshot>(queryKey);
      const sdk = opencodeClient.getScopedSdkClient(shell.directory);
      const input = { id: shell.id, location: { directory: shell.directory } };
      // Read status before output so the terminal read drains all bytes written before exit.
      const info = await sdk.shell.get(input, { signal });
      const page = await sdk.shell.output({ ...input, cursor: previous?.cursor ?? 0, limit: 65_536 }, { signal });
      if (!info?.data || !page?.data || typeof page.data.output !== 'string') throw new Error('Shell log unavailable');
      let chunks = previous?.chunks ?? [];
      if (page.data.output) {
        chunks = [...chunks, { id: page.data.cursor, data: shellLogNewlines(page.data.output, previous?.endsWithCR) }];
        let length = 0;
        let start = chunks.length;
        while (start > 0 && length + chunks[start - 1].data.length <= 1_000_000) {
          length += chunks[--start].data.length;
        }
        chunks = chunks.slice(start);
      }
      return { cursor: page.data.cursor, size: page.data.size, chunks, status: info.data.status,
        endsWithCR: page.data.output ? page.data.output.endsWith('\r') : previous?.endsWithCR ?? false };
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (query.state.error || !data) return 2000;
      if (data.cursor < data.size) return 100;
      return data.status === 'running' ? 1000 : false;
    },
    retry: 1,
    gcTime: 60_000,
  });
}

import { beforeEach, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { shellLogNewlines, shellLogQueryOptions } from './shellLogQueries';

const sdk = vi.hoisted(() => ({ get: vi.fn(), output: vi.fn() }));
vi.mock('@/lib/opencode/client', () => ({
  opencodeClient: { getScopedSdkClient: () => ({ shell: sdk }) },
}));
beforeEach(() => {
  vi.resetAllMocks();
  sdk.get.mockResolvedValue({ data: { status: 'running' } });
});

it('converts stdout LF without damaging ANSI, CRLF or split CRLF', () => {
  expect(shellLogNewlines('\x1b[32mOK\x1b[0m\nnext\n')).toBe('\x1b[32mOK\x1b[0m\r\nnext\r\n');
  expect(shellLogNewlines('one\r\ntwo\rprogress')).toBe('one\r\ntwo\rprogress');
  expect(shellLogNewlines('\nnext\n', true)).toBe('\nnext\r\n');
});

it('advances the byte cursor, retains color, drains exit and preserves data on failure', async () => {
  const client = new QueryClient();
  const options = { ...shellLogQueryOptions({ id: 'sh', directory: '/repo', transport: 'host-a' }, client), retry: false };
  sdk.output.mockResolvedValueOnce({ data: { output: '\x1b[32mOK\x1b[0m\r', cursor: 20, size: 30 } });
  const first = await client.fetchQuery(options);
  expect(sdk.output.mock.calls[0][0].cursor).toBe(0);
  expect(sdk.output.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  sdk.get.mockResolvedValue({ data: { status: 'exited' } });
  sdk.output.mockResolvedValueOnce({ data: { output: '\nfinished\n', cursor: 30, size: 30 } });
  const last = await client.fetchQuery(options);
  expect(sdk.output.mock.calls[1][0].cursor).toBe(20);
  expect(last.chunks.map(chunk => chunk.data).join('')).toBe('\x1b[32mOK\x1b[0m\r\nfinished\r\n');
  expect(last.status).toBe('exited');
  expect(first.chunks).toHaveLength(1);
  sdk.output.mockRejectedValueOnce(new Error('offline'));
  await expect(client.fetchQuery(options)).rejects.toThrow('offline');
  expect(client.getQueryData(options.queryKey)).toEqual(last);
  const other = shellLogQueryOptions({ id: 'sh', directory: '/repo', transport: 'host-b' }, client);
  expect(client.getQueryData(other.queryKey)).toBeUndefined();
  client.clear();
});

import { expect, it } from 'vitest';
import { discoverTerminalAction, terminalAutoDiscoverID, type TerminalDiscoveryFile } from './terminal-discovery';
const action = async (files: Partial<Record<TerminalDiscoveryFile, string>>, port: number | null = null) => {
  const reads: string[] = [];
  const value = await discoverTerminalAction({ directory: '/tree', actions: [], name: '预览', read: async file => { reads.push(file); return files[file] ?? null; }, freePort: async () => port });
  return { value, reads };
};
it('keeps actual owner priority: configured action first, then dev/start/preview/serve/develop scripts and package-manager hints', async () => {
  const configured = await discoverTerminalAction({ directory: '/tree', name: '发现', actions: [{ id: 'existing', name: 'dev server', command: 'configured' }], read: async () => { throw new Error('must not read'); }, freePort: async () => { throw new Error('must not allocate'); } });
  expect(configured).toMatchObject({ id: terminalAutoDiscoverID, command: 'configured', autoOpenUrl: true });
  expect((await action({ 'package.json': JSON.stringify({ scripts: { start: 'node server', dev: 'vite' }, packageManager: 'bun@1' }) })).value?.command).toBe('bun run --shell=bun dev');
  expect((await action({ 'package.json': JSON.stringify({ scripts: { 'start:web': 'start' } }), 'pnpm-lock.yaml': 'lock' })).value?.command).toBe('pnpm start:web');
  expect((await action({ 'package.json': JSON.stringify({ scripts: { preview: 'start' } }), 'bun.lock': 'lock', 'yarn.lock': 'lock' })).value?.command).toBe('bun run --shell=bun preview');
});
it('static-site preview allocates a real owner-provided port, absent result uses Web default, errors never look like empty success', async () => {
  expect((await action({ 'index.html': '<html />' }, 9123)).value).toMatchObject({ command: 'python3 -m http.server 9123', openUrl: 'http://127.0.0.1:9123/' });
  expect((await action({ 'index.html': '<html />' })).value?.command).toBe('python3 -m http.server 8000');
  expect((await action({})).value).toBeNull();
  await expect(action({ 'package.json': '{broken' })).rejects.toThrow();
  await expect(discoverTerminalAction({ directory: '/tree', actions: [], name: '发现', read: async () => { throw new Error('transport failure'); }, freePort: async () => null })).rejects.toThrow('transport failure');
});

import { expect, test } from 'vitest';
import { terminalDirectory, terminalDirectoryPath } from './terminal-path';
import { terminalCatalogFrom } from './terminal-catalog';
import { createTerminalWorkspace } from './terminal-core';

test('shared resource normalization admits drive/UNC roots and Unicode while retaining strict iOS/POSIX behavior', () => {
  for (const [source, expected] of [
    ['c:\\Users\\项目\\tree\\', 'C:/Users/项目/tree'], ['C:/', 'C:/'],
    ['\\\\server\\share\\tree', '//server/share/tree'], ['//server/share', '//server/share'],
    ['/workspace/中文 tree', '/workspace/中文 tree'], ['/', '/'],
  ]) expect(terminalDirectoryPath(source)).toBe(expected);
  for (const value of ['', 'relative', 'C:relative', '\\rooted', '//server', '//', '///x/a', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', '/x/..', '/x/./a', '/x//a', '/x\\a', '/x/', '/x\n']) expect(terminalDirectory(value)).toBe(false);
});

test('Windows aliases share tabs/catalog identities and exact normalized directory is sent to the existing native transport', async () => {
  const scope = { hostID: 'synthetic', lease: 'lease' }, calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const workspace = createTerminalWorkspace({ scope, subscribe: () => () => {}, changed: () => {}, call: async (name, body) => {
    calls.push({ name, body }); return name === 'terminal.create' ? { sessionId: 'synthetic-session' } : true;
  } });
  expect(workspace.setDirectory('c:\\Users\\项目')).toBe(true); const first = workspace.snapshot().activeId;
  workspace.setActive(true); workspace.resize({ cols: 80, rows: 24 });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(calls.find(call => call.name === 'terminal.create')?.body.directory).toBe('C:/Users/项目');
  workspace.setDirectory('C:/Users/项目'); expect(workspace.snapshot().activeId).toBe(first);
  workspace.setDirectory('\\\\server\\share'); const unc = workspace.snapshot().activeId;
  workspace.setDirectory('//server/share'); expect(workspace.snapshot().activeId).toBe(unc);
  const catalog = workspace.catalog();
  expect(terminalCatalogFrom(catalog, scope.hostID)?.directories.map(entry => entry.directory)).toEqual(['C:/Users/项目', '//server/share']);
  const duplicate = structuredClone(catalog); duplicate.directories.push({ ...duplicate.directories[0], directory: 'c:\\Users\\项目' });
  expect(terminalCatalogFrom(duplicate, scope.hostID)).toBe(null);
  workspace.dispose();
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { mergeSearchConversations, searchMessagesFrom, searchSessionsFrom } from './projects-search-core';
import { createHost } from './tests/history-focus-chat-host.js';

const cwd = path.dirname(fileURLToPath(import.meta.url));

test('history focus fixture pure contract: real content-search wire retains the exact message identity', () => {
  const host = createHost();
  const response = host.call('runtime.request', { path: '/api/yuri/content-search?q=Exact%20older&limit=30' });
  expect(response.status).toBe(200);
  const messages = searchMessagesFrom(response.body);
  expect(messages).toEqual([{ sessionID: 'ses_1', messageID: 'focus-older', title: 'Native conversation', directory: '/workspace/project', snippet: 'Exact older search target', role: 'user', createdAt: 1000 }]);
  const titles = host.call('runtime.request', { path: '/api/session?parentID=null&limit=30&order=desc&search=Exact%20older' });
  const rows = mergeSearchConversations(searchSessionsFrom(titles.body), messages);
  expect(rows).toHaveLength(1);
  expect(`projects-search-message:${rows[0].session.id}:${rows[0].hit?.messageID}`).toBe('projects-search-message:ses_1:focus-older');
});

test('history focus fixture pure contract: malformed content-search hits still fail explicitly', () => {
  const response = createHost().call('runtime.request', { path: '/api/yuri/content-search?q=Exact%20older&limit=30' });
  const hit = response.body.hits[0];
  for (const field of ['sessionID', 'messageID', 'directory', 'role', 'snippet', 'createdAt']) {
    const incomplete = { ...hit };
    delete incomplete[field];
    expect(() => searchMessagesFrom({ hits: [incomplete] }), `missing ${field}`).toThrow('Invalid content search identity');
  }
  for (const invalid of [{ sessionID: '' }, { messageID: '' }, { directory: '' }, { role: 'tool' }, { snippet: null }, { createdAt: '1000' }, { createdAt: NaN }, { createdAt: Infinity }]) {
    expect(() => searchMessagesFrom({ hits: [{ ...hit, ...invalid }] })).toThrow('Invalid content search identity');
  }
});

test('history focus fixture pure contract: exact target remains on the opaque older page', () => {
  const host = createHost();
  const first = host.call('runtime.request', { path: '/api/session/ses_1/message?limit=20' });
  expect(first.body.data).toHaveLength(20);
  expect(first.body.data.some(row => row.id === 'focus-older')).toBe(false);
  expect(first.body.cursor.next).toBe('opaque target ?/+');
  const older = host.call('runtime.request', { path: `/api/session/ses_1/message?limit=20&cursor=${encodeURIComponent(first.body.cursor.next)}` });
  expect(older.body.data).toEqual([{ id: 'focus-older', type: 'user', time: { created: 1000 }, content: [{ type: 'text', text: 'Exact older search target' }] }]);
  expect(older.body.cursor.next).toBeNull();
  const status = host.call('runtime.request', { path: '/api/git/status?directory=%2Fworkspace%2Fproject' });
  expect(status.body.current).toBe('Search pages:1');
});

test('production search forwards the exact message identity and loads its opaque history page (engine, not UIKit position evidence)', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'nsh-history-focus-chat-'));
  try {
    const fixture = path.join(temporary, 'host.js');
    const built = spawnSync('bun', ['build', 'tests/history-focus-chat-host.js', '--target=browser', '--outfile', fixture], { cwd, encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'App.tsx', '--web-host', fixture], { cwd, encoding: 'utf8', timeout: 60000, input: [
      'await app.waitFor("text:Native conversation");',
      'await app.press("id:projects-open-search");',
      'await app.waitFor("id:projects-global-search");',
      'await app.type("id:projects-global-search", "Exact older");',
      'await app.waitFor("id:projects-search-message:ses_1:focus-older");',
      'await app.press("id:projects-search-message:ses_1:focus-older");',
      'await app.waitFor("text:Exact older search target");',
      'expect(app.shows("id:composer")).toBe(true);',
      'await app.waitUntil(() => !app.shows("id:history-focus-status"));',
      'await app.press("id:chat-header-root >> id:chat-header-metadata");',
      'await app.waitFor("text:Search pages:1");',
      'await app.press("id:chat-header-root >> id:chat-header-metadata");',
      'await app.back();',
      'await app.waitFor("text:Native conversation");',
      'expect(app.shows("id:projects-global-search")).toBe(false);',
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 75000);

test('production message navigation delegates to the one native List command owner', () => {
  const source = readFileSync(path.join(cwd, 'application.tsx'), 'utf8');
  expect(source).toContain('messageID: options?.messageID');
  expect(source).toContain('messageID={route.messageID}');
  expect(source).toContain('createNativeHistoryFocus({');
  expect(source).toContain('ref={value => transcriptRef.set(value)}');
  expect(source).toContain('list.scrollToIndex({ index, animated: false, viewPosition: .5 });');
  expect(source).toContain('cleanup(() => messageFocus.cancel());');
});

import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeHistoryRows } from './history-rows';
import type { Message } from './model';
const message = (id: string, role = 'assistant'): Message => ({ id, role, text: id, reasoning: '', tools: [], cards: [], files: [], error: '' });

it('preserves the mounted assistant row key when older siblings enrich its real head', () => {
  const project = createNativeHistoryRows(), a = message('z-older'), b = message('a-mounted'), user = message('user', 'user');
  const before = project([b, user]), after = project([a, b, user]);
  expect(after.map(row => row.key)).toEqual(['user', 'a-mounted']);
  expect(after[1].head).toBe(a); expect(after[1].tail).toBe(b);
  expect(after[1].messages).toEqual([a, b]); expect(after[0]).toBe(before[0]);
});
it('keeps newest-first display separate from source order and reuses unchanged row references', () => {
  const project = createNativeHistoryRows(); const source = Array.from({ length: 5000 }, (_, i) => message(`row-${i}`, 'user'));
  const before = project(source); expect(project(source)).toBe(before);
  const next = project([...source, message('new', 'user')]);
  expect(source[0].id).toBe('row-0'); expect(next[0].key).toBe('new');
  // Only the previous live-tail row changes its isLastTurn flag.
  for (let i = 1; i < before.length; i++) expect(next[i + 1]).toBe(before[i]);
});
it('does not produce duplicate keys when an authority boundary splits a previous assistant run', () => {
  const project = createNativeHistoryRows(), a = message('a'), b = message('b'), boundary = message('boundary', 'user');
  project([a, b]); const after = project([a, boundary, b]);
  expect(new Set(after.map(row => row.key)).size).toBe(after.length);
  expect(after.map(row => row.key)).toEqual(['b', 'boundary', 'a']);
});
it('keeps a retained key with its real message if an enriched assistant run later splits', () => {
  const project = createNativeHistoryRows(), a = message('a'), b = message('b');
  project([b]); project([a, b]);
  const after = project([a, message('boundary', 'user'), b]);
  expect(after.map(row => row.key)).toEqual(['b', 'boundary', 'a']);
  expect(new Set(after.map(row => row.key)).size).toBe(after.length);
});

it('keeps the List item identity while eight older pages enrich one assistant group', () => {
  const project = createNativeHistoryRows();
  let messages = Array.from({ length: 20 }, (_, i) => message(`step-${200 + i}`));
  const first = project(messages)[0];
  for (let page = 1; page <= 8; page++) {
    messages = [...Array.from({ length: 20 }, (_, i) => message(`step-${200 - page * 20 + i}`)), ...messages];
    const rows = project(messages), keys = rows.map(row => row.key), byKey = new Map(rows.map(row => [row.key, row]));
    expect(keys).toEqual([first.key]);
    // A stable key does not make a replacement object the same NSH List item.
    expect(rows[0]).not.toBe(first);
    expect(byKey.get(keys[0])?.messages).toEqual(messages);
    expect(byKey.get(keys[0])?.tail).toBe(first.tail);
  }
});

it('production List matches primitive identities, not replacement grouped row objects', () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'application.tsx'), 'utf8');
  expect(source).toContain('const bodyRowKeys = computed(() => bodyRows().map(row => row.key));');
  expect(source).toContain('const bodyRowsByKey = computed(() => new Map(bodyRows().map(row => [row.key, row])));');
  expect(source).toContain('each={bodyRowKeys()}');
  expect(source).toContain('keyExtractor={key => key}');
  expect(source).toContain('when={bodyRowsByKey().get(key())}');
  expect(source).not.toContain('each={bodyRows()}');
});

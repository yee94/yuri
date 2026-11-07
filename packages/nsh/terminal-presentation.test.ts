import { expect, it } from 'vitest';
import { createTerminalPresentation } from './terminal-presentation';

it('sends each chunk once across 10,000 streaming events, not the growing scrollback', () => {
  const presentation = createTerminalPresentation(), chunks: { id: number; data: string }[] = [];
  let transferred = 0;
  for (let id = 1; id <= 10_000; id++) {
    chunks.push({ id, data: '中文 delta' });
    const message = presentation.next('tab', chunks, true)!;
    expect(message.chunks).toHaveLength(1); transferred += message.chunks.length;
    expect(presentation.acknowledge({ key: message.key, cursor: id, serial: message.serial })).toBe(true);
  }
  expect(transferred).toBe(10_000); expect(presentation.next('tab', chunks, true)).toBeUndefined();
});
it('bounds flight without dropping deltas, permits immediate pause and fences old ACKs', () => {
  const presentation = createTerminalPresentation();
  const chunks = [{ id: 1, data: 'a'.repeat(65_536) }, { id: 2, data: '中文' }];
  const first = presentation.next('first', chunks, true)!; expect(first.chunks.map(chunk => chunk.id)).toEqual([1]);
  expect(presentation.next('first', chunks, true)).toBeUndefined();
  expect(presentation.next('first', chunks, false)?.chunks).toEqual([]);
  expect(presentation.acknowledge({ key: 'first', serial: first.serial, cursor: 999 })).toBe(false);
  expect(presentation.acknowledge({ key: 'first', serial: first.serial, cursor: 1 })).toBe(true);
  const second = presentation.next('first', chunks, true)!; expect(second.chunks.map(chunk => chunk.id)).toEqual([2]);
  presentation.next('other', [], false);
  expect(presentation.acknowledge({ key: 'first', serial: second.serial, cursor: 2 })).toBe(false);
  presentation.reset(); expect(presentation.next('first', chunks, false)?.chunks[0].id).toBe(1);
});

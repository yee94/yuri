import { expect, test, vi } from 'vitest';
import { createDesktopAssistantReadSnapshot } from './desktop-assistant-read-snapshot';

const frame = { offset: { x: 0, y: 0 }, contentSize: { width: 400, height: 300 }, size: { width: 400, height: 300 } };
function setup() {
  const accept = vi.fn(), invalidateFrame = vi.fn();
  const waiters: Array<(value: typeof frame | null) => void> = [];
  const getScrollSnapshot = vi.fn(() => new Promise<typeof frame | null>(resolve => waiters.push(resolve)));
  let active = true, marker: object | null = {}, list: { getScrollSnapshot(): Promise<typeof frame | null> } | null = { getScrollSnapshot };
  let current = true, operation = { current: () => current, request: vi.fn() };
  let position = { generation: 1, ordinal: 1, messageID: 'latest' };
  const owner = createDesktopAssistantReadSnapshot({ current: () => active, list: () => list, marker: () => marker, operation: () => operation, position: () => position, invalidateFrame, accept });
  return { owner, accept, invalidateFrame, waiters, getScrollSnapshot, inactive: () => { active = false; }, resume: () => { active = true; }, retire: () => { current = false; },
    marker: () => { marker = {}; }, detach: () => { list = null; }, replace: () => { list = { getScrollSnapshot }; },
    operation: () => { operation = { current: () => true, request: vi.fn() }; }, position: () => { position = { ...position, ordinal: position.ordinal + 1 }; },
    mutatePosition: () => { position.ordinal++; } };
}
test('initial short List snapshot is passed through unchanged, without inventing an offset or an extra scroll writer', async () => {
  const h = setup(), pending = h.owner.request(); await Promise.resolve();
  expect(h.invalidateFrame).toHaveBeenCalledOnce(); expect(h.getScrollSnapshot).toHaveBeenCalledOnce(); expect(h.accept).not.toHaveBeenCalled();
  h.waiters[0](frame); await pending;
  expect(h.accept).toHaveBeenCalledExactlyOnceWith(frame); expect(h.accept.mock.calls[0][0]).toBe(frame);
});
for (const boundary of ['inactive', 'retire', 'marker', 'detach', 'replace', 'operation', 'position', 'mutatePosition'] as const) test(`late actual snapshot is rejected after ${boundary}`, async () => {
  const h = setup(), pending = h.owner.request(); await Promise.resolve();
  h[boundary](); h.waiters[0](frame); await pending;
  expect(h.accept).not.toHaveBeenCalled(); expect(h.getScrollSnapshot).toHaveBeenCalledOnce();
});
test('50 layout requests coalesce behind one read; only the newest real response can seed the reader', async () => {
  const h = setup(), first = h.owner.request(); await Promise.resolve();
  for (let index = 0; index < 50; index++) expect(h.owner.request()).toBe(first);
  expect(h.getScrollSnapshot).toHaveBeenCalledOnce(); h.waiters[0](frame); await Promise.resolve();
  expect(h.accept).not.toHaveBeenCalled(); expect(h.getScrollSnapshot).toHaveBeenCalledTimes(2);
  h.waiters[1](frame); await first;
  expect(h.accept).toHaveBeenCalledExactlyOnceWith(frame);
});
test('a newer real scroll event cancels a pending snapshot and does not request another read', async () => {
  const h = setup(), pending = h.owner.request(); await Promise.resolve();
  const away = { ...frame, offset: { x: 0, y: 80 } }; h.owner.scroll(away); h.waiters[0](frame); await pending;
  expect(h.accept).toHaveBeenCalledExactlyOnceWith(away); expect(h.getScrollSnapshot).toHaveBeenCalledOnce();
});
test('pause/resume events reject an old snapshot even when the same operation and refs survive', async () => {
  const h = setup(), pending = h.owner.request(); await Promise.resolve();
  h.inactive(); h.owner.request(); h.resume(); h.owner.request();
  h.waiters[0](frame); await Promise.resolve();
  expect(h.accept).not.toHaveBeenCalled(); expect(h.getScrollSnapshot).toHaveBeenCalledTimes(2);
  h.waiters[1](frame); await pending;
  expect(h.accept).toHaveBeenCalledExactlyOnceWith(frame);
});
test('null, throw and disposal never substitute zero or replay a read without an explicit event', async () => {
  const h = setup(), first = h.owner.request(); await Promise.resolve(); h.waiters[0](null); await first;
  expect(h.accept).not.toHaveBeenCalled(); expect(h.getScrollSnapshot).toHaveBeenCalledOnce();
  h.getScrollSnapshot.mockImplementationOnce(async () => { throw new Error('unsupported'); }); await h.owner.request();
  expect(h.accept).not.toHaveBeenCalled();
  const last = h.owner.request(); await Promise.resolve(); h.owner.dispose(); h.waiters[1](frame); await last;
  await h.owner.request(); h.owner.scroll(frame); expect(h.accept).not.toHaveBeenCalled(); expect(h.getScrollSnapshot).toHaveBeenCalledTimes(3);
});

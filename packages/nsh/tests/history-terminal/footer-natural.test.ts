import { expect, it, vi } from 'vitest';
import { createNaturalFooterReader } from './footer-natural';

const active = { scope: 'host/page/history-1', active: true, visible: true, contentKey: 'button' };
const frame = (height: number) => ({ bounds: { size: { height } } });
it('admits initial inactive layout and re-reads the first active natural ref', async () => {
  const accept = vi.fn(() => true), reader = createNaturalFooterReader(accept), node = { measure: vi.fn(async () => frame(37)) };
  reader.update({ ...active, active: false }); reader.attach(node);
  expect(reader.layout(node, active.scope, active.contentKey, 36)).toBe(true);
  reader.update(active); expect(await reader.measure()).toBe(true);
  expect(accept).toHaveBeenLastCalledWith(active.scope, 37, 'button');
});
it.each(['inactive', 'scope', 'content', 'ref', 'dispose', 'new-layout', 'hidden'] as const)('rejects a delayed ref result after %s changes', async change => {
  let resolve!: (value: ReturnType<typeof frame>) => void;
  const accept = vi.fn(() => true), reader = createNaturalFooterReader(accept), node = { measure: () => new Promise<ReturnType<typeof frame>>(done => { resolve = done; }) };
  reader.update(active); reader.attach(node); const pending = reader.measure();
  if (change === 'inactive') { reader.update({ ...active, active: false }); reader.update(active); }
  if (change === 'scope') reader.update({ ...active, scope: 'new-host' });
  if (change === 'content') reader.update({ ...active, contentKey: 'error+button' });
  if (change === 'hidden') reader.update({ ...active, visible: false });
  if (change === 'ref') reader.attach({ measure: async () => frame(9) });
  if (change === 'dispose') reader.invalidate();
  if (change === 'new-layout') reader.layout(node, active.scope, active.contentKey, 38);
  accept.mockClear(); resolve(frame(99));
  expect(await pending).toBe(false); expect(accept).not.toHaveBeenCalled();
});
it('does not admit hidden, stale node/key, or post-deactivation layout', () => {
  const accept = vi.fn(() => true), reader = createNaturalFooterReader(accept), node = { measure: async () => frame(36) };
  reader.update(active); reader.attach(node);
  expect(reader.layout(null, active.scope, 'button', 99)).toBe(false);
  expect(reader.layout(node, active.scope, 'old-key', 99)).toBe(false);
  reader.update({ ...active, active: false });
  expect(reader.layout(node, active.scope, 'button', 99)).toBe(false);
  reader.update({ ...active, visible: false });
  expect(reader.layout(node, active.scope, 'button', 99)).toBe(false);
  expect(accept).not.toHaveBeenCalled();
});
it('ignores a stale rejection but preserves a current measurement failure for explicit retry', async () => {
  let reject!: (reason: Error) => void;
  const reader = createNaturalFooterReader(() => true);
  reader.update(active); reader.attach({ measure: () => new Promise((_done, fail) => { reject = fail; }) });
  const stale = reader.measure(); reader.invalidate(); reject(new Error('old-ref'));
  expect(await stale).toBe(false);
  reader.update(active); reader.attach({ measure: async () => { throw new Error('current-ref'); } });
  await expect(reader.measure()).rejects.toThrow('current-ref');
  reader.attach({ measure: async () => frame(36) }); expect(await reader.measure()).toBe(true);
});

it.each(['lifecycle', 'content', 'ref', 'scope', 'visibility'] as const)('rejects an old layout source after a same-identity %s round trip', change => {
  const accept = vi.fn(() => true), reader = createNaturalFooterReader(accept), node = { measure: async () => frame(36) };
  reader.update(active); reader.attach(node);
  const oldLayout = reader.captureLayout(node, active.scope, active.contentKey);
  if (change === 'lifecycle') reader.update({ ...active, active: false });
  if (change === 'content') reader.update({ ...active, contentKey: 'error+button' });
  if (change === 'scope') reader.update({ ...active, scope: 'history-2' });
  if (change === 'visibility') reader.update({ ...active, visible: false });
  if (change === 'ref') { reader.attach(null); reader.attach(node); }
  reader.update(active);
  // Matching scope/key/ref values are insufficient after the source retired.
  expect(oldLayout(99)).toBe(false);
  expect(accept).not.toHaveBeenCalled();
  expect(reader.captureLayout(node, active.scope, active.contentKey)(37)).toBe(true);
  expect(accept).toHaveBeenLastCalledWith(active.scope, 37, active.contentKey);
});

it('keeps a mounted initial layout source through first activation and normal measurement tickets', async () => {
  const accept = vi.fn(() => true), reader = createNaturalFooterReader(accept), node = { measure: async () => frame(36) };
  reader.update({ ...active, active: false }); reader.attach(node);
  const layout = reader.captureLayout(node, active.scope, active.contentKey);
  expect(layout(35)).toBe(true);
  reader.update(active); expect(await reader.measure()).toBe(true);
  expect(layout(37)).toBe(true);
  reader.invalidate();
  expect(layout(99)).toBe(false);
});

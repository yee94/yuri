import { expect, it, vi } from 'vitest';
import { createDesktopChatHeaderOwner } from './desktop-chat-header-owner';
import { createDesktopHeaderQuotaPresentation } from './desktop-header-quota-presentation';

it('optional desktop metadata never bypasses sourceQuota identity or retained-owner stale overlay during metadata-only updates', async () => {
  let now = 1000, enumerations = 0;
  const read = vi.fn(async (path: string): Promise<unknown> => {
    if (path === '/api/config/settings') return { usageDropdownProviders: ['google'], usageShowPredValues: true };
    if (path === '/api/quota/providers') return { providers: ['google'] };
    if (path.startsWith('/api/quota/magpie?')) return { sources: [] };
    if (path === '/api/quota/google') return { providerId: 'google', configured: true, ok: true, usage: {
      windows: { weekly: { usedPercent: 20, remainingPercent: 80, resetAt: Date.now() + 300000000, windowSeconds: 604800 } },
      models: new Proxy({ 'gemini/real': { windows: { weekly: { usedPercent: 30 } } } }, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } }),
    } };
    if (path.includes('/catalog/providers')) return { schemaVersion: 1, providers: [] };
    if (path.includes('/message?')) return { data: [] };
    if (path.includes('/git/status')) return { current: 'main', files: [] };
    return { data: { id: 'session', title: 'Title' } };
  });
  const lane = () => ({ current: () => true, request: read });
  let operation = lane();
  const owner = createDesktopChatHeaderOwner({ target: { kind: 'session', id: 'session', title: '', directory: '/fixture' }, operation: () => operation, current: () => true, changed: () => {}, now: () => now });
  owner.update({ readDemand: true }); await owner.refresh(); await owner.refreshQuotas();
  const original = owner.snapshot().quota!, desktop = original.groups[0].desktop;
  expect(original.lastUpdated).toBe(1000); expect(enumerations).toBe(1);
  now = 2000; operation = lane(); owner.update({ readDemand: true }); await owner.refresh();
  const stale = owner.snapshot().quota!;
  expect(stale).not.toBe(original); expect(stale.groups[0].desktop).toBe(desktop); expect(stale.groups[0].stale).toBe(true); expect(stale.lastUpdated).toBe(1000);
  const presentation = createDesktopHeaderQuotaPresentation(key => key, () => 'en-US');
  expect(presentation.row(desktop!.entries[0], stale.groups[0], stale)).toMatchObject({ pace: null, expected: null, stale: true });
  const reads = read.mock.calls.length;
  for (let index = 0; index < 50; index++) owner.update({ readDemand: true, busy: false });
  expect(read).toHaveBeenCalledTimes(reads); expect(enumerations).toBe(1); expect(owner.snapshot().quota).toBe(stale);
  await owner.refresh(true); expect(owner.snapshot().quota).toBe(stale); expect(owner.snapshot().quota!.groups[0].desktop).toBe(desktop);
  await owner.refreshQuotas(); expect(owner.snapshot().quota!.groups[0].stale).toBe(false); expect(owner.snapshot().quota!.lastUpdated).toBe(2000); expect(enumerations).toBe(2);
  owner.dispose();
});

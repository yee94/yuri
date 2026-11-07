import { describe, expect, it } from 'vitest';
import { bindGuiPluginPreview, presentGuiPluginPreview, readGuiPluginInventory, validateGuiPluginPreviewIntent } from './gui-plugin-preview';

describe('framework-neutral GUI preview contract', () => {
  const scope = { hostID: 'synthetic-host', lease: 'synthetic-scope' };
  it('keeps inventory failures distinct from empty success, rejecting missing/duplicate owner IDs', () => {
    expect(readGuiPluginInventory([])).toEqual([]);
    expect(readGuiPluginInventory([{ id: 'server-only', features: {}, state: { status: 'active' } }])).toEqual([
      { id: 'server-only', features: { gui: false }, state: { status: 'active' } },
    ]);
    for (const value of [undefined, {}, [{ features: { gui: true }, state: { status: 'active' } }],
      [{ id: '', features: { gui: true }, state: { status: 'active' } }],
      [{ id: 'one', features: {}, state: { status: 'unknown' } }],
      [{ id: 'one', features: {}, state: { status: 'active' } }, { id: 'one', features: {}, state: { status: 'active' } }],
    ]) expect(() => readGuiPluginInventory(value)).toThrow('GUI_PLUGIN_INVALID_INVENTORY');
  });
  it('does not infer a suffix parser, first session, endpoint, or browser URL', async () => {
    const calls: unknown[] = [];
    for (const path of ['/work/报告 #.eficy', 'reports/data.report.json', 'C:\\work\\data.report']) {
      const intent = { sessionId: 'actual-session', directory: '/work', path };
      expect(validateGuiPluginPreviewIntent(intent)).toEqual(intent);
      await presentGuiPluginPreview(async (name, input) => { calls.push([name, input]); expect(input.expectedHost).toEqual(scope); expect(input.owner).toBe('owner-A'); expect(Object.isFrozen(input.expectedHost)).toBe(true); return { closed: true }; }, intent, scope, () => true, 'owner-A');
    }
    expect(calls).toHaveLength(3);
    expect(calls.every(call => Array.isArray(call) && call[0] === 'plugins.preview.present')).toBe(true);
    for (const path of ['https://outside.invalid/a.eficy', 'javascript:alert(1)', 'data:text/plain,x', '/work/a\0.eficy']) {
      expect(() => validateGuiPluginPreviewIntent({ sessionId: 's', directory: '/work', path })).toThrow('GUI_PLUGIN_INVALID_INPUT');
    }
    await expect(presentGuiPluginPreview(async () => ({ success: true }), { sessionId: 's', directory: '/work', path: 'a.report' }, scope, () => true, 'owner-A')).rejects.toThrow('GUI_PLUGIN_INVALID_OUTPUT');
    let current = true;
    await expect(presentGuiPluginPreview(async () => { current = false; return { closed: true }; }, { sessionId: 's', directory: '/work', path: 'a.report' }, scope, () => current, 'owner-A')).rejects.toThrow('runtime_host_scope_stale');
  });
  it('binds every open and late cleanup to its exact owner, even before present settles', async () => {
    const calls: { name: string; owner: unknown }[] = [];
    const replies = new Map<unknown, (result: unknown) => void>();
    let sequence = 0;
    const bound = bindGuiPluginPreview(scope, async (name, input) => {
      calls.push({ name, owner: input.owner }); expect(input.expectedHost).toEqual(scope);
      if (name === 'plugins.preview.close') return true;
      return new Promise(resolve => { replies.set(input.owner, resolve); });
    }, () => `owner-${++sequence}`, () => true);
    const intent = { sessionId: 's', directory: '/work', path: 'a.report' };
    const a = bound.present(intent);
    await bound.close();
    const b = bound.present(intent);
    replies.get('owner-1')?.({ closed: true }); await a;
    expect(calls.filter(call => call.name === 'plugins.preview.close')).toEqual([{ name: 'plugins.preview.close', owner: 'owner-1' }]);
    replies.get('owner-2')?.({ closed: true }); await b;
    expect(calls.at(-1)).toEqual({ name: 'plugins.preview.close', owner: 'owner-2' });
  });
});

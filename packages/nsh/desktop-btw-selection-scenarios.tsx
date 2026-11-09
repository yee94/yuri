import { expect, open, test } from 'nsh/test';

async function launch(platform: 'macos' | 'windows', empty = false) {
  const events: Array<{ name: string; value?: unknown }> = [], requests: string[] = [];
  const app = await open('./App.tsx', { platform, width: 800, height: 900, host: { params: { empty }, handlers: {
    'btw.fixture': (value: { name: string; value?: unknown }) => { events.push(value); },
    'runtime.request': (input: { path: string }) => { requests.push(input.path); throw new Error('Readonly BTW label must not request a catalog or write Host state'); },
  } } });
  const control = (action: string, value?: unknown) => app.host.send('btw.control', { action, value });
  const stats = async () => { await control('stats'); return app.texts().find(value => /^\d+$/.test(value)); };
  return { app, control, stats, events, requests };
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' readonly model logo/name, no Agent, variant or picker; 50 edits and hide/show/50 edits do not read labels/catalogs or mutate selection', async () => {
    const f = await launch(platform); await f.app.waitFor('id:btw-model-control');
    expect(f.app.texts()).toContain('GPT-4o Mini'); expect(f.app.texts()).not.toContain('do-not-render-agent'); expect(f.app.texts()).not.toContain('High');
    expect(f.app.shows('id:btw-model')).toBe(false); expect(f.app.shows('id:btw-agent')).toBe(false);
    await f.control('label', { scope: 'first', providerID: 'fixture', modelID: 'gpt-4o-mini', label: 'Authoritative catalog name' });
    await f.app.waitFor('text:Authoritative catalog name');
    const before = await f.stats();
    for (let index = 0; index < 50; index++) await f.app.type('id:btw-editor', 'x');
    expect(await f.stats()).toBe(before); expect(f.requests).toEqual([]);
    await expect(f.app.press('id:btw-model-control')).rejects.toThrow(); expect(f.app.shows('id:btw-selection-dialog')).toBe(false);
    await f.control('visible', false); await f.control('visible', true);
    const after = await f.stats();
    for (let index = 0; index < 50; index++) await f.app.type('id:btw-editor', 'y');
    expect(await f.stats()).toBe(after); expect(f.requests).toEqual([]);
    expect(f.app.value('id:btw-editor')).toBe('x'.repeat(50) + 'y'.repeat(50)); expect(f.app.value('id:main-editor')).toBe('main draft');
    expect(f.events.every(event => event.name === 'snapshot')).toBe(true);
    expect(f.events[f.events.length - 1].value).toEqual({ providerID: 'fixture', modelID: 'gpt-4o-mini', variant: 'high', agent: 'do-not-render-agent' });
  });
  test(platform + ' missing/partial snapshots render nothing, exact authoritative label updates and mismatched/late projections use the shared fallback', async () => {
    const f = await launch(platform, true); await f.app.waitFor('id:btw-editor');
    expect(f.app.shows('id:btw-model-control')).toBe(false);
    await f.control('selection', { providerID: 'fixture' }); expect(f.app.shows('id:btw-model-control')).toBe(false);
    await f.control('selection', { modelID: 'claude-sonnet-4-5' }); expect(f.app.shows('id:btw-model-control')).toBe(false);
    await f.control('selection', { providerID: 'fixture', modelID: 'claude-sonnet-4-5', variant: null });
    await f.app.waitFor('text:Claude Sonnet 4.5');
    await f.control('label', { scope: 'first', providerID: 'other', modelID: 'claude-sonnet-4-5', label: 'Wrong provider name' });
    expect(f.app.texts()).not.toContain('Wrong provider name');
    await f.control('label', { scope: 'first', providerID: 'fixture', modelID: 'other-model', label: 'Wrong model name' });
    expect(f.app.texts()).not.toContain('Wrong model name');
    await f.control('label', { scope: 'first', providerID: 'fixture', modelID: 'claude-sonnet-4-5', label: 'Current display name' });
    await f.app.waitFor('text:Current display name');
    await f.control('scope', 'second'); await f.app.waitFor('text:Claude Sonnet 4.5');
    await f.control('label', { scope: 'first', providerID: 'fixture', modelID: 'claude-sonnet-4-5', label: 'Late retired display name' });
    expect(f.app.texts()).not.toContain('Late retired display name'); expect(f.requests).toEqual([]);
    await f.control('stats'); expect(f.events[f.events.length - 1].value).toEqual({ providerID: 'fixture', modelID: 'claude-sonnet-4-5', variant: null });
  });
  test(platform + ' pending/current changes leave readonly metadata and both drafts intact; no selection writes', async () => {
    const f = await launch(platform); await f.app.waitFor('id:btw-editor');
    await f.app.type('id:btw-editor', 'retained side draft'); await f.control('pending', true);
    await f.app.waitFor('id:btw-stop'); expect(f.app.shows('id:btw-model-control')).toBe(true);
    await f.control('pending', false); await f.control('current', false); expect(f.app.shows('id:btw-model-control')).toBe(false); await f.control('current', true);
    expect(f.app.texts()).toContain('GPT-4o Mini'); expect(f.app.value('id:btw-editor')).toBe('retained side draft'); expect(f.app.value('id:main-editor')).toBe('main draft');
    expect(f.events.filter(event => event.name === 'selected')).toEqual([]); expect(f.requests).toEqual([]);
  });
}

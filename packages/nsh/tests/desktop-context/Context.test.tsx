import { expect, open, test } from 'nsh/test';

async function launch(platform) {
  const events = [];
  const app = await open('./App.tsx', { platform, width: 900, height: 900, host: { handlers: { 'desktop.context.audit': value => { events.push(value); } } } });
  const control = (action, value = undefined) => app.host.send('desktop.context.control', { action, value });
  const stats = async () => { await control('stats'); return events.filter(event => event.event === 'stats').at(-1).value; };
  const reveal = async selector => { for (let step = 0; step < 16 && !app.shows(selector); step++) await app.scroll('id:desktop-context-list', 160); await app.waitFor(selector); };
  return { app, events, control, stats, reveal };
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' inactive has no reads; complete native workbench content preserves original composer and performs no per-key history/catalog scans', async () => {
    const f = await launch(platform);
    for (let index = 0; index < 50; index++) await f.control('noise');
    expect(await f.stats()).toMatchObject({ reads: 0, scans: 0, subscriptions: 0 });
    await f.control('active', true); await f.app.waitFor('id:desktop-context-total');
    expect(f.app.texts()).toContain('28,900 / 400,000'); expect(f.app.texts()).toContain('Context overview production fixture');
    expect(f.app.texts().some(value => value.includes('Actual provider / Actual model'))).toBe(true);
    for (const label of ['Messages', 'User', 'Assistant', 'Cost', 'Session TPS', 'Input', 'Output', 'Reasoning', 'Cache Read', 'Cache Write', 'Cache Hit', 'TPS', 'Raw Messages']) expect(f.app.texts()).toContain(label);
    expect(f.app.texts()).toContain('$0.0050'); expect(f.app.texts()).toContain('500.0 tok/s');
    const before = await f.stats();
    for (let index = 0; index < 50; index++) await f.control('noise');
    await f.app.type('id:desktop-context-fixture-composer', 'x'.repeat(50));
    expect(await f.stats()).toEqual(before); expect(f.app.value('id:desktop-context-fixture-composer')).toBe('Keep original composer' + 'x'.repeat(50));
  });
  test(platform + ' newest raw message expands/copies literal wire JSON; modal retains projection but revokes actions; streaming changes only original committed row', async () => {
    const f = await launch(platform); await f.control('active', true);
    await f.reveal('id:desktop-context-expand-final'); await f.app.press('id:desktop-context-expand-final'); await f.app.waitFor('id:desktop-context-json-final');
    await f.app.press('id:desktop-context-copy-final'); await f.app.waitUntil(() => f.app.clipboard() !== null);
    expect(JSON.parse(f.app.clipboard()).info.id).toBe('final'); expect(JSON.parse(f.app.clipboard()).parts[0].text).toContain('``` and <b>not markup</b>');
    const before = await f.stats(); await f.control('interactive', false);
    expect(await f.stats()).toEqual(before); expect(f.app.shows('id:desktop-context-json-final')).toBe(true);
    await expect(f.app.press('id:desktop-context-copy-final')).rejects.toMatchObject({ code: 'ERR_NSH_TEST_DISABLED' });
    await f.control('interactive', true); await f.control('patch');
    const after = await f.stats(); expect(after.reads).toBe(before.reads); expect(after.scans).toBe(before.scans); expect(after.operations.resets).toBe(before.operations.resets); expect(after.operations.messageVisits).toBe(before.operations.messageVisits + 1);
    await f.app.press('id:desktop-context-copy-final'); await f.app.waitUntil(() => f.app.clipboard().includes('currentContent'));
    expect(JSON.parse(f.app.clipboard()).currentContent[0].text).toBe('Latest original Chat commit');
  });
  test(platform + ' failed refresh keeps full summary and explicit Retry recovers; successful empty is distinct; live locale/TPS preferences update without new metadata reads', async () => {
    const f = await launch(platform); await f.control('active', true); await f.app.waitFor('id:desktop-context-total');
    await f.control('fail'); await f.app.waitFor('id:desktop-context-error'); expect(f.app.texts()).toContain('28,900 / 400,000');
    await f.control('recover'); await f.app.press('id:desktop-context-retry'); await f.app.waitFor('id:desktop-context-error', { state: 'gone' });
    await f.control('retry-messages'); await f.app.press('id:desktop-context-retry'); await f.app.waitFor('id:desktop-context-error', { state: 'gone' });
    expect(f.events.filter(event => event.event === 'original-message-retry')).toHaveLength(1);
    const before = await f.stats(); await f.control('tps', false); expect(f.app.shows('id:desktop-context-session-tps')).toBe(false);
    await f.control('language', 'zh-CN'); expect(f.app.texts()).toContain('原始消息'); await f.control('language', 'en');
    expect((await f.stats()).reads).toBe(before.reads);
    await f.control('empty'); expect(f.app.texts()).toContain('$0.00'); expect(f.app.texts()).not.toContain('28,900 / 400,000');
  });
  test(platform + ' inactive/background unsubscribes and retained owner resumes once; mismatched scope and authority retirement never render old data', async () => {
    const f = await launch(platform); await f.control('active', true); await f.app.waitFor('id:desktop-context-total');
    const before = await f.stats(); await f.control('active', false); await f.control('patch');
    const hidden = await f.stats(); expect(hidden.listeners).toBe(0); expect(hidden.operations).toEqual(before.operations);
    await f.control('active', true); const resumed = await f.stats(); expect(resumed.operations.resets).toBe(before.operations.resets + 1); expect(resumed.reads).toBe(before.reads);
    await f.app.setLifecycle('background'); expect((await f.stats()).listeners).toBe(0);
    await f.app.setLifecycle('active'); expect((await f.stats()).listeners).toBe(1);
    await f.control('retire'); expect(f.app.shows('id:desktop-context-summary')).toBe(false); expect((await f.stats()).listeners).toBe(0);
    await f.control('mismatch'); await f.app.waitFor('id:desktop-context-unavailable'); expect(f.app.shows('id:desktop-context-summary')).toBe(false);
  });
}

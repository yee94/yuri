import { expect, open, test } from 'nsh/test';

async function launch(platform: 'macos' | 'windows', unavailable = false, customSlot = false) {
  const events: Array<{ name: string; value?: unknown }> = [];
  const app = await open('./App.tsx', { platform, width: 800, height: 900, host: { params: { unavailable, customSlot }, handlers: { 'btw.fixture': (value: { name: string; value?: unknown }) => { events.push(value); } } } });
  const control = (action: string, value?: unknown, index?: number) => app.host.send('btw.control', { action, value, index });
  return { app, events, control, count: (name: string) => events.filter(value => value.name === name).length };
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' product view: literal editor, quotes, selection, Markdown/footer/copy/speech and retained tab/page', async () => {
    const f = await launch(platform); await f.app.waitFor('id:btw-empty');
    expect(f.count('generate')).toBe(0); expect(f.count('apply')).toBe(0);
    await f.control('quote', 'quoted source'); await f.app.waitFor('id:btw-quote-0');
    await f.control('quote', 'remove this'); await f.app.press('id:btw-remove-quote-1'); expect(f.app.shows('id:btw-quote-1')).toBe(false);
    const renders = f.app.texts().find(value => value.startsWith('selection-renders:'));
    for (let index = 0; index < 50; index++) await f.app.type('id:btw-editor', 'x');
    expect(f.app.texts()).toContain(renders); expect(f.count('generate')).toBe(0);
    await f.control('visible', false); await f.control('visible', true);
    expect(f.app.value('id:btw-editor')).toBe('x'.repeat(50)); expect(f.count('handle')).toBe(1);
    await f.app.clear('id:btw-editor'); await f.app.paste('id:btw-editor', { text: 'question\nsecond line' });
    await f.app.press('id:btw-model'); await f.app.press('id:btw-agent');
    await f.app.submit('id:btw-editor'); expect(f.app.value('id:btw-editor')).toBe(''); await f.app.waitFor('id:btw-stop');
    expect(f.count('generate')).toBe(1); expect(f.events.find(value => value.name === 'apply')?.value).toEqual({ providerID: 'openai', modelID: 'chosen-model', agent: 'chosen-agent' });
    expect(String((f.events.find(value => value.name === 'generate')?.value as { prompt: string }).prompt)).toContain('> quoted source');
    await f.app.type('id:btw-editor', 'draft while pending');
    await f.control('answer', '# Heading\n\n**answer**\n\n```ts\nconst x = 1;\n```');
    await f.app.waitFor('id:btw-footer-btw_1'); expect(f.app.shows('id:btw-answer-btw_1')).toBe(true);
    expect(f.app.texts()).toContain('Heading'); expect(f.app.texts()).toContain('0.0s');
    await f.app.hover('id:btw-answer-btw_1'); await f.app.press('label:Copy code'); expect(f.app.clipboard()).toBe('const x = 1;');
    await f.app.press('id:btw-copy-btw_1'); expect(f.count('copied')).toBe(1);
    await f.app.press('id:btw-speech-btw_1'); expect(f.count('spoken')).toBe(1);
    await f.app.press('id:btw-speech-btw_1'); expect(f.count('speech-stopped')).toBe(1);
    await f.control('interactive', false); expect(f.app.shows('label:Copy code')).toBe(false); expect(f.app.enabled('id:btw-copy-btw_1')).toBe(false);
    await f.control('interactive', true);
    await f.control('foot', 'page'); expect(f.app.shows('id:desktop-btw-page')).toBe(true);
    expect(f.app.value('id:btw-editor')).toBe('draft while pending'); expect(f.count('handle')).toBe(1);
    await f.control('visible', false); await f.control('visible', true); expect(f.count('generate')).toBe(1);
  });
  test(platform + ' pending/failed/cancelled retry, hidden retention, activity and exact scope cleanup fences', async () => {
    const f = await launch(platform); await f.app.waitFor('id:btw-editor');
    await f.control('ask', 'first'); await f.app.waitFor('id:btw-stop');
    await f.control('visible', false); expect(f.count('aborted')).toBe(0);
    await f.control('answer', 'hidden answer'); await f.control('visible', true); await f.app.waitFor('id:btw-answer-btw_1');
    await f.app.press('id:btw-retry'); await f.control('error', undefined, 1); await f.app.waitFor('id:btw-turn-error');
    await f.app.press('id:btw-retry'); await f.app.waitFor('id:btw-stop'); await f.app.press('id:btw-stop'); await f.app.waitFor('id:btw-cancelled');
    await f.control('answer', 'late cancelled answer', 2); expect(f.app.texts()).not.toContain('late cancelled answer');
    await f.control('interactive', false); await f.control('ask', 'blocked'); expect(f.count('generate')).toBe(3); expect(f.app.enabled('id:btw-retry')).toBe(false);
    await f.control('interactive', true); await f.control('ask', 'leave session'); await f.control('active', false); expect(f.count('aborted')).toBe(2);
    await f.control('active', true); await f.control('save-handle'); await f.control('scope', 'other');
    await f.app.waitFor('id:btw-empty'); await f.control('ask', 'new scope'); await f.control('stale-close'); expect(f.events[f.events.length - 1].value).toBe(false);
    await f.control('answer', 'old scope reply', 3); expect(f.app.texts()).not.toContain('old scope reply');
    await f.control('answer', 'new scope reply', 4); await f.app.waitFor('id:btw-answer-btw_3');
    await f.app.press('id:btw-speech-btw_3'); expect(f.count('spoken')).toBe(1);
    await f.control('close'); expect(f.events.some(value => value.name === 'closed-scope' && value.value === 'other')).toBe(true);
    expect(f.count('speech-stopped')).toBe(1);
    await f.control('scope', 'third'); await f.control('visible', true); await f.app.waitFor('id:btw-empty');
  });
  test(platform + ' missing generate never consumes draft or accepts asks; current/background retire in-flight answer', async () => {
    const blocked = await launch(platform, true); await blocked.app.waitFor('id:btw-unavailable');
    await blocked.app.type('id:btw-editor', 'retain question'); await blocked.app.submit('id:btw-editor');
    expect(blocked.app.value('id:btw-editor')).toBe('retain question'); expect(blocked.count('generate')).toBe(0);
    await blocked.control('ask', 'not accepted'); expect(blocked.events[blocked.events.length - 1].value).toBe(false);
    const f = await launch(platform); await f.control('ask', 'background'); await f.app.setLifecycle('background'); expect(f.count('aborted')).toBe(1);
    await f.app.setLifecycle('active'); await f.control('ask', 'retire'); await f.control('current', false); expect(f.count('aborted')).toBe(2);
    await f.control('current', true); await f.control('ask', 'host switch'); await f.control('save-handle'); await f.control('host');
    await f.control('ask', 'new host'); await f.control('stale-close'); expect(f.events[f.events.length - 1].value).toBe(false);
    await f.control('answer', 'old host', 2); expect(f.app.texts()).not.toContain('old host');
  });
  test(platform + ' real selection slot stays isolated from typing and copy failure remains visible', async () => {
    const f = await launch(platform, false, true); await f.app.waitFor('id:btw-selection-slot');
    const renders = f.count('slot-render');
    for (let index = 0; index < 50; index++) await f.app.type('id:btw-editor', 'x');
    expect(f.count('slot-render')).toBe(renders); expect(f.count('generate')).toBe(0);
    await f.app.press('id:btw-selection-slot'); expect(f.app.texts()).toContain('slot-model');
    await f.app.submit('id:btw-editor'); await f.control('answer', 'copy failure'); await f.app.waitFor('id:btw-copy-btw_1');
    await f.app.press('id:btw-copy-btw_1'); await f.app.waitFor('id:btw-copy-error');
    await f.control('interactive', false); expect(f.app.enabled('id:btw-selection-slot')).toBe(false);
    expect(f.events.find(value => value.name === 'apply')?.value).toEqual({ providerID: 'openai', modelID: 'slot-model', agent: 'slot-agent' });
  });
}

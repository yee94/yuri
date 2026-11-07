import { describe, expect, test, vi } from 'vitest';
import { compileNativePrompt, magicCommand, magicCommands, renderNativeTemplate } from './composer';
import { nativeMagicDefaults } from './settings-magic-defaults';

describe('native composer prompt compilation', () => {
  test('plain text and registered Host commands perform zero magic catalog reads', async () => {
    const send = vi.fn();
    for (const text of ['hello', '/goal clear', '/review branch', '/custom value', 'literal /explore']) {
      expect(await compileNativePrompt({ text, files: [] }, send)).toEqual({ text, files: [] });
    }
    expect(send).not.toHaveBeenCalled();
  });
  test.each(magicCommands)('/$name uses the same visible/instructions text as Web', async item => {
    const send = vi.fn(async () => ({ version: 1, overrides: {} }));
    const expected = [nativeMagicDefaults[item.prompt + '.visible'], nativeMagicDefaults[item.prompt + '.instructions']]
      .map(template => renderNativeTemplate(template, {})).join('\n');
    expect(await compileNativePrompt({ text: `/${item.name}`, files: [] }, send)).toEqual({ text: expected, files: [] });
    expect(send).toHaveBeenCalledExactlyOnceWith('/api/magic-prompts');
  });
  test('summary topic, craft-goal argument, slot paste and case match Web', async () => {
    const send = async () => ({ version: 1, overrides: {
      'session.summary.visible': 'Summary{{topic_line}}',
      'session.summary.instructions': '{{topic_block}}',
      'session.craftGoal.visible': 'Goal{{idea_block}}',
      'session.craftGoal.instructions': '',
    } });
    expect(magicCommand('  /\u2003EXPLORE ')).toMatchObject({ name: 'explore' });
    expect((await compileNativePrompt({ text: '/summary latency', files: [] }, send)).text).toBe('Summary focused on: latency\nThe user asked you to focus this summary on: latency. Prioritize that topic; mention unrelated threads only in passing.');
    expect((await compileNativePrompt({ text: '/craft-goal preserve data', files: [] }, send)).text).toBe('Goal\n\nHere is my initial idea:\npreserve data');
  });
  test('custom overrides and attachments survive; failed or malformed reads reject instead of sending defaults', async () => {
    const files = [{ uri: 'file:///neutral.png', name: 'neutral.png', mime: 'image/png' }];
    const input = { text: '/debug', files };
    expect(await compileNativePrompt(input, async () => ({ version: 1, overrides: { 'session.debug.visible': 'custom', 'session.debug.instructions': 'instructions' } })))
      .toEqual({ text: 'custom\ninstructions', files });
    await expect(compileNativePrompt(input, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    await expect(compileNativePrompt(input, async () => ({ unavailable: true }))).rejects.toThrow();
    expect(input).toEqual({ text: '/debug', files });
  });
  test('each submission resolves the current Host overrides with no cross-Host cache', async () => {
    for (const label of ['host A', 'host B']) {
      const compiled = await compileNativePrompt({ text: '/explore', files: [] }, async () => ({ version: 1, overrides: { 'session.explore.visible': label, 'session.explore.instructions': '' } }));
      expect(compiled.text).toBe(label);
    }
  });
});

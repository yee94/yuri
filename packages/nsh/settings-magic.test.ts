import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { nativeMagicDefaults, nativeMagicDescriptions, nativeMagicPlaceholders } from './settings-magic-defaults';
import { createMagicPromptsEditor, magicPromptGroups, parseMagicOverrides } from './settings-magic-state';

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(directory, '../ui/src/lib/magicPrompts.ts'), 'utf8');
const start = source.indexOf('const MAGIC_PROMPT_DEFINITIONS:');
const literal = source.slice(source.indexOf('= [', start) + 2, source.indexOf('] as const;', start) + 1);
const webDefinitions = runInNewContext('(' + literal + ')', {}, { timeout: 500 }) as { id: string; template: string; description: string; placeholders?: { key: string }[] }[];

describe('Magic Prompts Web/native parity', () => {
  it('contains every Web built-in template byte-for-byte, including empty instructions and placeholders', () => {
    expect(nativeMagicDefaults).toEqual(Object.fromEntries(webDefinitions.map(item => [item.id, item.template])));
    expect(nativeMagicDescriptions).toEqual(Object.fromEntries(webDefinitions.map(item => [item.id, item.description])));
    expect(Object.fromEntries(webDefinitions.map(item => [item.id, nativeMagicPlaceholders[item.id] || []]))).toEqual(Object.fromEntries(webDefinitions.map(item => [item.id, (item.placeholders || []).map(item => item.key)])));
    expect(magicPromptGroups.flatMap(group => group.entries.flatMap(item => [item.id + '.visible', item.id + '.instructions'])).sort()).toEqual(Object.keys(nativeMagicDefaults).sort());
  });
  it('retains every mobile sidebar group and item in its original order', () => {
    const sidebar = readFileSync(path.join(directory, '../ui/src/components/sections/magic-prompts/MagicPromptsSidebar.tsx'), 'utf8');
    const entries = [...sidebar.matchAll(/\{ id: '([^']+)', titleKey: 'settings\.magicPrompts\.sidebar\.item\.([^']+)' \}/g)].map(match => ({ id: match[1], label: match[2] }));
    expect(magicPromptGroups.map(group => group.group)).toEqual(['git', 'github', 'session']);
    expect(magicPromptGroups.flatMap(group => group.entries.map(({ id, label }) => ({ id, label })))).toEqual(entries);
  });
  it('migrates legacy combined prompts exactly like Web without overriding newer split values', () => {
    expect(parseMagicOverrides({ version: 1, overrides: { 'git.commit.generate': ' visible\n instructions ', 'git.commit.generate.visible': 'new split', ignored: 123 } })).toEqual({ 'git.commit.generate': ' visible\n instructions ', 'git.commit.generate.visible': 'new split', 'git.commit.generate.instructions': 'instructions' });
    expect(() => parseMagicOverrides({ version: 1 })).toThrow('Invalid settings response');
    expect(() => parseMagicOverrides({ version: 2, overrides: {} })).toThrow('Invalid magic prompts version');
  });
});

describe('Magic Prompts native editor', () => {
  const id = 'git.commit.generate.visible';
  const fixture = (overrides: Record<string, string> = {}) => {
    let saved = { ...overrides };
    const send = vi.fn(async (path: string, method?: string, body?: unknown) => {
      const key = decodeURIComponent(path.slice('/api/magic-prompts/'.length));
      if (method === 'PUT') saved[key] = (body as { text: string }).text;
      if (method === 'DELETE') { if (path === '/api/magic-prompts') saved = {}; else delete saved[key]; }
      return { version: 1, overrides: { ...saved } };
    });
    const changes = vi.fn();
    const editor = createMagicPromptsEditor(send, () => true, changes);
    return { send, editor, changes };
  };
  it('loads authoritative overrides and edits independent visible/instructions drafts', async () => {
    const { editor, send } = fixture({ [id]: 'server override' });
    await editor.load();
    expect(editor.value(id)).toBe('server override');
    const instructionsID = 'git.commit.generate.instructions';
    editor.setDraft(id, 'new visible'); editor.setDraft(instructionsID, 'new instructions');
    await editor.save(id);
    expect(send).toHaveBeenLastCalledWith('/api/magic-prompts/git.commit.generate.visible', 'PUT', { text: 'new visible' });
    expect(editor.dirty(id)).toBe(false);
    expect(editor.dirty(instructionsID)).toBe(true);
    expect(editor.value(instructionsID)).toBe('new instructions');
  });
  it('saves a built-in default by deleting the override, not by persisting a redundant copy', async () => {
    const { editor, send } = fixture({ [id]: 'server override' });
    await editor.load(); editor.setDraft(id, nativeMagicDefaults[id]); await editor.save(id);
    expect(send).toHaveBeenLastCalledWith('/api/magic-prompts/git.commit.generate.visible', 'DELETE', undefined);
    expect(editor.overridden(id)).toBe(false);
    expect(editor.value(id)).toBe(nativeMagicDefaults[id]);
  });
  it('forbids empty visible prompts but preserves explicit empty instructions overrides', async () => {
    const { editor, send } = fixture(); await editor.load();
    editor.setDraft(id, '  '); await editor.save(id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(editor.snapshot().error).toBe('settings.magicPrompts.page.toast.visiblePromptRequired');
    editor.setDraft('git.commit.generate.instructions', ''); await editor.save('git.commit.generate.instructions');
    expect(send).toHaveBeenLastCalledWith('/api/magic-prompts/git.commit.generate.instructions', 'PUT', { text: '' });
    expect(editor.value('git.commit.generate.instructions')).toBe('');
  });
  it('retains both drafts and previous overrides across a rejected write and failed reload', async () => {
    const { editor, send } = fixture({ [id]: 'before' }); await editor.load();
    editor.setDraft(id, 'retained draft'); editor.setDraft('git.commit.generate.instructions', 'other draft');
    send.mockRejectedValueOnce(new Error('HTTP 409'));
    await editor.save(id);
    expect(editor.value(id)).toBe('retained draft');
    expect(editor.snapshot().overrides[id]).toBe('before');
    expect(editor.snapshot().error).toBe('settings.magicPrompts.page.toast.saveFailed');
    send.mockRejectedValueOnce(new Error('network')); await editor.load();
    expect(editor.snapshot().ready).toBe(true);
    expect(editor.value('git.commit.generate.instructions')).toBe('other draft');
    await editor.save(id); expect(editor.snapshot().overrides[id]).toBe('retained draft');
  });
  it('restores one block only after confirmed reset and keeps unrelated drafts', async () => {
    const { editor, send } = fixture({ [id]: 'before' }); await editor.load();
    editor.setDraft(id, 'unsaved'); editor.setDraft('git.commit.generate.instructions', 'other draft');
    send.mockRejectedValueOnce(new Error('network')); await editor.reset(id);
    expect(editor.value(id)).toBe('unsaved');
    await editor.reset(id);
    expect(editor.value(id)).toBe(nativeMagicDefaults[id]);
    expect(editor.value('git.commit.generate.instructions')).toBe('other draft');
  });
  it('resets all overrides and drafts only after server success, including unknown future overrides', async () => {
    const { editor, send } = fixture({ [id]: 'before', 'future.prompt': 'keep until confirmed' }); await editor.load(); editor.setDraft(id, 'unsaved');
    send.mockRejectedValueOnce(new Error('network')); await editor.resetAll();
    expect(editor.value(id)).toBe('unsaved'); expect(editor.snapshot().overrides['future.prompt']).toBe('keep until confirmed');
    await editor.resetAll();
    expect(send).toHaveBeenLastCalledWith('/api/magic-prompts', 'DELETE', undefined);
    expect(editor.snapshot().drafts).toEqual({}); expect(editor.snapshot().overrides).toEqual({});
  });
  it('ignores a retired Host response and refuses mutation on a replaced Host', async () => {
    let current = true;
    let finish!: (value: unknown) => void;
    const send = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const changed = vi.fn(), editor = createMagicPromptsEditor(send, () => current, changed);
    const loading = editor.load(); current = false; finish({ version: 1, overrides: { [id]: 'old host' } }); await loading;
    expect(editor.snapshot().ready).toBe(false);
    await editor.save(id); expect(send).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls.some(call => call[0].ready)).toBe(false);
  });
});

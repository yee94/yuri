import { describe, expect, test, vi } from 'vitest';
import { nativeAgentEditor, nativeAgentPatch, nativeCollectionChanges, nativeCollectionDraft, nativeMcpImport } from './settings-collections-core';
import { settingsMutation } from './settings-protocol';

describe('native Agent editor uses the real catalog and stored prompt', () => {
  test('object identity includes nested variant and preserves untouched catalog fields', async () => {
    const send = vi.fn(async () => ({ config: { prompt: 'Stored prompt', system: 'Older system' } }));
    const editor = await nativeAgentEditor(send, { name: 'review/a', model: { providerID: 'provider', modelID: 'model/id', variant: 'high' }, permission: [{ action: 'shell', resource: '*', effect: 'ask' }] }, '/work tree');
    expect(send).toHaveBeenCalledWith('/api/config/agents/review%2Fa/config?directory=%2Fwork%20tree');
    expect(editor.model).toBe('provider/model/id#high');
    expect(editor.system).toBe('Stored prompt');
    expect(editor.permissions).toEqual([{ action: 'shell', resource: '*', effect: 'ask' }]);
    const edits = nativeAgentPatch(nativeCollectionChanges({ ...editor, description: 'New description' }, editor, { description: 'New description' }));
    expect(settingsMutation('agents', 'review/a', { ...edits, scope: editor.scope }, false, '/work tree').body).toEqual({ native: { description: 'New description' }, scope: 'user' });
  });
  test.each([
    [{ model: { providerID: 'p', id: 'm' }, variant: 'fast' }, { prompt: '{file:./system.md}', system: 'Do not use me' }, 'p/m#fast', ''],
    [{ model: 'p/m#steady' }, { system: 'Legacy system' }, 'p/m#steady', 'Legacy system'],
    [{ model: null }, {}, '', ''],
  ])('reads catalog fallback identity and only editable stored prompt', async (catalog, config, model, system) => {
    const editor = await nativeAgentEditor(async () => ({ config }), { name: 'agent', ...catalog });
    expect(editor.model).toBe(model); expect(editor.system).toBe(system);
  });
  test('read failure rejects rather than allowing an empty prompt overwrite', async () => {
    await expect(nativeAgentEditor(async () => { throw new Error('Offline'); }, { name: 'agent' })).rejects.toThrow('Offline');
  });
  test('disabled metadata without catalog model can display its stored string without resubmitting it', async () => {
    const initial = await nativeAgentEditor(async () => ({ config: { model: 'p/m#stored', prompt: 'Stored disabled prompt', steps: 8, hidden: true } }), { name: 'disabled', disabled: true, scope: 'project' }, '/workspace');
    expect(initial.model).toBe('p/m#stored'); expect(initial.steps).toBe(8); expect(initial.hidden).toBe(true);
    expect(nativeAgentPatch(nativeCollectionChanges({ ...initial, disabled: false }, initial, { disabled: false }))).toEqual({ disabled: false });
  });
  test('reverting a field omits it; explicit clear is null, not a guessed catalog replacement', () => {
    const initial = { model: 'p/m#v', system: 'Original', description: 'Old', hidden: true };
    const edited = { ...initial, system: '', description: 'Changed' };
    expect(nativeAgentPatch(nativeCollectionChanges(edited, initial, { system: '', description: 'Changed', model: '', hidden: false }))).toEqual({ system: null, description: 'Changed' });
    expect(nativeAgentPatch({ model: '  ', description: '', system: ' New ' })).toEqual({ model: null, description: null, system: 'New' });
  });
});

describe('native MCP import is the Web pure parser, not a save/connect operation', () => {
  test('remote draft retains all OAuth options and maps the existing Host body', () => {
    const result = nativeMcpImport(JSON.stringify({ mcp: { remote: { type: 'remote', url: 'https://mcp.example.test', headers: { 'X-Example': '{env:MCP_HEADER}' }, oauth: { clientId: 'example-client', clientSecret: '{env:MCP_SECRET}', scope: 'read write', redirectUri: 'https://callback.example.test' }, timeout: 12000, enabled: false } } }), '', true);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.name).toBe('remote');
    expect(result.fields.oauth).toEqual({ clientId: 'example-client', clientSecret: '{env:MCP_SECRET}', scope: 'read write', redirectUri: 'https://callback.example.test' });
    expect(result.fields.timeout).toBe(12000); expect(result.fields.enabled).toBe(false);
    expect(settingsMutation('mcp', result.name, { ...result.fields, scope: 'project' }, true, '/workspace').body).toEqual({ ...result.fields, scope: 'project' });
  });
  test('local import clears remote-only options without mutating the input', () => {
    const source = JSON.stringify({ mcpServers: { local: { command: 'npx', args: ['example-mcp'], env: { EXAMPLE: 'value' } } } });
    const result = nativeMcpImport(source, 'existing', false);
    expect(result).toEqual({ ok: true, name: 'existing', fields: { type: 'local', command: ['npx', 'example-mcp'], url: '', environment: { EXAMPLE: 'value' }, headers: {}, oauth: false, timeout: null, enabled: true } });
  });
  test.each(['', '{invalid', '[]', '{}', '{"mcpServers":{"a":{},"b":{}}}'])('invalid input remains an explicit parse failure (%s)', source => {
    const result = nativeMcpImport(source, 'draft', true);
    expect(result.ok).toBe(false); if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});

test('copy preparation keeps unknown Agent fields and has no mutations', async () => {
  const send = vi.fn(async () => ({ scope: 'project', source: 'md', config: { prompt: 'stored', request: { temperature: .3 }, custom: { keep: true }, model: 'p/m#v' } }));
  const result = await nativeCollectionDraft(send, 'agents', { name: 'agent', scope: 'project' }, '/captured');
  expect(result.config).toEqual({ prompt: 'stored', request: { temperature: .3 }, custom: { keep: true }, model: 'p/m#v' });
  expect(result.editor.system).toBe('stored');
  expect(send.mock.calls).toEqual([['/api/config/agents/agent/config?directory=%2Fcaptured']]);
});

test('skill copy hydrates every supporting file and preserves frontmatter extensions before any save', async () => {
  const send = vi.fn(async (path: string): Promise<unknown> => {
    if (path.includes('/api/fs/read')) return '---\nname: original\ndescription: keep\nlicense: MIT\nmetadata:\n  custom: keep\n---\n\nComplete instructions';
    if (path.includes('/files/')) return { content: 'full helper source' };
    return { sources: { md: { path: '/captured/SKILL.md', supportingFiles: [{ path: 'scripts/helper.ts' }] } } };
  });
  const result = await nativeCollectionDraft(send, 'skills.installed', { name: 'original', scope: 'project' }, '/captured');
  expect(result.config).toMatchObject({ name: 'original', license: 'MIT', metadata: { custom: 'keep' }, instructions: 'Complete instructions', supportingFiles: [{ path: 'scripts/helper.ts', content: 'full helper source' }] });
  expect(send.mock.calls.every(call => !call[1])).toBe(true);
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createProjectSettingsEditor, projectSettingsSetupEditable, type ProjectSettingsSnapshot } from './project-settings';
import { createHost } from './tests/project-settings-host.js';
import type { SettingsRequest } from './settings-protocol';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'settings-projects.tsx'), 'utf8');
const syntax = ts.createSourceFile('settings-projects.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);

function jsxExpression(element: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): string {
  const attribute = element.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(syntax) === name);
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) return 'undefined';
  if (ts.isJsxExpression(attribute.initializer)) return attribute.initializer.expression?.getText(syntax) || 'undefined';
  return attribute.initializer.getText(syntax);
}

/** Exercise the production Each's actual of/key expressions, not a replacement renderer or guessed key policy. */
function productionSetupKeys(snapshot: ProjectSettingsSnapshot): unknown[] {
  let each: ts.JsxOpeningElement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(syntax) === 'Each' && node.getText(syntax).includes('testID={`project-setup-command-')) each = node.openingElement;
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  if (!each) throw new Error('Production setup Each not found');
  const props = vm.runInNewContext(`({ of: ${jsxExpression(each, 'of')}, key: ${jsxExpression(each, 'key')} })`, { auxiliary: () => snapshot }) as { of: unknown[]; key?: 'index' | ((value: unknown, index: number) => unknown) };
  return Array.from(props.of, (value, index) => props.key === 'index' ? index : typeof props.key === 'function' ? props.key(value, index) : value);
}

function productionSetupInput(editor: ReturnType<typeof createProjectSettingsEditor>, id: string, confirming = false) {
  let input: ts.JsxSelfClosingElement | undefined, disabled: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(syntax) === 'SettingsInput' && jsxExpression(node, 'testID').includes('project-setup-command-')) input = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === 'setupInputDisabled') disabled = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  if (!input || !disabled) throw new Error('Production setup input bindings not found');
  return vm.runInNewContext(`(() => { const setupInputDisabled = ${disabled.getText(syntax)}; return { disabled: () => ${jsxExpression(input, 'disabled')}, value: () => ${jsxExpression(input, 'value')}, onChange: ${jsxExpression(input, 'onChange')} }; })()`, {
    auxiliary: editor.snapshot, editor, confirming: () => confirming, projectSettingsSetupEditable,
    commandID: () => id, index: () => editor.snapshot().commandIDs.indexOf(id),
    auxiliaryDisabled: () => !!editor.snapshot().busy || !!editor.snapshot().pending || !editor.snapshot().ready.setup,
  }) as { disabled: () => boolean; value: () => string; onChange: (value: string) => void };
}

function fixture(options: { readbackFailures?: number } = {}) {
  const host = createHost({ writeFailures: 0, readbackFailures: 0, ...options });
  let gatePath = '', release: (() => void) | undefined;
  let entered: Promise<void> = Promise.resolve(), enter: (() => void) | undefined;
  const send: SettingsRequest = async (resource, method = 'GET', body) => {
    if (gatePath && resource.startsWith(gatePath) && (gatePath !== '/api/fs/read' || host.inspect().writes > 0)) {
      gatePath = ''; enter?.();
      await new Promise<void>(resolve => { release = resolve; });
    }
    const result = host.call('runtime.request', { path: resource, method, body });
    if (typeof result.status !== 'number') throw new Error('Fixture request returned no HTTP status');
    if (result.status < 200 || result.status >= 300) throw Object.assign(new Error(`HTTP ${result.status}`), { status: result.status });
    return result.body;
  };
  const editor = createProjectSettingsEditor(send, () => true, { id: 'catalog-do-not-use', path: '/fixture/root' }, () => undefined);
  return { host, editor, block(resource: string) { gatePath = resource; entered = new Promise<void>(resolve => { enter = resolve; }); }, entered: () => entered, release: () => release?.() };
}

describe('production setup input ownership (pure, no native engine)', () => {
  it('keeps the actual production row key through multi-character, composition-like and deletion values', async () => {
    const { editor, host } = fixture(); await editor.load();
    const initial = productionSetupKeys(editor.snapshot());
    for (const value of ['e', 'ed', 'edited setup fixture', 'n', 'ni', '你', '你好', '你好🙂', '你好', '', 'restored fixture']) {
      editor.edit('setup', { commands: [value, editor.snapshot().commands[1]] });
      expect(productionSetupKeys(editor.snapshot())).toEqual(initial);
      expect(editor.snapshot().commands[0]).toBe(value);
    }
    expect(host.inspect().writes).toBe(0);
  });

  it('keeps unique identities for duplicate text, neighbor deletion and delayed callbacks to deleted rows', async () => {
    const { editor, host } = fixture(); await editor.load();
    const original = editor.snapshot().commandIDs;
    editor.updateCommand(original[0], 'same command'); editor.updateCommand(original[1], 'same command');
    expect(editor.snapshot().commandIDs).toBe(original);
    editor.appendCommand();
    const added = editor.snapshot().commandIDs[2];
    editor.updateCommand(added, 'same command');
    expect(new Set(productionSetupKeys(editor.snapshot())).size).toBe(3);
    const neighborInput = productionSetupInput(editor, original[1]);
    editor.removeCommand(original[0]);
    expect(editor.snapshot().commandIDs).toEqual([original[1], added]);
    expect(productionSetupKeys(editor.snapshot())).toEqual([original[1], added]);
    neighborInput.onChange('neighbor complete input');
    expect(neighborInput.value()).toBe('neighbor complete input');
    expect(editor.snapshot().commands).toEqual(['neighbor complete input', 'same command']);
    const beforeLate = editor.snapshot();
    editor.updateCommand(original[0], 'late deleted input'); editor.removeCommand(original[0]);
    expect(editor.snapshot()).toBe(beforeLate);
    editor.removeCommand(original[1]); editor.removeCommand(added);
    expect(editor.snapshot().commands).toEqual(['']);
    const emptyID = editor.snapshot().commandIDs[0];
    expect([...original, added]).not.toContain(emptyID);
    expect(productionSetupKeys(editor.snapshot())).toEqual([emptyID]);
    expect(host.inspect().writes).toBe(0);
    await editor.save('setup');
    expect(editor.snapshot().commandIDs).toEqual([emptyID]);
    expect(host.inspect().config['setup-worktree']).toEqual([]);
    expect(host.inspect().config).not.toHaveProperty('commandIDs');
  });

  it('forwards complete production onChange values without disabling the input for save/pending states', async () => {
    const f = fixture();
    expect(productionSetupInput(f.editor, 'not-loaded').disabled()).toBe(true);
    await f.editor.load();
    const id = f.editor.snapshot().commandIDs[0], ids = f.editor.snapshot().commandIDs;
    const input = productionSetupInput(f.editor, id);
    expect(input.disabled()).toBe(false);
    expect(productionSetupInput(f.editor, id, true).disabled()).toBe(true);
    input.onChange('e');
    f.block('/api/fs/write');
    const saving = f.editor.save('setup'); await f.entered();
    try {
      expect(f.editor.snapshot().pending).toBe('setup');
      expect(input.disabled()).toBe(false);
      for (const value of ['edited setup fixture', 'ni', '你', '完整🙂', '完整', '']) {
        input.onChange(value); expect(input.value()).toBe(value);
        expect(f.editor.snapshot().commandIDs).toBe(ids);
      }
      input.onChange('later complete input');
    } finally { f.release(); await saving; }
    expect(input.value()).toBe('later complete input');
    expect(f.editor.snapshot().commandIDs).toBe(ids);
    expect(f.editor.dirty('setup')).toBe(true);
    await f.editor.save('setup');
    expect(input.value()).toBe('later complete input');
    expect(f.editor.snapshot().commandIDs).toBe(ids);
    expect(f.editor.dirty('setup')).toBe(false);
    expect(f.host.inspect().config['setup-worktree']).toEqual(['later complete input', 'fixture setup two']);
  });

  it.each(['/api/fs/home', '/api/fs/write', '/api/fs/read'])('accepts later complete input during an auto-save awaiting %s and keeps it dirty after old read-back', async resource => {
    const f = fixture(); await f.editor.load();
    f.editor.edit('setup', { commands: ['e', 'fixture setup two'] });
    f.block(resource);
    const saving = f.editor.save('setup'); await f.entered();
    try {
      for (const value of ['ed', 'edited setup fixture', '输入完整🙂', '输入完整🙂 retained']) f.editor.edit('setup', { commands: [value, 'fixture setup two'] });
      expect(f.editor.snapshot().commands[0]).toBe('输入完整🙂 retained');
    } finally { f.release(); await saving; }
    expect(f.editor.snapshot().commands[0]).toBe('输入完整🙂 retained');
    expect(f.editor.dirty('setup')).toBe(true);
    expect(f.host.inspect().config['setup-worktree']).toEqual(['e', 'fixture setup two']);
    await f.editor.save('setup');
    expect(f.host.inspect().config['setup-worktree']).toEqual(['输入完整🙂 retained', 'fixture setup two']);
    expect(f.editor.dirty('setup')).toBe(false);
  });

  it('retains later wait and structural edits while confirming only the captured submit snapshot', async () => {
    const f = fixture(); await f.editor.load();
    const ids = f.editor.snapshot().commandIDs;
    f.editor.updateCommand(ids[0], 'submitted setup');
    f.block('/api/fs/read');
    const saving = f.editor.save('setup'); await f.entered();
    try {
      f.editor.edit('setup', { wait: false });
      f.editor.removeCommand(ids[0]); f.editor.appendCommand();
      f.editor.updateCommand(f.editor.snapshot().commandIDs[1], 'later added setup');
    } finally { f.release(); await saving; }
    expect(f.editor.snapshot()).toMatchObject({ commands: ['fixture setup two', 'later added setup'], wait: false, saved: null });
    expect(f.editor.snapshot().commandIDs[0]).toBe(ids[1]);
    expect(f.editor.dirty('setup')).toBe(true);
    expect(f.host.inspect().config).toMatchObject({ 'setup-worktree': ['submitted setup', 'fixture setup two'], 'setup-worktree-wait': true });
    await f.editor.save('setup');
    expect(f.host.inspect().config).toMatchObject({ 'setup-worktree': ['fixture setup two', 'later added setup'], 'setup-worktree-wait': false });
    expect(f.editor.dirty('setup')).toBe(false);
  });

  it('keeps the production setup input editable after read-back failure without unlocking action edits or replaying ACK', async () => {
    const f = fixture({ readbackFailures: 1 }); await f.editor.load();
    const id = f.editor.snapshot().commandIDs[0], ids = f.editor.snapshot().commandIDs;
    const input = productionSetupInput(f.editor, id);
    input.onChange('submitted setup'); await f.editor.save('setup');
    expect(f.editor.snapshot()).toMatchObject({ pending: 'setup', busy: null });
    expect(input.disabled()).toBe(false);
    const actions = f.editor.snapshot().actions;
    f.editor.edit('actions', { actions: [] }); expect(f.editor.snapshot().actions).toBe(actions);
    input.onChange('complete pending input');
    expect(input.value()).toBe('complete pending input');
    await f.editor.save('setup');
    expect(f.host.inspect().writes).toBe(1);
    expect(input.value()).toBe('complete pending input');
    expect(f.editor.snapshot().commandIDs).toBe(ids);
    expect(f.editor.dirty('setup')).toBe(true);
    expect(f.editor.snapshot().saved).toBeNull();
    await f.editor.save('setup');
    expect(f.host.inspect().writes).toBe(2);
    expect(f.host.inspect().config['setup-worktree']).toEqual(['complete pending input', 'fixture setup two']);
    expect(f.editor.dirty('setup')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createProjectIdFromPath } from '../ui/src/lib/projectId';
import { PROJECT_ACTION_ICONS } from '../ui/src/lib/projectActions';
import { createProjectSettingsEditor, parseProjectSettingsFile, projectSettingsActionIcons, projectSettingsActionsValid, projectSettingsFile, projectSettingsIdentityMatches, projectSettingsUpdates, type ProjectSettingsDraft } from './project-settings';
import { createHost } from './tests/project-settings-host.js';
import type { SettingsRequest } from './settings-protocol';

function fixture(options: { writeFailures?: number; readbackFailures?: number } = {}) {
  const host = createHost({ writeFailures: 0, readbackFailures: 0, ...options });
  let current = true;
  const send: SettingsRequest = async (path, method = 'GET', body) => {
    const result = host.call('runtime.request', { path, method, body });
    if (result.status < 200 || result.status >= 300) throw Object.assign(new Error(`HTTP ${result.status}: ${String((result.body as { error?: string }).error)}`), { status: result.status });
    return result.body;
  };
  const editor = createProjectSettingsEditor(send, () => current, { id: 'catalog-do-not-use', path: '/fixture/root/' }, () => undefined);
  return { host, editor, send, leave: () => { current = false; } };
}

describe('project settings path and payload parity', () => {
  it('confirms cleared identity fields after the real Host omission rules, without accepting an old nonempty value', () => {
    expect(projectSettingsIdentityMatches({ label: 'Saved', iconBackground: null }, { label: 'Saved', icon: null, color: null, iconBackground: null }, ['label', 'icon', 'color', 'iconBackground', 'defaultModel'])).toBe(true);
    expect(projectSettingsIdentityMatches({ label: 'Old' }, { label: 'Saved' }, ['label'])).toBe(false);
    expect(projectSettingsIdentityMatches({ color: 'primary' }, { color: null }, ['color'])).toBe(false);
  });
  it('keeps every action icon key and artwork identical to the Web catalog without importing its desktop type graph in Native', () => {
    expect(projectSettingsActionIcons).toEqual(PROJECT_ACTION_ICONS.map(({ key, Icon }) => ({ key, Icon })));
  });
  it.each(['/fixture/root', '/fixture/中文', 'C:\\workspace\\root'])('uses the Web path-derived ID, not a catalog/worktree ID: %s', root => {
    const normalized = root.replace(/\\/g, '/');
    expect(projectSettingsFile('/host/home/', { id: 'wrong', path: root + '/' })).toBe(`/host/home/.config/yuri/projects/${createProjectIdFromPath(normalized)}.json`);
  });
  it('rejects malformed/empty/file-error payloads rather than treating them as empty authority', () => {
    for (const input of ['', '{', '[]', 'null', '{"success":false}', { content: '{}' }]) expect(() => parseProjectSettingsFile(input)).toThrow();
  });
  it('filters blank setup commands but keeps ordering and meaningful whitespace', () => {
    expect(projectSettingsUpdates({ actions: [], commands: ['  ', 'one\ntwo', '  three  ', ''], wait: true }, 'setup')).toEqual({ 'setup-worktree': ['one\ntwo', '  three  '], 'setup-worktree-wait': true });
  });
  it('validates required action fields and applies Web limits without losing mobile-hidden metadata', () => {
    const action = { id: 'a', name: ' name ', command: ' command ', icon: ' rocket ', autoOpenUrl: false, openUrl: ' http://fixture.invalid ', desktopOpenSshForward: 'desktop', platforms: ['linux'], unknown: 4 };
    const draft: ProjectSettingsDraft = { actions: [action], commands: [], wait: false };
    expect(projectSettingsUpdates(draft, 'actions')).toEqual({ projectActions: [{ ...action, name: 'name', command: 'command', icon: 'rocket', openUrl: 'http://fixture.invalid', autoOpenUrl: undefined }] });
    expect(projectSettingsActionsValid([{ ...action, name: ' ' }])).toBe(false);
    expect(projectSettingsActionsValid([{ ...action, id: ' ' }])).toBe(false);
    expect(projectSettingsActionsValid([action, { ...action, id: ' a ' }])).toBe(false);
    expect(() => projectSettingsUpdates({ ...draft, actions: [{ ...action, command: '' }] }, 'actions')).toThrow();
    const limited = projectSettingsUpdates({ ...draft, actions: [{ ...action, name: 'x'.repeat(90), command: 'y'.repeat(4010) }] }, 'actions').projectActions as typeof action[];
    expect(limited[0].name).toHaveLength(80); expect(limited[0].command).toHaveLength(4000);
  });
});

describe('isolated project settings editor lifecycle', () => {
  it('loads without any write or action/setup execution and makes no request during draft edits', async () => {
    const { editor, host } = fixture(); await editor.load();
    expect(editor.snapshot()).toMatchObject({ ready: { actions: true, setup: true }, wait: true, commands: ['fixture setup one', 'fixture setup two'] });
    const before = host.inspect().requests.length;
    editor.edit('actions', { actions: [...editor.snapshot().actions, { id: 'new', name: '', command: '' }] });
    expect(editor.dirty('actions')).toBe(true); expect(host.inspect().requests).toHaveLength(before); expect(host.inspect().writes).toBe(0);
    await editor.save('actions'); expect(host.inspect().writes).toBe(0); expect(editor.snapshot().actions).toHaveLength(2);
  });
  it('keeps the exact draft on rejected writes, supports retry, and authoritatively adopts the trimmed result', async () => {
    const { editor, host } = fixture({ writeFailures: 1 }); await editor.load();
    editor.edit('actions', { actions: [{ ...editor.snapshot().actions[0], name: ' Edited ' }] });
    await editor.save('actions'); expect(editor.snapshot().errors.actions).toContain('409'); expect(editor.snapshot().actions[0].name).toBe(' Edited '); expect(editor.dirty('actions')).toBe(true);
    await editor.save('actions'); expect(editor.snapshot().actions[0].name).toBe('Edited'); expect(editor.dirty('actions')).toBe(false);
    expect(host.inspect().writes).toBe(2); expect(host.inspect().config).not.toHaveProperty('projectActionsPrimaryId');
    expect(host.inspect().config).toMatchObject({ scheduledTasks: [{ id: 'server-owned' }], 'setup-worktree-wait': true, projectActions: [{ desktopOpenSshForward: 'preserved-forward', platforms: ['linux'], extra: 7 }] });
  });
  it('never replays an acknowledged write after failed read-back and keeps later setup input dirty through reconciliation', async () => {
    const { editor, host } = fixture({ readbackFailures: 1 }); await editor.load();
    editor.edit('setup', { commands: ['new fixture setup'], wait: false }); await editor.save('setup');
    expect(editor.snapshot().pending).toBe('setup'); expect(editor.snapshot().errors.setup).toContain('503');
    editor.edit('setup', { commands: ['later complete setup input'] }); expect(editor.snapshot().commands).toEqual(['later complete setup input']);
    await editor.save('setup'); expect(editor.snapshot().pending).toBeNull(); expect(editor.dirty('setup')).toBe(true); expect(host.inspect().writes).toBe(1);
    expect(editor.snapshot().commands).toEqual(['later complete setup input']); expect(editor.snapshot().saved).toBeNull();
    expect(host.inspect().config['setup-worktree']).toEqual(['new fixture setup']);
    await editor.save('setup'); expect(editor.dirty('setup')).toBe(false); expect(host.inspect().writes).toBe(2);
    expect(host.inspect().config['setup-worktree']).toEqual(['later complete setup input']);
  });
  it('supports add/edit/delete including delete-all and preserves the other unsaved section', async () => {
    const { editor, host } = fixture(); await editor.load();
    editor.edit('setup', { commands: ['unsaved other section'] });
    editor.edit('actions', { actions: [] }); await editor.save('actions');
    expect(host.inspect().config.projectActions).toEqual([]); expect(editor.snapshot().commands).toEqual(['unsaved other section']); expect(editor.dirty('setup')).toBe(true);
    editor.edit('actions', { actions: [{ id: 'added', name: 'New fixture', command: 'never executed', icon: 'build' }] }); await editor.save('actions');
    expect(host.inspect().config.projectActions).toEqual([{ id: 'added', name: 'New fixture', command: 'never executed', icon: 'build' }]);
    await editor.save('setup'); expect(host.inspect().config['setup-worktree']).toEqual(['unsaved other section']);
  });
  it('keeps a newly added blank command row after auto-save while omitting it from persisted commands', async () => {
    const { editor, host } = fixture(); await editor.load();
    editor.edit('setup', { commands: [...editor.snapshot().commands, ''] }); await editor.save('setup');
    expect(editor.snapshot().commands).toEqual(['fixture setup one', 'fixture setup two', '']); expect(editor.dirty('setup')).toBe(false);
    expect(host.inspect().config['setup-worktree']).toEqual(['fixture setup one', 'fixture setup two']);
    editor.edit('setup', { commands: ['fixture setup one', 'fixture setup two', 'third fixture'] }); await editor.save('setup');
    expect(host.inspect().config['setup-worktree']).toEqual(['fixture setup one', 'fixture setup two', 'third fixture']);
  });
  it('rebases unrelated fresh config but detects same-section conflicts without overwriting them', async () => {
    const { editor, host } = fixture(); await editor.load();
    editor.edit('setup', { commands: ['local'] });
    host.replace({ ...host.inspect().config, external: 'preserved fresh value' }); await editor.save('setup'); expect(host.inspect().config.external).toBe('preserved fresh value');
    editor.edit('setup', { commands: ['second local draft'] }); host.replace({ ...host.inspect().config, 'setup-worktree': ['external edit'] });
    await editor.save('setup'); expect(editor.snapshot().errors.setup).toContain('changed since loading'); expect(editor.snapshot().commands).toEqual(['second local draft']); expect(host.inspect().writes).toBe(1);
    await editor.reload('setup'); expect(editor.snapshot().commands).toEqual(['external edit']); expect(editor.dirty('setup')).toBe(false);
  });
  it('keeps malformed actions independent from valid setup and can retry just the failed section', async () => {
    const { editor, host } = fixture(); host.replace({ ...host.inspect().config, projectActions: [{ id: 'broken' }] }); await editor.load();
    expect(editor.snapshot().ready).toEqual({ actions: false, setup: true }); expect(editor.snapshot().errors.actions).not.toBe('');
    editor.edit('setup', { commands: ['other draft'] }); host.replace({ ...host.inspect().config, projectActions: [] }); await editor.reload('actions');
    expect(editor.snapshot().ready.actions).toBe(true); expect(editor.snapshot().commands).toEqual(['other draft']);
  });
  it('does not convert a failed initial read into an editable empty configuration', async () => {
    const editor = createProjectSettingsEditor(async () => { throw new Error('offline'); }, () => true, { id: 'x', path: '/fixture/root' }, () => undefined);
    await editor.load(); expect(editor.snapshot().ready).toEqual({ actions: false, setup: false }); expect(editor.snapshot().errors.actions).toBe('offline');
    editor.edit('actions', { actions: [] }); await editor.save('actions'); expect(editor.snapshot().busy).toBeNull();
  });
  it('reads a legacy config only after canonical 404 and saves to the user path without deleting or rewriting the repository file', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = []; let saved: string | null = null;
    const legacy = { 'setup-worktree': ['legacy fixture'], projectActions: [], scheduledTasks: [{ id: 'keep' }] };
    const editor = createProjectSettingsEditor(async (path, method = 'GET', body) => {
      calls.push({ path, method, body });
      if (path === '/api/fs/home') return { home: '/host' };
      if (method === 'POST') { saved = String((body as { content: string }).content); return { success: true }; }
      if (path.includes(encodeURIComponent('/fixture/root/.yuri/yuri.json'))) return JSON.stringify(legacy);
      if (saved) return saved;
      throw Object.assign(new Error('missing'), { status: 404 });
    }, () => true, { id: 'not-path-id', path: '/fixture/root' }, () => undefined);
    await editor.load(); expect(calls.every(call => call.method === 'GET')).toBe(true);
    editor.edit('setup', { commands: ['changed fixture'] }); await editor.save('setup');
    expect(editor.snapshot().errors.setup).toBe('');
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(1);
    expect(calls.find(call => call.method === 'POST')!.body).toMatchObject({ path: '/host/.config/yuri/projects/path_L2ZpeHR1cmUvcm9vdA.json' });
    expect(JSON.parse(saved!)).toMatchObject({ scheduledTasks: [{ id: 'keep' }], 'setup-worktree': ['changed fixture'] });
  });
  it('does not fall back to legacy when canonical reads fail with 403/500 or malformed content', async () => {
    for (const failure of [Object.assign(new Error('forbidden'), { status: 403 }), Object.assign(new Error('offline'), { status: 500 }), 'malformed']) {
      const calls: string[] = [];
      const editor = createProjectSettingsEditor(async path => { calls.push(path); if (path === '/api/fs/home') return { home: '/host' }; if (failure === 'malformed') return '{'; throw failure; }, () => true, { id: 'x', path: '/fixture/root' }, () => undefined);
      await editor.load(); expect(editor.snapshot().ready.actions).toBe(false); expect(calls).toHaveLength(2); expect(calls.some(path => path.includes('.yuri'))).toBe(false);
    }
  });
  it('reconciles unknown committed writes using only a read, not a second mutation', async () => {
    const f = fixture(); let lost = false;
    const editor = createProjectSettingsEditor(async (path, method, body) => {
      const result = await f.send(path, method, body);
      if (method === 'POST' && !lost) { lost = true; throw new Error('connection lost after commit'); }
      return result;
    }, () => true, { id: 'catalog-do-not-use', path: '/fixture/root' }, () => undefined);
    await editor.load(); editor.edit('actions', { actions: [] }); await editor.save('actions');
    expect(editor.snapshot().pending).toBe('actions'); await editor.save('actions');
    expect(editor.snapshot().pending).toBeNull(); expect(editor.dirty('actions')).toBe(false); expect(f.host.inspect().writes).toBe(1);
  });
  it('serializes sections sharing a config file and does not lose the second section draft', async () => {
    const { editor, host } = fixture(); await editor.load(); editor.edit('actions', { actions: [] }); editor.edit('setup', { commands: ['second draft'] });
    await Promise.all([editor.save('actions'), editor.save('setup')]); expect(host.inspect().writes).toBe(1); expect(editor.dirty('setup')).toBe(true);
    await editor.save('setup'); expect(host.inspect().writes).toBe(2); expect(host.inspect().config.projectActions).toEqual([]); expect(host.inspect().config['setup-worktree']).toEqual(['second draft']);
  });
  it('fences stale responses before any follow-up write or publication', async () => {
    const f = fixture(); await f.editor.load(); f.editor.edit('actions', { actions: [] });
    let release!: (value: unknown) => void; const waiting = new Promise<unknown>(resolve => { release = resolve; }); let current = true, calls = 0;
    const editor = createProjectSettingsEditor(async () => { calls++; return waiting; }, () => current, { id: 'a', path: '/fixture/root' }, () => undefined);
    const flight = editor.load(); current = false; release({ home: '/fixture/host-home' }); await flight; expect(calls).toBe(1); expect(editor.snapshot().ready.actions).toBe(false);
    f.leave(); await f.editor.save('actions'); expect(f.host.inspect().writes).toBe(0);
  });
});

it('reuses existing keys with values in every shipped locale, without a parallel translation source', async () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'settings-projects.tsx'), 'utf8');
  const keys = [...source.matchAll(/\bt\('([^']+)'/g)].map(match => match[1]);
  keys.push('settings.projects.actions.toast.saveFailed', 'settings.yuri.worktrees.setup.toast.saveFailed', 'settings.projects.actions.actions.save', 'filesView.editor.saved', 'settings.common.actions.saveChanges', 'settings.projects.actions.toast.saved');
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'pl', 'pt-BR', 'uk']) {
    const dictionary = (await import(`../ui/src/lib/i18n/messages/${locale}.ts`)).dict as Record<string, unknown>;
    for (const key of keys) expect(typeof dictionary[key], `${locale}:${key}`).toBe('string');
  }
});

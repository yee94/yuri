import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { EditorView } from '@codemirror/view';
import { foldCode, foldedRanges, unfoldAll } from '@codemirror/language';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { queryClient } from '@/lib/queryRuntime';
import { getDefaultTheme } from '@/lib/theme/themes';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { usePluginsStore, type PluginEntry, type RegistryResult } from '@/stores/usePluginsStore';
import { pluginRegistryQueryOptions, pluginRuntimeQueryOptions, pluginsListQueryOptions } from '@/queries/pluginQueries';
import { compileProductionCssAsync, evidenceRoot, openChromeSession, openPageSession } from '@/components/ui/chromeCdpHarness';
import { PluginsPage } from './PluginsPage';
import { PluginsSidebar } from './PluginsSidebar';
import { GuiPluginsContext, getEmptySnapshot, type GuiPluginsContextValue } from '@/lib/gui-plugins/react';
import { usePluginUpdates } from './usePluginUpdates';
import { AddPluginDialog } from './AddPluginDialog';

const gateway = vi.hoisted(() => ({ update: vi.fn(), list: vi.fn(), reload: vi.fn(), updateEntry: vi.fn(), createEntry: vi.fn(), deleteEntry: vi.fn(), deleteFile: vi.fn(), fetch: vi.fn(), dark: true }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: gateway.fetch }));
vi.mock('@/lib/i18n', async () => {
  const { dict } = await import('@/lib/i18n/messages/zh-CN');
  const t = (key: keyof typeof dict, params?: Record<string, string | number>) => {
    let value = dict[key];
    for (const [name, replacement] of Object.entries(params ?? {})) value = value.replaceAll(`{${name}}`, String(replacement));
    return value;
  };
  return { useI18n: () => ({ t }) };
});
vi.mock('@/contexts/useThemeSystem', async () => {
  const { getDefaultTheme } = await import('@/lib/theme/themes');
  return { useThemeSystem: () => ({ currentTheme: getDefaultTheme(gateway.dark) }) };
});
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/stores/useAgentsStore', () => ({ reloadOpenCodeLocations: gateway.reload }));
vi.mock('@/lib/opencode/plugins', () => ({
  updatePluginPackage: gateway.update,
  listPluginRuntime: gateway.list,
  checkPluginUpdates: gateway.list,
  pluginOperationErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const directory = '/workspace/plugins';
const entries: PluginEntry[] = ['opencode2-wakatime', '@example/opencode-profile', '@example/runmark-opencode-plugin@0.2.11', 'opencode-magpie-plugin@0.4.2', '@example/opencode2-plugin'].map((spec, index) => ({
  id: `plugin-${index}`, spec, scope: 'user', kind: 'config', sourcePath: '/config/opencode.json', parsedKind: 'npm',
}));
const selected = entries[2];
const realUpdateEntry = usePluginsStore.getState().updateEntry;
const registry: Record<string, RegistryResult> = Object.fromEntries(entries.map((entry) => [entry.spec, {
  kind: 'npm-ok', spec: entry.spec, name: entry.spec.split('@0.')[0], currentVersion: entry.id === selected.id ? '0.2.11' : null,
  latestVersion: entry.id === selected.id ? '0.2.12' : null, versions: [], hasUpdate: entry.id === selected.id,
}]));
const inventory = entries.map((entry) => ({ source: { kind: 'package' as const, target: entry.spec, version: entry.id === selected.id ? '0.2.11' : entry.id === entries[4].id ? '0.5.6' : null, outdated: false, updating: false }, state: { kind: 'active' as const } }));

let host: HTMLDivElement;
let root: Root;
let restore: () => void;
let guiContext: GuiPluginsContextValue;

beforeEach(() => {
  vi.clearAllMocks();
  gateway.dark = true;
  queryClient.clear();
  gateway.list.mockResolvedValue(inventory);
  gateway.reload.mockResolvedValue(undefined);
  gateway.updateEntry.mockResolvedValue({ ok: true });
  gateway.createEntry.mockResolvedValue({ ok: true });
  gateway.deleteEntry.mockResolvedValue({ ok: true });
  gateway.deleteFile.mockResolvedValue({ ok: true });
  guiContext = {
    host: null, snapshot: { ...getEmptySnapshot(), plugins: [{ id: 'canvas', revision: 'one', status: 'active' }] },
    inventory: [{ id: 'canvas', source: { type: 'package', target: entries[4].spec }, enabled: true }],
    error: null, loading: false, requested: true, requestLoad: vi.fn(), setEnabled: vi.fn(), refresh: vi.fn(),
  };
  gateway.fetch.mockImplementation(async (url: string) => {
    if (String(url).includes('/api/config/plugins/registry')) return Response.json({ results: Object.values(registry) });
    return Response.json({ home: '/workspace', data: [], entries, files: [] });
  });
  const previous = usePluginsStore.getState();
  restore = () => usePluginsStore.setState(previous);
  useProjectsStore.setState({ projects: [{ id: 'plugins', path: directory, name: 'plugins' }], activeProjectId: 'plugins' } as never);
  usePluginsStore.setState({ entries, files: [], selectedId: selected.id, draft: null, loadPlugins: async () => true, updateEntry: gateway.updateEntry, createEntry: gateway.createEntry, deleteEntry: gateway.deleteEntry, deleteFile: gateway.deleteFile });
  queryClient.setQueryData(pluginsListQueryOptions(directory).queryKey, { entries, files: [] });
  queryClient.setQueryData(pluginRegistryQueryOptions(directory, entries.map((entry) => entry.spec)).queryKey, registry);
  queryClient.setQueryData(pluginRegistryQueryOptions(directory, [selected.spec]).queryKey, registry);
  queryClient.setQueryData(pluginRuntimeQueryOptions(directory).queryKey, inventory);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  queryClient.clear();
  restore();
});

test('update all serializes package upgrades and continues after a failed entry without reloading', async () => {
  queryClient.setQueryData(pluginRuntimeQueryOptions(directory).queryKey, inventory.map((plugin, index) => ({
    ...plugin, source: { ...plugin.source, outdated: index === 0 || index === 3 },
  })));
  let finishFirst!: () => void;
  gateway.update.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
  gateway.updateEntry.mockResolvedValueOnce({ ok: false, message: 'Failed to install' });
  await mount();
  const button = host.querySelector<HTMLButtonElement>('[data-settings-item="plugins.updateAll"]')!;
  expect(button.textContent).toBe('全部更新');
  await act(async () => button.click());
  expect(gateway.update).toHaveBeenCalledTimes(1);
  expect(gateway.updateEntry).not.toHaveBeenCalled();
  expect(button.disabled).toBe(true);
  await act(async () => finishFirst());
  await flush();
  expect(gateway.updateEntry).toHaveBeenCalledWith(selected.id, { spec: '@example/runmark-opencode-plugin@0.2.12' });
  expect(gateway.update.mock.calls.map((call) => call[1])).toEqual([entries[0].spec, entries[3].spec]);
  expect(gateway.reload).not.toHaveBeenCalled();
  expect(button.getAttribute('aria-busy')).toBe('false');
});

function NavigationUpdateProbe() {
  const available = usePluginUpdates();
  return <span hidden data-navigation-plugin-update={String(available)} />;
}

async function mount() {
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <GuiPluginsContext.Provider value={guiContext}>
      <NavigationUpdateProbe />
      <main className="yuri-settings-workspace yuri-settings-workspace-desktop flex h-screen bg-background text-foreground">
        <aside className="w-[280px] shrink-0 border-r border-border" data-plugin-sidebar><PluginsSidebar /></aside>
        <section className="min-w-0 flex-1" data-plugin-editor><PluginsPage /></section>
      </main>
      </GuiPluginsContext.Provider>
    </QueryClientProvider>,
  ));
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function optionsView(container: ParentNode = host) {
  return EditorView.findFromDOM(container.querySelector<HTMLElement>('[data-settings-item="plugins.options"] .cm-editor')!)!;
}

async function editOptions(value: string, container: ParentNode = host) {
  const view = optionsView(container);
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }));
}

test.each(['current', 'empty', 'stale'] as const)('a real pinned update retains detail with a %s legacy store projection', async (projection) => {
  const replacement = { ...selected, id: 'config:user:updated-spec', spec: '@example/runmark-opencode-plugin@0.2.12' };
  const nextEntries = entries.map((entry) => entry.id === selected.id ? replacement : entry);
  usePluginsStore.setState({
    updateEntry: realUpdateEntry,
    entries: projection === 'empty' ? [] : projection === 'stale' ? entries.map((entry) => entry.id === selected.id ? { ...entry, id: 'previous-spec-id' } : entry) : entries,
  });
  gateway.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return Response.json({ success: true });
    if (String(url).includes('/registry')) return Response.json({ results: [] });
    return Response.json({ entries: nextEntries, files: [] });
  });
  await mount();
  const input = host.querySelector('[data-plugin-editor] input');
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[data-plugin-editor] button')].find((button) => button.textContent === '更新')!.click());
  await flush();
  expect(usePluginsStore.getState().selectedId).toBe(replacement.id);
  expect(host.querySelector('[data-plugin-skeleton="detail"]')).toBeNull();
  expect(host.querySelector('[data-plugin-editor] input')).toBe(input);
});

test.each(['entry', 'file'] as const)('detail replaces discard with a leading delete icon and confirms the selected %s', async (kind) => {
  const file = { id: 'local-plugin', fileName: 'plugin.ts', kind: 'file' as const, scope: 'user' as const, absolutePath: '/config/plugins/plugin.ts' };
  if (kind === 'file') {
    queryClient.setQueryData(pluginsListQueryOptions(directory).queryKey, { entries, files: [file] });
    usePluginsStore.setState({ selectedId: file.id, readFile: async () => ({ fileName: file.fileName, scope: file.scope, content: '// plugin' }) });
  }
  await mount();
  const editor = host.querySelector('[data-plugin-editor]')!;
  const buttons = [...editor.querySelectorAll<HTMLButtonElement>('button')];
  expect(buttons[0].getAttribute('aria-label')).toBe('删除');
  expect(buttons[1].textContent).toBe('重载');
  expect(buttons[2].textContent).toBe('保存');
  expect(editor.textContent).not.toContain('放弃');
  await act(async () => buttons[0].click());
  expect(gateway.deleteEntry).not.toHaveBeenCalled();
  expect(gateway.deleteFile).not.toHaveBeenCalled();
  let dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain(kind === 'entry' ? selected.spec : file.fileName);
  await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '取消')!.click());
  expect(gateway.deleteEntry).not.toHaveBeenCalled();
  expect(gateway.deleteFile).not.toHaveBeenCalled();
  await act(async () => buttons[0].click());
  dialog = document.querySelector('[role="dialog"]')!;
  await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '删除')!.click());
  expect(kind === 'entry' ? gateway.deleteEntry : gateway.deleteFile).toHaveBeenCalledWith(kind === 'entry' ? selected.id : file.id);
  expect(kind === 'entry' ? gateway.deleteFile : gateway.deleteEntry).not.toHaveBeenCalled();
});

test('failed deletion retains the form and confirmation for retry, while pending deletion disables actions', async () => {
  let complete!: () => void;
  gateway.deleteEntry.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve({ ok: false }); }));
  await mount();
  const input = host.querySelector('[data-plugin-editor] input');
  const remove = host.querySelector<HTMLButtonElement>('[data-plugin-editor] button[aria-label="删除"]')!;
  await act(async () => remove.click());
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === '删除')!;
  await act(async () => confirm.click());
  expect(remove.disabled).toBe(true);
  expect(confirm.disabled).toBe(true);
  await act(async () => complete());
  expect(host.querySelector('[data-plugin-editor] input')).toBe(input);
  expect(remove.disabled).toBe(false);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => confirm.click());
  expect(gateway.deleteEntry).toHaveBeenCalledTimes(2);
});

test('a live config refresh during a pending update never replaces the mounted form with skeletons', async () => {
  const replacement = { ...selected, id: 'config:user:live-replacement', spec: '@example/runmark-opencode-plugin@0.2.12' };
  const nextEntries = entries.map((entry) => entry.id === selected.id ? replacement : entry);
  let finishPatch!: () => void;
  usePluginsStore.setState({ updateEntry: realUpdateEntry, entries: [] });
  gateway.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return new Promise<Response>((resolve) => { finishPatch = () => resolve(Response.json({ success: true })); });
    if (String(url).includes('/registry')) return Response.json({ results: [] });
    return Response.json({ entries: nextEntries, files: [] });
  });
  await mount();
  const input = host.querySelector<HTMLInputElement>('[data-plugin-editor] input')!;
  const options = host.querySelector('[data-plugin-editor] .cm-editor');
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[data-plugin-editor] button')].find((button) => button.textContent === '更新')!.click());
  await flush();
  await act(async () => queryClient.setQueryData(pluginsListQueryOptions(directory).queryKey, { entries: nextEntries, files: [] }));
  await flush();
  expect(host.querySelector('[data-plugin-skeleton="detail"]')).toBeNull();
  expect(host.querySelector('[data-plugin-editor] input')).toBe(input);
  expect(host.querySelector('[data-plugin-editor] .cm-editor')).toBe(options);
  expect(input.disabled).toBe(true);
  expect(host.textContent).toContain('正在更新');
  expect(host.querySelectorAll('[data-plugin-sidebar] [data-plugin-busy]')).toHaveLength(1);
  await act(async () => finishPatch());
  await flush();
  expect(usePluginsStore.getState().selectedId).toBe(replacement.id);
  expect(input.disabled).toBe(false);
});

test('update reconciliation does not steal a selection changed while the write is pending', async () => {
  const replacement = { ...selected, id: 'config:user:replacement', spec: '@example/runmark-opencode-plugin@0.2.12' };
  const nextEntries = entries.map((entry) => entry.id === selected.id ? replacement : entry);
  let finishPatch!: () => void;
  usePluginsStore.setState({ updateEntry: realUpdateEntry });
  gateway.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return new Promise<Response>((resolve) => { finishPatch = () => resolve(Response.json({ success: true })); });
    if (String(url).includes('/registry')) return Response.json({ results: [] });
    return Response.json({ entries: nextEntries, files: [] });
  });
  await mount();
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[data-plugin-editor] button')].find((button) => button.textContent === '更新')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-row-id="${entries[0].id}"] button`)!.click());
  await act(async () => queryClient.setQueryData(pluginsListQueryOptions(directory).queryKey, { entries: nextEntries, files: [] }));
  await act(async () => finishPatch());
  await flush();
  expect(usePluginsStore.getState().selectedId).toBe(entries[0].id);
  expect(host.querySelector('[data-plugin-editor] h2')?.textContent).toBe(entries[0].spec);
});

test('a confirmed catalog with a missing persisted selection does not pretend it is still loading', async () => {
  usePluginsStore.setState({ selectedId: 'removed-entry' });
  await mount();
  expect(host.querySelector('[data-plugin-skeleton="detail"]')).toBeNull();
  expect(host.querySelector('[data-plugin-editor] input')).toBeNull();
});

test('uses one compact update strip, clean rows, and no GUI manager above the editor', async () => {
  await mount();
  const editor = host.querySelector('[data-plugin-editor]')!;
  expect(editor.querySelectorAll('[data-plugin-feedback]')).toHaveLength(1);
  expect(editor.textContent).toContain('可更新至 0.2.12');
  expect(editor.querySelector('[data-plugin-gui-controls]')).toBeNull();
  expect(host.querySelector('[data-plugin-sidebar] [data-plugin-gui-controls]')).toBeNull();
  expect(host.querySelector('[data-plugin-sidebar] details')).toBeNull();
  expect(host.querySelector('[data-plugin-sidebar]')?.textContent).not.toContain('npm 包');
  expect(host.querySelector('[data-plugin-sidebar]')?.textContent).not.toContain('有 1 个更新');
  const updateAllButton = host.querySelector<HTMLButtonElement>('[aria-label="全部更新"]')!;
  expect(updateAllButton.textContent).toBe('全部更新');
  expect(updateAllButton.querySelector('svg')).toBeNull();
  const row = host.querySelector(`[data-row-id="${selected.id}"]`)!;
  expect(row.querySelector('[title="' + selected.spec + '"]')?.textContent).toBe('@example/runmark-opencode-plugin');
  expect(editor.querySelector('h2')?.textContent).toBe('@example/runmark-opencode-plugin');
  expect(host.querySelectorAll('[data-plugin-sidebar] .yuri-plugin-gui-tag')).toHaveLength(1);
  expect(host.querySelector(`[data-row-id="${entries[4].id}"] .yuri-plugin-gui-tag`)?.getAttribute('aria-label')).toBe('UI 插件');
  expect(host.querySelector(`[data-row-id="${entries[4].id}"] .yuri-plugin-gui-tag svg`)).not.toBeNull();
  for (const row of host.querySelectorAll('[data-row-id]')) expect(row.querySelectorAll('button')).toHaveLength(1);
});

test('navigation update attention follows registry or runtime updates and clears when both are current', async () => {
  await mount();
  const hasUpdate = () => host.querySelector('[data-navigation-plugin-update]')?.getAttribute('data-navigation-plugin-update');
  expect(hasUpdate()).toBe('true');
  const currentRegistry = Object.fromEntries(Object.entries(registry).map(([spec, info]) => [spec, info.kind === 'npm-ok' ? { ...info, hasUpdate: false } : info]));
  await act(async () => queryClient.setQueryData(pluginRegistryQueryOptions(directory, entries.map((entry) => entry.spec)).queryKey, currentRegistry));
  await flush();
  expect(hasUpdate()).toBe('false');
  await act(async () => queryClient.setQueryData(pluginRuntimeQueryOptions(directory).queryKey, inventory.map((plugin, index) => index === 0 ? { ...plugin, source: { ...plugin.source, outdated: true } } : plugin)));
  await flush();
  expect(hasUpdate()).toBe('true');
  await act(async () => queryClient.setQueryData(pluginRuntimeQueryOptions(directory).queryKey, inventory));
  await flush();
  expect(hasUpdate()).toBe('false');
});

test('unpinned plugins show their effective version in both the row and detail, not the registry latest', async () => {
  const unpinned = entries[1];
  usePluginsStore.setState({ selectedId: unpinned.id });
  queryClient.setQueryData(pluginRuntimeQueryOptions(directory).queryKey, inventory.map((plugin, index) => index === 1 ? { ...plugin, source: { ...plugin.source, version: '1.8.6' } } : plugin));
  queryClient.setQueryData(pluginRegistryQueryOptions(directory, entries.map((entry) => entry.spec)).queryKey, {
    ...registry, [unpinned.spec]: { ...registry[unpinned.spec], latestVersion: '9.9.9' },
  });
  await mount();
  expect(host.querySelector(`[data-row-id="${unpinned.id}"]`)?.textContent).toContain('1.8.6');
  expect(host.querySelector('[data-plugin-editor] h2 + div')?.textContent).toBe('v1.8.6');
  expect(host.querySelector<HTMLInputElement>('[data-plugin-editor] input')?.value).toBe(unpinned.spec);
  expect(host.querySelector(`[data-row-id="${unpinned.id}"]`)?.textContent).not.toContain('9.9.9');
});

test('a pinned selector is not displayed as the effective version when runtime has none', async () => {
  queryClient.setQueryData(pluginRuntimeQueryOptions(directory).queryKey, inventory.map((plugin, index) => index === 2 ? { ...plugin, source: { ...plugin.source, version: null } } : plugin));
  await mount();
  expect(host.querySelector('[data-plugin-editor] h2 + div')).toBeNull();
  expect(host.querySelector(`[data-row-id="${selected.id}"]`)?.textContent).not.toContain('0.2.11');
  expect(host.querySelector<HTMLInputElement>('[data-plugin-editor] input')?.value).toBe(selected.spec);
});

test('GUI status and switch belong only to the selected provider, independent of its GUI ID', async () => {
  usePluginsStore.setState({ selectedId: entries[4].id });
  await mount();
  expect(host.querySelector('[data-gui-plugin-id="canvas"]')?.textContent).toContain('运行中');
  expect(host.querySelector('[data-gui-plugin-id="canvas"]')?.textContent).toContain('本插件提供 UI 插件，可在应用内展示界面');
  const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await act(async () => toggle.click());
  expect(guiContext.setEnabled).toHaveBeenCalledWith('canvas', false);
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-row-id="${entries[0].id}"] button`)!.click());
  expect(host.querySelector('[data-plugin-gui-controls]')).toBeNull();
  expect(host.querySelectorAll('.yuri-plugin-gui-tag')).toHaveLength(1);
});

test('JSON options use the shared folding editor and keep object validation, saving, and empty defaults', async () => {
  await mount();
  const view = optionsView();
  const options = view.contentDOM;
  expect(options.getAttribute('aria-label')).toBe('选项（JSON）');
  expect(host.querySelector('.cm-placeholder')?.textContent).toBe('插件的自定义配置（JSON 对象），字段请参考插件文档；留空使用默认配置。');
  const save = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '保存')!;
  expect(save.disabled).toBe(true);
  for (const invalid of ['[]', 'null', '{', '"text"', '1']) {
    await editOptions(invalid);
    expect(options.getAttribute('aria-invalid')).toBe('true');
    expect(save.disabled).toBe(true);
  }
  const content = '{\n  "settings": {\n    "enabled": true\n  },\n  "items": [\n    "example"\n  ]\n}';
  await editOptions(content);
  expect(options.getAttribute('aria-invalid')).toBe('false');
  expect(save.disabled).toBe(false);
  expect(host.querySelector('.cm-foldGutter [title="折叠代码"]')).not.toBeNull();
  for (const field of ['settings', 'items']) {
    await act(async () => {
      view.dispatch({ selection: { anchor: content.indexOf(`"${field}"`) } });
      expect(foldCode(view)).toBe(true);
    });
    expect(foldedRanges(view.state).size).toBe(1);
    expect(usePluginsStore.getState().draft?.optionsJson).toBe(content);
    expect(save.disabled).toBe(false);
    await act(async () => { unfoldAll(view); });
  }
  await act(async () => save.click());
  expect(gateway.updateEntry).toHaveBeenCalledWith(selected.id, { spec: selected.spec, options: { settings: { enabled: true }, items: ['example'] } });
  await editOptions(' ');
  await act(async () => save.click());
  expect(gateway.updateEntry).toHaveBeenLastCalledWith(selected.id, { spec: selected.spec, options: undefined });
});

test.each(['npm', 'path'])('adding a %s plugin uses the same JSON editor and locks it during submission', async (tab) => {
  const onOpenChange = vi.fn();
  await act(async () => root.render(<AddPluginDialog open onOpenChange={onOpenChange} />));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  if (tab === 'path') {
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '从本地路径')!.click());
  }
  const input = dialog.querySelector<HTMLInputElement>('#plugin-spec')!;
  const spec = tab === 'npm' ? 'example-plugin' : '/workspace/example-plugin';
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, spec);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '添加')!;
  const view = optionsView(dialog);
  expect(view.contentDOM.id).toBe('plugin-options');
  expect(view.contentDOM.getAttribute('aria-label')).toBe('选项（JSON）');
  await editOptions('[]', dialog);
  expect(submit.disabled).toBe(true);
  expect(view.contentDOM.getAttribute('aria-invalid')).toBe('true');
  const content = '{\n  "enabled": true\n}';
  await editOptions(content, dialog);
  const marker = dialog.querySelector<HTMLElement>('.cm-foldGutter [title="折叠代码"]')!;
  await act(async () => marker.click());
  expect(foldedRanges(view.state).size).toBe(1);
  expect(submit.disabled).toBe(false);
  let complete!: () => void;
  gateway.createEntry.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve({ ok: true }); }));
  await act(async () => submit.click());
  expect(gateway.createEntry).toHaveBeenCalledWith({ spec, scope: 'user', options: { enabled: true } });
  expect(view.state.doc.toString()).toBe(content);
  expect(view.state.readOnly).toBe(true);
  expect(view.contentDOM.getAttribute('contenteditable')).toBe('false');
  expect(submit.disabled).toBe(true);
  await act(async () => complete());
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test('only a cold inventory uses skeletons; a background refresh preserves the form', async () => {
  queryClient.removeQueries({ queryKey: pluginsListQueryOptions(directory).queryKey, exact: true });
  let finishRead!: () => void;
  gateway.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRead = () => resolve(Response.json({ entries, files: [] })); }));
  await mount();
  expect(host.querySelector('[data-plugin-skeleton="detail"]')).not.toBeNull();
  expect(host.querySelector('[data-plugin-skeleton="list"]')).not.toBeNull();
  await act(async () => finishRead());
  await flush();
  const input = host.querySelector('[data-plugin-editor] input');
  expect(input).not.toBeNull();
  expect(host.querySelector('[data-plugin-skeleton]')).toBeNull();
  gateway.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRead = () => resolve(Response.json({ entries, files: [] })); }));
  await act(async () => { void queryClient.invalidateQueries({ queryKey: pluginsListQueryOptions(directory).queryKey, exact: true }); });
  expect(host.querySelector('[data-plugin-editor] input')).toBe(input);
  expect(host.querySelector('[data-plugin-skeleton]')).toBeNull();
  await act(async () => finishRead());
});

test('a pinned registry update keeps the editor mounted and shares loading with exactly its row', async () => {
  let complete!: () => void;
  gateway.updateEntry.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve({ ok: true }); }));
  await mount();
  const editor = host.querySelector('[data-plugin-editor]')!;
  const options = editor.querySelector('.cm-editor');
  expect(options).not.toBeNull();
  const input = editor.querySelector('input');
  const button = [...editor.querySelectorAll('button')].find((item) => item.textContent === '更新')!;
  await act(async () => button.click());
  await flush();
  expect(gateway.updateEntry).toHaveBeenCalledWith(selected.id, { spec: '@example/runmark-opencode-plugin@0.2.12' });
  expect(gateway.update).not.toHaveBeenCalled();
  expect(editor.textContent).toContain('正在更新至 0.2.12');
  expect(host.querySelectorAll('[data-plugin-sidebar] [data-plugin-busy]')).toHaveLength(1);
  expect(editor.querySelector('.cm-editor')).toBe(options);
  expect(optionsView().state.readOnly).toBe(true);
  expect(optionsView().contentDOM.getAttribute('contenteditable')).toBe('false');
  expect(editor.querySelector('input')).toBe(input);
  expect(input?.disabled).toBe(true);
  expect(editor.querySelector('[data-settings-item="plugins.options"]')?.hasAttribute('inert')).toBe(true);
  expect(button.disabled).toBe(true);
  await act(async () => complete());
  await flush();
  expect(input?.disabled).toBe(false);
  expect(optionsView().state.readOnly).toBe(false);
});

test('reload marks every row without replacing the selected editor', async () => {
  let complete!: () => void;
  gateway.reload.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
  await mount();
  const input = host.querySelector('[data-plugin-editor] input');
  const button = [...host.querySelectorAll<HTMLButtonElement>('[data-plugin-editor] button')].find((item) => item.textContent === '重载')!;
  await act(async () => button.click());
  await flush();
  expect(gateway.reload).toHaveBeenCalledTimes(1);
  expect(host.querySelectorAll('[data-plugin-sidebar] [data-plugin-busy]')).toHaveLength(entries.length);
  expect(host.querySelector('[data-plugin-editor] input')).toBe(input);
  expect(button.disabled).toBe(true);
  await act(async () => complete());
  await flush();
});

test('failed pinned updates unlock editing, expose a folded error and remain retryable', async () => {
  gateway.updateEntry.mockResolvedValueOnce({ ok: false, message: 'Registry unavailable\nPlease retry\nDetails' });
  await mount();
  const editor = host.querySelector('[data-plugin-editor]')!;
  const input = editor.querySelector('input');
  await act(async () => [...editor.querySelectorAll('button')].find((item) => item.textContent === '更新')!.click());
  await flush();
  expect(editor.querySelector('input')).toBe(input);
  expect(input?.disabled).toBe(false);
  expect(editor.querySelector('[role="alert"]')?.textContent).toContain('Registry unavailable');
  expect(editor.querySelector('[aria-expanded="false"]')).not.toBeNull();
  const retry = [...editor.querySelectorAll('button')].find((item) => item.textContent === '更新')!;
  expect(retry.disabled).toBe(false);
  await act(async () => retry.click());
  expect(gateway.updateEntry).toHaveBeenCalledTimes(2);
});

test('a confirmed spec rewrite cannot drop the pending state before reload completes', async () => {
  let complete!: () => void;
  gateway.updateEntry.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve({ ok: true }); }));
  await mount();
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[data-plugin-editor] button')].find((button) => button.textContent === '更新')!.click());
  const nextEntries = entries.map((entry) => entry.id === selected.id ? { ...entry, spec: '@example/runmark-opencode-plugin@0.2.12' } : entry);
  await act(async () => queryClient.setQueryData(pluginsListQueryOptions(directory).queryKey, { entries: nextEntries, files: [] }));
  await flush();
  expect(host.querySelector<HTMLInputElement>('[data-plugin-editor] input')?.disabled).toBe(true);
  expect(host.querySelectorAll('[data-plugin-sidebar] [data-plugin-busy]')).toHaveLength(1);
  expect(host.querySelector('[data-plugin-load-state="notReported"]')).toBeNull();
  gateway.list.mockResolvedValue(inventory.map((item, index) => index === 2 ? { ...item, source: { ...item.source, target: '@example/runmark-opencode-plugin@0.2.12', version: '0.2.12' } } : item));
  await act(async () => complete());
  await flush();
  expect(host.querySelector<HTMLInputElement>('[data-plugin-editor] input')?.disabled).toBe(false);
});

test.skip('measures and captures the rendered production editor with production CSS', async () => {
  const options = { enabled: true, settings: { endpoint: 'https://api.example.test', retries: 3 }, items: ['example'] };
  queryClient.setQueryData(pluginsListQueryOptions(directory).queryKey, {
    entries: entries.map((entry) => entry.id === selected.id ? { ...entry, options } : entry), files: [],
  });
  await mount();
  const here = dirname(fileURLToPath(import.meta.url));
  const uiSrc = join(here, '../../..');
  const css = await compileProductionCssAsync(uiSrc);
  const localCss = readFileSync(join(here, 'plugin-settings.css'), 'utf8');
  const evidence = evidenceRoot();
  const fixture = join(evidence, 'plugins.html');
  const session = await openChromeSession({ width: 1040, height: 620 });
  try {
    const page = await openPageSession(session, { width: 1040, height: 620, standalone: false });
    const render = async (name: string, dark: boolean, width: number) => {
      gateway.dark = dark;
      await mount();
      const vars = new CSSVariableGenerator().generate(getDefaultTheme(dark));
      const sprite = document.getElementById('yuri-icon-sprite-v2')?.outerHTML ?? '';
      const editorCss = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join('\n');
      writeFileSync(fixture, `<!doctype html><html class="${width < 700 ? 'mobile-pointer' : ''}" data-theme="${dark ? 'dark' : 'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${localCss}\n${editorCss}\n:root{${vars}}</style></head><body>${sprite}${host.innerHTML}</body></html>`);
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 620, deviceScaleFactor: 1, mobile: false });
      await page.navigateFile(fixture);
      const borders = await page.evaluate<{ outer: string; expectedOuter: string; divider: string | null; expectedDivider: string }>(`(() => {
        const list = document.querySelector('.yuri-plugin-list');
        const probe = document.createElement('div');
        probe.style.border = '1px solid var(--yuri-settings-group-border)';
        probe.style.borderTopColor = 'var(--yuri-settings-row-divider)';
        list.append(probe);
        const divider = list.querySelector('[data-row-id] + [data-row-id]');
        const result = { outer: getComputedStyle(list).borderBottomColor,
          expectedOuter: getComputedStyle(probe).borderBottomColor,
          divider: divider ? getComputedStyle(divider).borderTopColor : null,
          expectedDivider: getComputedStyle(probe).borderTopColor };
        probe.remove();
        return result;
      })()`);
      expect(borders.outer).toBe(borders.expectedOuter);
      if (borders.divider) expect(borders.divider).toBe(borders.expectedDivider);
      if (width >= 700) {
        const fullRowHitTargets = await page.evaluate<boolean[]>(`(() => {
          return [...document.querySelectorAll('.yuri-plugin-list > [data-row-id]')].map(row => {
            const button = row.querySelector('button');
            const rect = row.getBoundingClientRect();
            return [[rect.x + rect.width / 2, rect.y + 1],
              [rect.x + rect.width / 2, rect.bottom - 1],
              [rect.x + 1, rect.y + rect.height / 2],
              [rect.right - 1, rect.y + rect.height / 2]]
              .every(([x, y]) => button.contains(document.elementFromPoint(x, y)));
          });
        })()`);
        expect(fullRowHitTargets.every(Boolean)).toBe(true);
      }
      if (name === 'plugins-gui-focused') {
        const focusGeometry = await page.evaluate<{ radius: number; cardDisplay: string }>(`(() => {
          const content = document.querySelector('[data-settings-item="plugins.options"] .cm-content');
          content.focus();
          const card = content.closest('.yuri-settings-group-card');
          return { radius: parseFloat(getComputedStyle(card).borderTopLeftRadius),
            cardDisplay: getComputedStyle(card).display };
        })()`);
        expect(focusGeometry.radius).toBeGreaterThan(0);
        expect(focusGeometry.cardDisplay).not.toBe('contents');
      }
      if (width < 700) await page.evaluate(`document.querySelector('[data-plugin-sidebar]').remove()`);
      if (!host.querySelector('[data-plugin-editor] h2')) {
        expect(host.querySelectorAll('[data-plugin-skeleton-row]')).toHaveLength(5);
        await page.screenshotPng(join(evidence, `${name}.png`));
        return;
      }
      const geometry = await page.evaluate<{ strip: number; title: number; sub: number; firstRow: number; rows: number[]; overflow: boolean; guiAlignment: number | null }>(`(() => {
        const editor = document.querySelector('[data-plugin-editor]');
        const title = editor.querySelector('h2');
        const gui = document.querySelector('.yuri-plugin-gui-tag');
        const iconRect = gui?.querySelector('svg')?.getBoundingClientRect();
        const versionRect = gui?.parentElement.querySelector('[data-plugin-version]')?.getBoundingClientRect();
        return { strip: editor.querySelector('.yuri-plugin-update-strip')?.getBoundingClientRect().height ?? 0,
          guiAlignment: iconRect && versionRect ? Math.abs(iconRect.y + iconRect.height / 2 - versionRect.y - versionRect.height / 2) : null,
          title: parseFloat(getComputedStyle(title).fontSize), sub: title.nextElementSibling ? parseFloat(getComputedStyle(title.nextElementSibling).fontSize) : 0,
          firstRow: document.querySelector('[data-row-id]')?.getBoundingClientRect().height ?? 0,
          rows: [...document.querySelectorAll('[data-row-id]')].map(el => el.getBoundingClientRect().height),
          overflow: document.documentElement.scrollWidth > innerWidth };
      })()`);
      expect(geometry.strip).toBeLessThanOrEqual(width < 700 ? 52 : 40);
      expect(geometry.title).toBe(13);
      if (geometry.sub) expect(geometry.sub).toBe(10);
      if (width >= 700) {
        expect(geometry.guiAlignment).not.toBeNull();
        expect(geometry.guiAlignment).toBeLessThanOrEqual(0.5);
      }
      expect(geometry.rows.every((height) => height <= 60)).toBe(true);
      expect(geometry.overflow).toBe(false);
      await page.screenshotPng(join(evidence, `${name}.png`));
    };
    await render('plugins-dark', true, 1040);
    await act(async () => {
      const view = optionsView();
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('"settings"') } });
      expect(foldCode(view)).toBe(true);
    });
    await render('plugins-folded', true, 1040);
    expect(foldedRanges(optionsView().state).size).toBe(1);
    await render('plugins-light', false, 1040);
    await render('plugins-mobile', true, 350);
    let finishUpdate!: () => void;
    gateway.updateEntry.mockImplementationOnce(() => new Promise((resolve) => { finishUpdate = () => resolve({ ok: true }); }));
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[data-plugin-editor] button')].find((button) => button.textContent === '更新')!.click());
    await flush();
    await render('plugins-updating', true, 1040);
    await act(async () => finishUpdate());
    await flush();
    let finishReload!: () => void;
    gateway.reload.mockImplementationOnce(() => new Promise<void>((resolve) => { finishReload = resolve; }));
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[data-plugin-editor] button')].find((button) => button.textContent === '重载')!.click());
    await flush();
    await render('plugins-reloading', true, 1040);
    await act(async () => finishReload());
    await flush();
    await act(async () => queryClient.setQueryData(pluginRuntimeQueryOptions(directory).queryKey, inventory.map((plugin, index) => index === 2 ? { ...plugin, state: { kind: 'failed', error: 'Cannot find module @example/plugin-sdk\nRequire stack:\n- /cache/plugins/index.js\n- /cache/loader.js', ref: null } } : plugin)));
    await flush();
    expect(host.querySelector('[data-plugin-load-state="failed"]')).not.toBeNull();
    await render('plugins-failed', true, 1040);
    await act(async () => usePluginsStore.setState({ selectedId: entries[4].id }));
    await flush();
    expect(host.querySelector('[data-gui-plugin-id="canvas"]')).not.toBeNull();
    await render('plugins-gui', true, 1040);
    await render('plugins-gui-focused', true, 1040);
    await render('plugins-gui-mobile', true, 350);
    gateway.fetch.mockImplementation(() => new Promise<Response>(() => {}));
    await act(async () => useProjectsStore.setState({ projects: [{ id: 'cold', path: '/workspace/cold', name: 'cold' }], activeProjectId: 'cold' } as never));
    await render('plugins-initial', true, 1040);
    console.info(`Plugin layout evidence: ${evidence}`);
  } finally {
    await session.close();
  }
}, 180_000);

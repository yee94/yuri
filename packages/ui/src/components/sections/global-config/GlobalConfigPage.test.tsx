import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { foldCode, foldedRanges, unfoldAll } from '@codemirror/language';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: mocks.error } }));
vi.mock('@/contexts/useThemeSystem', () => {
  const currentTheme = { metadata: { id: 'test' } };
  return { useThemeSystem: () => ({ currentTheme }) };
});
vi.mock('@/lib/codemirror/flexokiTheme', () => ({ createFlexokiCodeMirrorTheme: () => [] }));
vi.mock('@/lib/codemirror/shikiHighlight', () => ({ shikiHighlightExtension: () => [] }));
vi.mock('@/lib/shiki/appThemeRegistry', () => ({ getResolvedShikiTheme: () => ({}) }));
vi.mock('@/lib/i18n', async () => {
  const { dict } = await import('@/lib/i18n/messages/zh-CN');
  const t = (key: keyof typeof dict) => dict[key];
  return { useI18n: () => ({ t }) };
});

import { GlobalConfigPage } from './GlobalConfigPage';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.fetch.mockReset();
  mocks.error.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

test.each(['json', 'jsonc'])('global %s config folds objects and arrays without changing content or dirty state', async (extension) => {
  const content = `{
  ${extension === 'jsonc' ? '// Configuration with comments\n  ' : ''}"provider": {
    "models": {
      "example": {}
    }
  },
  "plugins": [
    "example-plugin"
  ]
}`;
  mocks.fetch.mockImplementation(async (path: string) => Response.json(path === '/api/config/global'
    ? { targets: [{ target: 'opencode', fileName: `opencode.${extension}` }] }
    : { content, fileName: `opencode.${extension}` }));
  await act(async () => root.render(<GlobalConfigPage />));

  const editor = host.querySelector<HTMLElement>('.cm-editor');
  expect(editor).not.toBeNull();
  const card = host.querySelector<HTMLElement>('[data-settings-item="global-config.editor"]')!;
  expect(host.querySelector('.yuri-settings-page-content')?.classList.contains('pb-0')).toBe(true);
  expect(card.classList.contains('p-3')).toBe(false);
  expect(card.children).toHaveLength(2);
  expect(card.firstElementChild?.classList.contains('py-1')).toBe(true);
  expect(card.lastElementChild?.contains(editor)).toBe(true);
  expect(host.querySelector('.yuri-settings-group-description')).toBeNull();
  expect(host.querySelector('[aria-pressed]')).toBeNull();
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'OpenCode')).toBe(false);
  const view = EditorView.findFromDOM(editor!)!;
  const save = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === '保存更改')!;
  expect(save.disabled).toBe(true);
  const marker = host.querySelector<HTMLElement>('.cm-foldGutter [title="折叠代码"]');
  expect(marker).not.toBeNull();
  await act(async () => marker!.click());
  expect(foldedRanges(view.state).size).toBe(1);
  expect(host.querySelector('.cm-foldGutter [title="展开代码"]')).not.toBeNull();
  const placeholder = host.querySelector<HTMLElement>('.cm-foldPlaceholder');
  expect(placeholder?.getAttribute('aria-label')).toBe('已折叠的代码');
  expect(placeholder?.title).toBe('展开代码');
  await act(async () => placeholder!.click());
  expect(foldedRanges(view.state).size).toBe(0);

  for (const field of ['provider', 'models', 'plugins']) {
    await act(async () => {
      view.dispatch({ selection: { anchor: content.indexOf(`"${field}"`) } });
      expect(foldCode(view)).toBe(true);
    });
    expect(foldedRanges(view.state).size).toBe(1);
    expect(view.state.doc.toString()).toBe(content);
    expect(save.disabled).toBe(true);
    await act(async () => { unfoldAll(view); });
  }
  expect(mocks.fetch.mock.calls.every((call) => call[1]?.method !== 'PUT')).toBe(true);
  expect(mocks.error).not.toHaveBeenCalled();
});

test('ignores plugin targets from older hosts and reloads and saves only OpenCode', async () => {
  const content = '{"model":"example/model"}';
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/config/global') return Response.json({ targets: [
      { target: 'oh-my-opencode-slim', fileName: 'oh-my-opencode-slim.json' },
      { target: 'oh-my-openagent', fileName: 'oh-my-openagent.json' },
      { target: 'opencode', fileName: 'opencode.jsonc' },
    ] });
    if (init?.method === 'PUT') return Response.json(JSON.parse(init.body as string));
    return Response.json({ content, fileName: 'opencode.jsonc' });
  });
  await act(async () => root.render(<GlobalConfigPage />));
  expect(host.textContent).not.toContain('oh-my-');
  expect(host.querySelector('[aria-pressed]')).toBeNull();
  const reload = [...host.querySelectorAll('button')].find((button) => button.textContent === '重新加载文件')!;
  await act(async () => reload.click());
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
  await act(async () => view.dispatch({ changes: { from: 1, insert: ' ' } }));
  const save = [...host.querySelectorAll('button')].find((button) => button.textContent === '保存更改')!;
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  expect(save.disabled).toBe(true);
  expect(mocks.fetch).toHaveBeenCalledWith('/api/config/global/opencode', expect.objectContaining({ method: 'PUT' }));
  expect(mocks.fetch.mock.calls.every(([path]) => path === '/api/config/global' || path === '/api/config/global/opencode')).toBe(true);
  expect(mocks.error).not.toHaveBeenCalled();
});

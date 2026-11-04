import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  updateDesktopSettings: vi.fn(),
  modelSelectorProps: [] as Array<Record<string, unknown>>,
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/components/ui', () => ({ toast: { success: mocks.success, error: mocks.error } }));

vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: mocks.updateDesktopSettings }));
vi.mock('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: () => null }));
vi.mock('@/components/sections/agents/ModelSelector', () => ({
  ModelSelector: (props: { modelId: string } & Record<string, unknown>) => {
    mocks.modelSelectorProps.push(props);
    return <div data-testid="provider-model">{props.modelId}</div>;
  },
}));
vi.mock('@/lib/i18n', async () => {
  const { dict } = await import('@/lib/i18n/messages/en');
  return { useI18n: () => ({ t: (key: keyof typeof dict) => dict[key] }) };
});

import { SummarySettings } from './SummarySettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let settings: Record<string, unknown>;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const saveButton = () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Save prompts')!;

beforeEach(async () => {
  settings = {
    summaryModelMode: 'provider',
    summaryProviderID: 'openai',
    summaryModelID: 'gpt-5.4-mini',
    summaryCommitPrompt: 'Commit subject\nKeep technical terms.',
    summarySessionTitlePrompt: 'Session title\nKeep the subject.',
  };
  mocks.fetch.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
  mocks.updateDesktopSettings.mockReset();
  mocks.modelSelectorProps.length = 0;
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === '/api/config/settings') return Response.json(settings);
    return Response.json({});
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<SummarySettings />);
  });
  await flush();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test('shows only the model picker and no page title', () => {
  expect(host.querySelector('[data-testid="provider-model"]')?.textContent).toBe('gpt-5.4-mini');
  expect(host.querySelector('h2')).toBeNull();
  expect(host.textContent).not.toContain('Model source');
  expect(host.querySelector('input[type="password"]')).toBeNull();
});

test('prompt editors use the shared resizable textarea and load existing multiline values', () => {
  const commit = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit prompt"]')!;
  const title = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Session title prompt"]')!;
  expect(commit.value).toBe(settings.summaryCommitPrompt);
  expect(title.value).toBe(settings.summarySessionTitlePrompt);
  expect(host.querySelector('.cm-editor')).toBeNull();
  for (const input of [commit, title]) {
    expect(input.dataset.slot).toBe('textarea-input');
    const surface = input.closest('[data-slot="textarea"]')!;
    expect(surface.querySelector('[role="separator"]')).not.toBeNull();
    expect(surface.classList.contains('h-64')).toBe(true);
    expect(input.classList.contains('font-mono')).toBe(true);
    const copy = input.closest('.yuri-settings-group-row')!.querySelector('.yuri-settings-split-row-copy')!;
    expect(copy.querySelector('.typography-meta')).toBeNull();
    expect(copy.textContent).toBe(input.getAttribute('aria-label'));
  }
});

test('editing both prompt textareas saves their exact multiline content', async () => {
  const drafts = {
    summaryCommitPrompt: '  Commit prompt\n\nPreserve spacing.  ',
    summarySessionTitlePrompt: '会话标题\nKeep filenames exact.\n',
  };
  const commit = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit prompt"]')!;
  const title = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Session title prompt"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    for (const [input, value] of [[commit, drafts.summaryCommitPrompt], [title, drafts.summarySessionTitlePrompt]] as const) {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  expect(mocks.updateDesktopSettings).not.toHaveBeenCalled();
  await act(async () => saveButton().click());
  expect(mocks.updateDesktopSettings).toHaveBeenCalledWith(expect.objectContaining(drafts));
  expect(commit.value).toBe(drafts.summaryCommitPrompt);
  expect(title.value).toBe(drafts.summarySessionTitlePrompt);
});

test('saving prompts only writes the prompt fields and disables the button until edited', async () => {
  expect(saveButton().disabled).toBe(true);
  const commit = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit prompt"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(commit, 'Updated commit prompt');
    commit.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(saveButton().disabled).toBe(false);
  await act(async () => saveButton().click());
  expect(mocks.updateDesktopSettings).toHaveBeenCalledWith({
    summaryCommitPrompt: 'Updated commit prompt',
    summarySessionTitlePrompt: settings.summarySessionTitlePrompt,
  });
  expect(saveButton().disabled).toBe(true);
});

test('selecting a model applies immediately without a save action', async () => {
  await act(async () => {
    const change = mocks.modelSelectorProps.at(-1)?.onChange as (provider: string, model: string) => void;
    change('draft-provider', 'draft-model');
  });
  await flush();

  expect(mocks.updateDesktopSettings).toHaveBeenCalledWith({
    summaryModelMode: 'provider',
    summaryProviderID: 'draft-provider',
    summaryModelID: 'draft-model',
  });
  expect(host.querySelector('[data-testid="provider-model"]')?.textContent).toBe('draft-model');
  expect(saveButton().disabled).toBe(true);
});

test('an unsaved provider model stays empty so the server follows the OpenCode default model', async () => {
  settings = { summaryModelMode: 'provider' };
  await act(async () => {
    root.unmount();
  });
  root = createRoot(host);
  await act(async () => {
    root.render(<SummarySettings />);
  });
  await flush();

  expect(host.querySelector('[data-testid="provider-model"]')?.textContent).toBe('');
  expect(mocks.fetch).not.toHaveBeenCalledWith('/api/small-model', expect.anything());
});

test('provider picker uses the shared chat model catalog without a custom provider list or allowlist', async () => {
  settings = { summaryModelMode: 'provider', summaryProviderID: 'opencode-go', summaryModelID: 'deepseek-v4-flash' };
  await act(async () => {
    root.unmount();
  });
  root = createRoot(host);
  await act(async () => {
    root.render(<SummarySettings />);
  });
  await flush();

  const props = mocks.modelSelectorProps.at(-1);
  expect(props?.modelId).toBe('deepseek-v4-flash');
  expect(props?.providers).toBeUndefined();
  expect(props?.allowedProviderIds).toBeUndefined();
  expect(props?.allowedModelIdsByProvider).toBeUndefined();
});

test('tests the current provider draft without saving and prevents duplicate pending requests', async () => {
  await act(async () => {
    const change = mocks.modelSelectorProps.at(-1)?.onChange as (provider: string, model: string) => void;
    change('draft-provider', 'draft-model');
  });
  const savesBeforeTest = mocks.updateDesktopSettings.mock.calls.length;
  let complete!: (response: Response) => void;
  mocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
  const button = host.querySelector<HTMLButtonElement>('[data-settings-item="summary-ai.test-connection"]')!;
  await act(async () => button.click());
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe('Testing…');
  const call = mocks.fetch.mock.calls.at(-1)!;
  expect(call[0]).toBe('/api/small-model/test');
  expect(JSON.parse(call[1].body)).toEqual({ mode: 'provider', providerID: 'draft-provider', modelID: 'draft-model' });
  expect(mocks.updateDesktopSettings).toHaveBeenCalledTimes(savesBeforeTest);
  await act(async () => complete(Response.json({ ok: true })));
  expect(mocks.success).toHaveBeenCalledWith('Model connection succeeded');
  expect(button.disabled).toBe(false);
});

test('provider failures remain failures and re-enable retry', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ ok: false, code: 'no_provider', message: 'No connected provider for example/model' }, { status: 400 }));
  const button = host.querySelector<HTMLButtonElement>('[data-settings-item="summary-ai.test-connection"]')!;
  await act(async () => button.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('No connected provider for example/model');
  expect(mocks.success).not.toHaveBeenCalled();
  expect(button.disabled).toBe(false);
  mocks.fetch.mockResolvedValueOnce(Response.json({ ok: true }));
  await act(async () => button.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

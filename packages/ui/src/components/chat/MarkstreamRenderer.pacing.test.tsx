import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { renderMarkdown, hashContent } = vi.hoisted(() => ({ renderMarkdown: vi.fn(), hashContent: vi.fn(() => 'height-key') }));
vi.mock('markstream-react', async (original) => ({
  ...await original<typeof import('markstream-react')>(),
  default: (props: { content: string }) => { renderMarkdown(props.content); return <div>{props.content}</div>; },
}));
vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => null }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/example/project' }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ editor: undefined, runtime: { isVSCode: false } }) }));
vi.mock('@/lib/platform', async (original) => ({ ...await original<object>(), getClientPlatform: () => 'ios' }));
vi.mock('./markdown/markdownHeightCache', () => ({ markdownHeightCacheKey: hashContent, rememberMarkdownHeight: vi.fn() }));

import { MarkstreamRenderer } from './MarkstreamRendererImpl';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});
const render = (content: string, isStreaming = true, messageId = 'message-a') => act(async () => {
  root.render(<MarkstreamRenderer content={content} messageId={messageId} isStreaming={isStreaming} enableFileReferences={false} />);
});

test('bounds expensive Markdown renders during 50 rapid upstream updates and flushes final text immediately', async () => {
  await render('start');
  for (let index = 1; index <= 50; index += 1) {
    await render(`start ${index}`);
    await act(async () => { vi.advanceTimersByTime(5); });
  }
  expect(renderMarkdown.mock.calls.length).toBeLessThanOrEqual(6);
  expect(hashContent).not.toHaveBeenCalled();
  await render('authoritative final result', false);
  expect(container.textContent).toBe('authoritative final result');
  expect(hashContent).toHaveBeenCalledWith('authoritative final result', 'markstream:assistant');
});

test('a new message identity cannot paint the previous message while a throttled update is pending', async () => {
  await render('old message');
  await render('old message tail');
  await render('new message', true, 'message-b');
  expect(container.textContent).toBe('new message');
  await act(async () => { vi.advanceTimersByTime(100); });
  expect(container.textContent).toBe('new message');
});

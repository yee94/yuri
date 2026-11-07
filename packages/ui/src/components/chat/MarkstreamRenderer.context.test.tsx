import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';

const { fenceRenders } = vi.hoisted(() => ({ fenceRenders: vi.fn() }));
vi.mock('./MarkdownRendererImpl', () => ({
  MarkdownRenderer: (props: { content: string; messageId: string; isStreaming: boolean }) => {
    fenceRenders(props);
    return <pre>{props.content}</pre>;
  },
}));
vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => null }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/example/project' }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ editor: undefined, runtime: { isVSCode: false } }) }));
vi.mock('@/lib/platform', async (original) => ({ ...await original<object>(), getClientPlatform: () => 'ios' }));

import { MarkstreamRenderer } from './MarkstreamRendererImpl';

test('streamed Part snapshots do not invalidate unchanged code blocks', async () => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (tail: string, isStreaming = true, id = 'part-a') => act(async () => {
    const content = `\`\`\`typescript\nconst settled = 1;\n\`\`\`\n\n${tail}`;
    root.render(<MarkstreamRenderer content={content} messageId="message-a" isStreaming={isStreaming} enableFileReferences={false}
      part={{ id, type: 'text', messageID: 'message-a', sessionID: 'session-a', text: content }} />);
  });
  try {
    await render('Initial tail');
    fenceRenders.mockClear();
    for (let i = 0; i < 50; i += 1) {
      await render(`Live tail ${i}`);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    expect(fenceRenders).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Live tail 49');
    await render('Final tail', false);
    expect(fenceRenders.mock.calls.at(-1)?.[0].isStreaming).toBe(false);
    await render('New identity', false, 'part-b');
    expect(fenceRenders.mock.calls.at(-1)?.[0].messageId).toContain('part-b');
    expect(container.textContent).toContain('New identity');
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

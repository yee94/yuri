import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import MarkdownRender, { setCustomComponents } from 'markstream-react';
import { expect, test, vi } from 'vitest';
import { MarkstreamFileReferenceProvider, MarkstreamTextNode } from './markstreamFileReferences';
import { MARKSTREAM_CHAT_STREAM_PERFORMANCE } from './markstreamPerformance';
import { MarkstreamHostContext } from './markstreamHostContext';

const { textRenders } = vi.hoisted(() => ({ textRenders: vi.fn() }));
vi.mock('markstream-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('markstream-react')>();
  return {
    ...actual,
    TextNode: (props: React.ComponentProps<typeof actual.TextNode>) => {
      textRenders(props.node.content);
      return <actual.TextNode {...props} />;
    },
  };
});

test('disabled file references do not invalidate settled text during 50 stream updates', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  setCustomComponents({ text: MarkstreamTextNode });
  const host = { messageId: 'file-reference-stream-test', isStreaming: true, disableStreamAnimation: false, variant: 'assistant' as const, enableFileReferences: false };
  const render = (content: string, enabled = false) => act(async () => {
    root.render(
      <MarkstreamHostContext.Provider value={host}>
        <MarkstreamFileReferenceProvider enabled={enabled} effectiveDirectory="" preferRuntimeEditor={false} content={content}>
          <MarkdownRender customId="file-reference-stream-test" content={content} final={false} {...MARKSTREAM_CHAT_STREAM_PERFORMANCE} />
        </MarkstreamFileReferenceProvider>
      </MarkstreamHostContext.Provider>,
    );
  });
  try {
    await render('Settled paragraph.\n\nLive tail');
    const settled = container.querySelector('.node-content');
    textRenders.mockClear();
    for (let i = 0; i < 50; i += 1) await render(`Settled paragraph.\n\nLive tail ${i}`);
    expect(textRenders.mock.calls.filter(([text]) => text === 'Settled paragraph.')).toHaveLength(0);
    expect(container.querySelector('.node-content')).toBe(settled);
    expect(container.textContent).toContain('Live tail 49');
    await render('Settled paragraph.\n\nLive tail 49', true);
    expect(textRenders.mock.calls.some(([text]) => text === 'Settled paragraph.')).toBe(true);
    textRenders.mockClear();
    await render('Settled paragraph.\n\nEnabled content changed', true);
    expect(textRenders.mock.calls.some(([text]) => text === 'Settled paragraph.')).toBe(true);
    await render('Settled paragraph.\n\nDisabled again');
    textRenders.mockClear();
    await render('Settled paragraph.\n\nDisabled content changed');
    expect(textRenders.mock.calls.filter(([text]) => text === 'Settled paragraph.')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    setCustomComponents({});
  }
});

test('only appended streaming text fades; history, blocks and disabled animation stay still', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  setCustomComponents({ text: MarkstreamTextNode });
  const render = (tail: string, isStreaming = true, disableStreamAnimation = false) => act(async () => {
    root.render(
      <MarkstreamHostContext.Provider value={{ messageId: 'stream-fade-test', isStreaming, disableStreamAnimation, variant: 'assistant', enableFileReferences: false }}>
        <MarkdownRender customId="stream-fade-test" content={`Settled paragraph.\n\n${tail}`} final={!isStreaming} {...MARKSTREAM_CHAT_STREAM_PERFORMANCE} />
      </MarkstreamHostContext.Provider>,
    );
  });
  try {
    await render('Live');
    const settled = container.querySelector('.node-content');
    expect(container.querySelector('.text-node-stream-delta')).toBeNull();
    await render('Live appended');
    expect(container.querySelector('.text-node-stream-delta')?.textContent).toBe(' appended');
    expect(container.querySelector('.fade-node')).toBeNull();
    expect(container.querySelector('.node-content')).toBe(settled);
    await render('Live appended complete', false);
    expect(container.textContent).toContain('Live appended complete');
    await act(async () => {
      container.querySelector('.text-node-stream-delta')?.dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    expect(container.querySelector('.text-node-stream-delta')).toBeNull();
    await render('Live appended complete disabled', true, true);
    expect(container.querySelector('.text-node-stream-delta')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    setCustomComponents({});
  }
});

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import MarkdownRender, { setCustomComponents } from 'markstream-react';
import { expect, test, vi } from 'vitest';
import { MarkstreamFileReferenceProvider, MarkstreamTextNode } from './markstreamFileReferences';
import { MARKSTREAM_CHAT_STREAM_PERFORMANCE } from './markstreamPerformance';

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
  const render = (content: string, enabled = false) => act(async () => {
    root.render(
      <MarkstreamFileReferenceProvider enabled={enabled} effectiveDirectory="" preferRuntimeEditor={false} content={content}>
        <MarkdownRender customId="file-reference-stream-test" content={content} final={false} {...MARKSTREAM_CHAT_STREAM_PERFORMANCE} />
      </MarkstreamFileReferenceProvider>,
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

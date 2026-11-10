import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import MarkdownRender, { setCustomComponents, type NodeComponentProps } from 'markstream-react';
import { afterEach, expect, test, vi } from 'vitest';
import { MARKSTREAM_CHAT_STREAM_PERFORMANCE } from './markstreamPerformance';

afterEach(() => vi.restoreAllMocks());

test('stable-node reuse matches uncached parsing across Markdown boundaries and document replacement', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const containers = [document.createElement('div'), document.createElement('div')];
  const roots = containers.map((container) => createRoot(container));
  setCustomComponents({ code_block: ({ node }: NodeComponentProps<{ code?: string }>) => <pre>{node.code}</pre> });
  const source = [
    '# Heading', '', 'Paragraph **bold** and `inline` with $x+y$ and [site](https://example.test).', '',
    '- one', '- two', '  - nested', '', '> quoted paragraph', '> next line', '',
    '| A | B |', '|---|---|', '| first | second |', '',
    '```typescript', 'const code = "a";', '```', '',
    '[named][target] and a footnote[^note].', '',
    '[target]: https://example.test/target', '[^note]: note content', '',
    '<details><summary>Details</summary>', '', 'Inside **details**.', '', '</details>', '',
    '![image](https://example.test/image.png)', '', '$$\nx^2\n$$', '', 'Trailing paragraph.',
  ].join('\n');
  const snapshot = (container: HTMLElement) => ({
    text: container.textContent,
    links: [...container.querySelectorAll('a')].map((node) => [node.textContent, node.getAttribute('href')]),
    images: [...container.querySelectorAll('img')].map((node) => [node.getAttribute('alt'), node.getAttribute('src')]),
    blocks: [...container.querySelectorAll('[data-node-type]')].map((node) => node.getAttribute('data-node-type')),
  });
  const compare = async (content: string, final = false) => {
    await act(async () => {
      roots.forEach((root, index) => root.render(<MarkdownRender customId={`differential-${index}`} content={content} final={final}
        {...MARKSTREAM_CHAT_STREAM_PERFORMANCE} parseOptions={{ reuseStableTopLevelNodes: index === 1, streamParse: index === 0 ? false : 'auto' }} />));
    });
    expect(snapshot(containers[1])).toEqual(snapshot(containers[0]));
  };
  try {
    for (let length = 1; length < source.length; length += 13) await compare(source.slice(0, length));
    await compare(source, true);
    await compare('Replacement **document**.\n\nA new tail');
    await compare('Replacement **document**.\n\nA new tail appended');
    await compare('', true);
  } finally {
    await act(async () => roots.forEach((root) => root.unmount()));
    setCustomComponents({});
  }
});

test('append-only parsing processes the tail instead of rebuilding all settled nodes', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const metrics: { processTokensInputTokens?: number; processTokensReusedTopLevelNodes?: number } = {};
  const parseOptions = { ...MARKSTREAM_CHAT_STREAM_PERFORMANCE.parseOptions, parserMetrics: metrics };
  const history = Array.from({ length: 100 }, (_, i) => `Paragraph ${i}: **settled** content.`).join('\n\n');
  const render = (tail: string) => act(async () => {
    root.render(<MarkdownRender content={`${history}\n\n${tail}`} final={false} {...MARKSTREAM_CHAT_STREAM_PERFORMANCE} parseOptions={parseOptions} />);
  });
  try {
    await render('Live ');
    const settled = container.querySelector('.node-content');
    metrics.processTokensInputTokens = 0;
    metrics.processTokensReusedTopLevelNodes = 0;
    for (let i = 1; i <= 50; i += 1) await render(`Live ${'x'.repeat(i)}`);
    expect(metrics.processTokensInputTokens).toBeLessThan(1000);
    expect(metrics.processTokensReusedTopLevelNodes).toBeGreaterThanOrEqual(4900);
    expect(container.querySelector('.node-content')).toBe(settled);
    expect(container.textContent).toContain(`Live ${'x'.repeat(50)}`);
  } finally {
    await act(async () => root.unmount());
  }
});

test('disabled smooth streaming does not schedule a second commit per content update', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const commits = vi.fn();
  setCustomComponents({ text: ({ node }: { node: { content: string } }) => <span>{node.content}</span> });
  const render = (content: string) => act(async () => {
    root.render(<React.Profiler id="markdown" onRender={commits}>
      <MarkdownRender content={content} final={false} {...MARKSTREAM_CHAT_STREAM_PERFORMANCE} />
    </React.Profiler>);
  });
  try {
    await render('Initial content.\n\nLive initial');
    commits.mockClear();
    for (let i = 0; i < 50; i += 1) await render(`Initial content.\n\nLive ${i}`);
    expect(commits).toHaveBeenCalledTimes(50);
    expect(container.textContent).toContain('Live 49');
  } finally {
    await act(async () => root.unmount());
    setCustomComponents({});
  }
});

test('full-DOM streaming never measures library placeholder heights', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let measurements = 0;
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('node-content')) measurements += 1;
    return 24;
  });
  try {
    let content = '';
    for (let i = 0; i < 50; i += 1) {
      content += `\n\nParagraph ${i}: completed content stays mounted while the tail streams.`;
      await act(async () => {
        root.render(<MarkdownRender content={content} final={false} {...MARKSTREAM_CHAT_STREAM_PERFORMANCE} />);
      });
    }
    expect(container.querySelectorAll('.node-content').length).toBe(50);
    expect(container.textContent).toContain('Paragraph 49');
    expect(measurements).toBe(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('toggling smooth streaming preserves the latest authoritative content', async () => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (content: string, smoothStreaming: boolean, final = true) => act(async () => {
    root.render(<MarkdownRender content={content} final={final} {...MARKSTREAM_CHAT_STREAM_PERFORMANCE} smoothStreaming={smoothStreaming} />);
  });
  const drain = () => act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  try {
    await render('Disabled initial.', false);
    await render('Disabled appended.', false);
    expect(container.textContent).toContain('Disabled appended.');
    await render('Enabled completion.', true);
    await drain();
    expect(container.textContent).toContain('Enabled completion.');
    await render('Enabled pending tail.', true, false);
    await render('Disabled replacement.', false);
    expect(container.textContent).toContain('Disabled replacement.');
    await render('Enabled again.', true);
    await drain();
    expect(container.textContent).toContain('Enabled again.');
    await render('', false);
    expect(container.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

test('keeps measurements when a consumer enables the internal virtual window', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let measurements = 0;
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('node-content')) measurements += 1;
    return 24;
  });
  try {
    await act(async () => {
      root.render(<MarkdownRender
        content={Array.from({ length: 20 }, (_, i) => `Paragraph ${i}.`).join('\n\n')}
        {...MARKSTREAM_CHAT_STREAM_PERFORMANCE} maxLiveNodes={2}
      />);
    });
    expect(measurements).toBeGreaterThan(0);
    expect(container.querySelector('.virtualized')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

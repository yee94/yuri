import { describe, expect, it } from 'vitest';
import {
  applyMarkdownScrollAnchorToCodeMirror,
  applyMarkdownScrollAnchorToPreview,
  captureCodeMirrorScrollAnchor,
  captureMarkdownPreviewScrollAnchor,
  extractMarkdownSourceHeadings,
} from './markdownScrollSync';

const createMockCodeMirrorView = (content: string, opts: { scrollTop: number; scrollHeight: number; clientHeight: number; lineHeight?: number }) => {
  const lines = content.split('\n');
  const lineHeight = opts.lineHeight ?? 20;
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const scrollDOM = {
    scrollTop: opts.scrollTop,
    scrollHeight: opts.scrollHeight,
    clientHeight: opts.clientHeight,
  } as HTMLElement;

  return {
    scrollDOM,
    state: {
      doc: {
        lines: lines.length,
        line: (number: number) => ({ number, from: lineStarts[number - 1] ?? 0 }),
        lineAt: (pos: number) => {
          let lineNumber = 1;
          for (let i = 0; i < lineStarts.length; i += 1) {
            if (lineStarts[i] <= pos) lineNumber = i + 1;
            else break;
          }
          return { number: lineNumber, from: lineStarts[lineNumber - 1] ?? 0 };
        },
      },
    },
    lineBlockAtHeight: (height: number) => {
      const idx = Math.max(0, Math.min(lines.length - 1, Math.floor(height / lineHeight)));
      return { from: lineStarts[idx] ?? 0, top: idx * lineHeight };
    },
    lineBlockAt: (pos: number) => {
      let idx = 0;
      for (let i = 0; i < lineStarts.length; i += 1) {
        if (lineStarts[i] <= pos) idx = i;
        else break;
      }
      return { from: lineStarts[idx] ?? 0, top: idx * lineHeight };
    },
  };
};

describe('markdownScrollSync', () => {
  it('extracts ATX headings while skipping fenced code blocks and disambiguating duplicates', () => {
    const md = [
      '# Intro',
      '```md',
      '## Not A Heading',
      '```',
      '## Notes',
      'body',
      '## Notes',
    ].join('\n');

    expect(extractMarkdownSourceHeadings(md)).toEqual([
      { lineNumber: 1, normalizedText: 'intro', occurrence: 0 },
      { lineNumber: 5, normalizedText: 'notes', occurrence: 0 },
      { lineNumber: 7, normalizedText: 'notes', occurrence: 1 },
    ]);
  });

  it('captures preview heading anchor and restores matching CodeMirror line position', () => {
    const md = ['# Top', 'a', 'b', '## Middle Section', 'c', 'd', '## End'].join('\n');
    const container = document.createElement('div');
    Object.defineProperty(container, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });
    container.scrollTop = 500;
    container.getBoundingClientRect = () => ({ top: 100 } as DOMRect);

    const h1 = document.createElement('h1');
    h1.textContent = 'Top';
    h1.getBoundingClientRect = () => ({ top: -350 } as DOMRect);
    const h2 = document.createElement('h2');
    h2.textContent = 'Middle Section';
    h2.getBoundingClientRect = () => ({ top: 90 } as DOMRect);
    const h2End = document.createElement('h2');
    h2End.textContent = 'End';
    h2End.getBoundingClientRect = () => ({ top: 600 } as DOMRect);
    container.append(h1, h2, h2End);

    const anchor = captureMarkdownPreviewScrollAnchor(container);
    expect(anchor).toEqual({
      ratio: 500 / 800,
      headingText: 'middle section',
      headingOccurrence: 0,
    });

    const view = createMockCodeMirrorView(md, { scrollTop: 0, scrollHeight: 140, clientHeight: 40, lineHeight: 20 });
    applyMarkdownScrollAnchorToCodeMirror(view as never, md, anchor);
    // Line 4 (`## Middle Section`) is index 3 => top = 60.
    expect(view.scrollDOM.scrollTop).toBe(60);
  });

  it('captures CodeMirror heading anchor and restores matching preview heading position', () => {
    const md = ['# Top', 'line', 'line', '## Deep Section', 'more'].join('\n');
    const view = createMockCodeMirrorView(md, { scrollTop: 65, scrollHeight: 400, clientHeight: 100, lineHeight: 20 });
    const anchor = captureCodeMirrorScrollAnchor(view as never, md);
    expect(anchor.headingText).toBe('deep section');
    expect(anchor.headingOccurrence).toBe(0);

    const container = document.createElement('div');
    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 300, configurable: true });
    container.scrollTop = 0;
    container.getBoundingClientRect = () => ({ top: 50 } as DOMRect);

    const h1 = document.createElement('h1');
    h1.textContent = 'Top';
    h1.getBoundingClientRect = () => ({ top: 60 } as DOMRect);
    const h2 = document.createElement('h2');
    h2.textContent = 'Deep Section';
    h2.getBoundingClientRect = () => ({ top: 500 } as DOMRect);
    container.append(h1, h2);

    applyMarkdownScrollAnchorToPreview(container, anchor);
    expect(container.scrollTop).toBe(442);
  });

  it('falls back to scroll ratio when no heading matches in either direction', () => {
    const md = 'plain paragraph without headings\n'.repeat(30);
    const view = createMockCodeMirrorView(md, { scrollTop: 300, scrollHeight: 1000, clientHeight: 400 });
    const anchor = captureCodeMirrorScrollAnchor(view as never, md);
    expect(anchor).toEqual({ ratio: 0.5 });

    const container = document.createElement('div');
    Object.defineProperty(container, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 300, configurable: true });
    container.scrollTop = 0;

    applyMarkdownScrollAnchorToPreview(container, anchor);
    expect(container.scrollTop).toBe(300);

    const targetView = createMockCodeMirrorView(md, { scrollTop: 0, scrollHeight: 800, clientHeight: 200 });
    applyMarkdownScrollAnchorToCodeMirror(targetView as never, md, { ratio: 0.25 });
    expect(targetView.scrollDOM.scrollTop).toBe(150);
  });
});

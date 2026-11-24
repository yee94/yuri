import type { EditorView } from '@codemirror/view';

export type MarkdownScrollAnchor = {
  /** Normalized scroll ratio in [0, 1] used as fallback when no heading anchor matches. */
  ratio: number;
  /** Normalized visible section heading text (trimmed, collapsed whitespace, lowercased). */
  headingText?: string;
  /** 0-based occurrence index among headings with identical normalized text. */
  headingOccurrence?: number;
};

type MarkdownSourceHeading = {
  lineNumber: number;
  normalizedText: string;
  occurrence: number;
};

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const HEADING_VIEWPORT_LEAD_PX = 24;
const PREVIEW_HEADING_OFFSET_PX = 8;

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

const normalizeHeadingText = (raw: string): string => {
  return raw
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
};

/**
 * Extract ATX headings (`# ...` .. `###### ...`) with 1-based line numbers,
 * skipping fenced code blocks (` ``` ` / `~~~`).
 */
export const extractMarkdownSourceHeadings = (content: string): MarkdownSourceHeading[] => {
  const lines = content.split(/\r?\n/);
  const headings: MarkdownSourceHeading[] = [];
  const counts = new Map<string, number>();
  let fenceChar: '`' | '~' | null = null;
  let fenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const char = marker[0] as '`' | '~';
      if (!fenceChar) {
        fenceChar = char;
        fenceLength = marker.length;
      } else if (fenceChar === char && marker.length >= fenceLength && /^\s*$/.test(line.slice(fenceMatch[0].length))) {
        fenceChar = null;
        fenceLength = 0;
      }
      continue;
    }
    if (fenceChar) continue;

    const headingMatch = /^\s{0,3}#{1,6}[ \t]+(.+?)\s*$/.exec(line);
    if (!headingMatch) continue;
    const normalizedText = normalizeHeadingText(headingMatch[1]);
    if (!normalizedText) continue;
    const occurrence = counts.get(normalizedText) ?? 0;
    counts.set(normalizedText, occurrence + 1);
    headings.push({
      lineNumber: index + 1,
      normalizedText,
      occurrence,
    });
  }

  return headings;
};

export const captureMarkdownPreviewScrollAnchor = (container: HTMLElement): MarkdownScrollAnchor => {
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  const ratio = maxScroll > 0 ? clamp01(container.scrollTop / maxScroll) : 0;

  if (container.scrollTop <= 0) {
    return { ratio: 0 };
  }

  const containerRect = container.getBoundingClientRect();
  const headingNodes = Array.from(container.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
  const counts = new Map<string, number>();
  let bestHeading: { headingText: string; headingOccurrence: number } | null = null;

  for (const node of headingNodes) {
    const normalizedText = normalizeHeadingText(node.textContent ?? '');
    if (!normalizedText) continue;
    const occurrence = counts.get(normalizedText) ?? 0;
    counts.set(normalizedText, occurrence + 1);

    const relativeTop = node.getBoundingClientRect().top - containerRect.top;
    if (relativeTop <= HEADING_VIEWPORT_LEAD_PX) {
      bestHeading = { headingText: normalizedText, headingOccurrence: occurrence };
    } else if (!bestHeading && relativeTop <= container.clientHeight * 0.35) {
      bestHeading = { headingText: normalizedText, headingOccurrence: occurrence };
      break;
    } else {
      break;
    }
  }

  return bestHeading ? { ratio, ...bestHeading } : { ratio };
};

export const captureCodeMirrorScrollAnchor = (
  view: Pick<EditorView, 'scrollDOM' | 'state' | 'lineBlockAtHeight'>,
  content: string,
): MarkdownScrollAnchor => {
  const { scrollDOM } = view;
  const maxScroll = Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight);
  const ratio = maxScroll > 0 ? clamp01(scrollDOM.scrollTop / maxScroll) : 0;

  if (scrollDOM.scrollTop <= 0) {
    return { ratio: 0 };
  }

  let topLineNumber = 1;
  try {
    const block = view.lineBlockAtHeight(scrollDOM.scrollTop);
    topLineNumber = view.state.doc.lineAt(block.from).number;
  } catch {
    return { ratio };
  }

  const headings = extractMarkdownSourceHeadings(content);
  let activeHeading: MarkdownSourceHeading | null = null;
  for (const heading of headings) {
    if (heading.lineNumber <= topLineNumber) {
      activeHeading = heading;
    } else {
      break;
    }
  }

  return activeHeading
    ? {
        ratio,
        headingText: activeHeading.normalizedText,
        headingOccurrence: activeHeading.occurrence,
      }
    : { ratio };
};

export const applyMarkdownScrollAnchorToCodeMirror = (
  view: Pick<EditorView, 'scrollDOM' | 'state' | 'lineBlockAt'>,
  content: string,
  anchor: MarkdownScrollAnchor,
): void => {
  const { scrollDOM } = view;
  if (anchor.headingText) {
    const headings = extractMarkdownSourceHeadings(content);
    const match = headings.find(
      (entry) =>
        entry.normalizedText === anchor.headingText
        && entry.occurrence === (anchor.headingOccurrence ?? 0),
    );
    if (match && match.lineNumber >= 1 && match.lineNumber <= view.state.doc.lines) {
      try {
        const line = view.state.doc.line(match.lineNumber);
        const block = view.lineBlockAt(line.from);
        scrollDOM.scrollTop = Math.max(0, block.top);
        return;
      } catch {
        // Fall through to ratio-based scroll restoration.
      }
    }
  }

  const maxScroll = Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight);
  scrollDOM.scrollTop = Math.round(clamp01(anchor.ratio) * maxScroll);
};

export const applyMarkdownScrollAnchorToPreview = (
  container: HTMLElement,
  anchor: MarkdownScrollAnchor,
): void => {
  if (anchor.headingText) {
    const headingNodes = Array.from(container.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
    const counts = new Map<string, number>();
    for (const node of headingNodes) {
      const normalizedText = normalizeHeadingText(node.textContent ?? '');
      if (!normalizedText) continue;
      const occurrence = counts.get(normalizedText) ?? 0;
      counts.set(normalizedText, occurrence + 1);
      if (normalizedText === anchor.headingText && occurrence === (anchor.headingOccurrence ?? 0)) {
        const containerRect = container.getBoundingClientRect();
        const headingRect = node.getBoundingClientRect();
        const targetTop = Math.max(0, headingRect.top - containerRect.top + container.scrollTop - PREVIEW_HEADING_OFFSET_PX);
        container.scrollTop = targetTop;
        return;
      }
    }
  }

  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTop = Math.round(clamp01(anchor.ratio) * maxScroll);
};

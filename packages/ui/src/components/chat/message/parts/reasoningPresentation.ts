export const cleanReasoningText = (text: string): string => {
    if (typeof text !== 'string' || text.trim().length === 0) return '';
    return text.split('\n')
        .map((line: string) => line.replace(/^>\s?/, '').trimEnd())
        .filter((line: string) => line.trim().length > 0)
        .join('\n').trim();
};

const SUMMARY_MAX_CHARS = 80;

/** Strip common markdown syntax so the header preview reads as plain text. */
const stripMarkdown = (text: string): string =>
    text
        // Empty HTML comments are frequently appended by model tool wrappers.
        .replace(/<!--\s*-->/g, '')
        // Fenced code blocks → keep inner text on one line
        .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, inner: string) => inner.trim())
        // Inline code
        .replace(/`([^`]+)`/g, '$1')
        // Bold + italic (*** / __)
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
        .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
        // Headings (# ## ###)
        .replace(/^#{1,6}\s+/gm, '')
        // Links [label](url) → label
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        // Blockquote markers
        .replace(/^>\s?/gm, '')
        // Horizontal rules
        .replace(/^[-*_]{3,}\s*$/gm, '')
        // Remaining leading/trailing punctuation from stripped markers
        .trim();

export const getReasoningSummary = (text: string): string => {
    if (!text) return '';
    // Strip markdown, then collapse all whitespace runs into single spaces.
    const flat = stripMarkdown(text).replace(/\s+/g, ' ').trim();
    if (flat.length <= SUMMARY_MAX_CHARS) return flat;
    // Cut at a word boundary before the limit, then append ellipsis.
    const cut = flat.lastIndexOf(' ', SUMMARY_MAX_CHARS);
    const end = cut > 0 ? cut : SUMMARY_MAX_CHARS;
    return `${flat.substring(0, end).trimEnd()}…`;
};

export type ReasoningExpansionState = { expanded: boolean; source: 'auto' | 'user' };
export const initialReasoningExpansion = (defaultExpanded: boolean | undefined, canAutoExpand: boolean): ReasoningExpansionState => (
    defaultExpanded === true ? { expanded: true, source: 'user' } : { expanded: canAutoExpand, source: 'auto' }
);
export const reconcileReasoningExpansion = (previous: ReasoningExpansionState, canAutoExpand: boolean): ReasoningExpansionState => (
    previous.source === 'user' || previous.expanded || !canAutoExpand ? previous : { expanded: true, source: 'auto' }
);

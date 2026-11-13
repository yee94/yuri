import type { ChatMessageEntry } from './turns/types';
import { normalizeUserDisplayParts } from '../message/normalizeUserDisplayParts';
import type { Part } from '@/lib/opencode/v2-types';
import { Lexer, type Token } from 'marked';
import { filterVisibleParts } from '../message/partUtils';

export interface TranscriptSearchMatch {
    messageId: string;
    partId: string;
    occurrence: number;
    query: string;
}

export function searchPartKey(messageId: string, partId: string): string {
    return JSON.stringify([messageId, partId]);
}

function literalPattern(query: string): RegExp {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
}

// Part identity is immutable. Weak keys retain no messages/runtimes themselves;
// the value is only derived display text, never a cross-session result index.
const displayTextByPart = new WeakMap<Part, string>();
function markdownSearchText(tokens: Token[]): string {
    return tokens.map((token): string => {
        if (token.type === 'image' || token.type === 'html' || token.type === 'def') return '';
        if (token.type === 'space' || token.type === 'br' || token.type === 'hr') return '\n';
        if (token.type === 'code' || token.type === 'codespan') return token.text;
        if (token.type === 'list') return token.items.map((item: { tokens: Token[] }) => markdownSearchText(item.tokens)).join('\n');
        if (token.type === 'table') {
            const rows: { tokens: Token[] }[][] = [token.header, ...token.rows];
            return rows.map((row) => row.map((cell) => markdownSearchText(cell.tokens)).join('\t')).join('\n');
        }
        const children: Token[] | undefined = 'tokens' in token ? token.tokens : undefined;
        if (children) return markdownSearchText(children) + (['paragraph', 'heading', 'blockquote'].includes(token.type) ? '\n' : '');
        const text = 'text' in token && typeof token.text === 'string' ? token.text : '';
        if (!text.includes('&') || typeof document === 'undefined') return text;
        const decoder = document.createElement('textarea');
        decoder.innerHTML = text.replace(/</g, '&lt;');
        return decoder.value;
    }).join('');
}

function searchablePartText(part: Part & { type: 'text' }): string {
    const cached = displayTextByPart.get(part);
    if (cached !== undefined) return cached;
    const text = markdownSearchText(Lexer.lex(part.text));
    displayTextByPart.set(part, text);
    return text;
}

/** One active query per view. Unchanged immutable part arrays are not rescanned on deltas. */
export function createTranscriptSearcher(query: string) {
    const pattern = literalPattern(query);
    const cache = new WeakMap<Part[], TranscriptSearchMatch[]>();
    return (messages: readonly ChatMessageEntry[]): TranscriptSearchMatch[] => {
        if (!query.trim()) return [];
        const results: TranscriptSearchMatch[] = [];
        const seen = new Set<string>();
        const latestById = new Map(messages.map((message) => [message.info.id, message]));
        for (const entry of messages) {
            const message = latestById.get(entry.info.id)!;
            if (seen.has(message.info.id)) continue;
            seen.add(message.info.id);
            let matches = cache.get(message.parts);
            if (!matches) {
                matches = [];
                const parts = filterVisibleParts(message.info.role === 'user' ? normalizeUserDisplayParts(message.parts) : message.parts);
                for (const part of parts) {
                    if (part.type !== 'text' || part.ignored) continue;
                    let occurrence = 0;
                    for (const _match of searchablePartText(part).matchAll(pattern)) {
                        matches.push({ messageId: message.info.id, partId: part.id, occurrence: occurrence++, query });
                    }
                }
                cache.set(message.parts, matches);
            }
            for (const match of matches) results.push(match);
        }
        return results;
    };
}

/** Map rendered text, including matches split by inline Markdown, to DOM ranges. */
export function findTranscriptTextRanges(root: HTMLElement, query: string): Range[] {
    if (!query.trim()) return [];
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: { node: Text; start: number; end: number }[] = [];
    let text = '';
    let current: Node | null;
    while ((current = walker.nextNode())) {
        const node = current as Text;
        if (node.parentElement?.closest('button, [aria-hidden="true"], [hidden], [data-md-code-line-numbers]')) continue;
        const start = text.length;
        text += node.data;
        nodes.push({ node, start, end: text.length });
    }
    const ranges: Range[] = [];
    let nodeIndex = 0;
    for (const match of text.matchAll(literalPattern(query))) {
        const start = match.index;
        const end = start + match[0].length;
        while (nodeIndex < nodes.length && nodes[nodeIndex].end <= start) nodeIndex++;
        const first = nodes[nodeIndex];
        let endIndex = nodeIndex;
        while (endIndex < nodes.length && nodes[endIndex].end < end) endIndex++;
        const last = nodes[endIndex];
        if (!first || !last) continue;
        const range = root.ownerDocument.createRange();
        range.setStart(first.node, start - first.start);
        range.setEnd(last.node, end - last.start);
        ranges.push(range);
    }
    return ranges;
}

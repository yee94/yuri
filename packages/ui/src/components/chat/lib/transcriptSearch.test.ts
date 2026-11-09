import { describe, expect, test } from 'vitest';
import type { ChatMessageEntry } from './turns/types';
import { createTranscriptSearcher, findTranscriptTextRanges } from './transcriptSearch';

const message = (id: string, text: string, role: 'user' | 'assistant' = 'assistant'): ChatMessageEntry => ({
    info: { id, role }, parts: [{ id: `${id}-text`, type: 'text', text }],
} as ChatMessageEntry);

describe('loaded transcript search', () => {
    test('finds every occurrence in loaded user and folded assistant text in transcript order', () => {
        const messages = [message('user', '继续尝试', 'user'), message('folded', '继续尝试，继续处理'), message('final', '完成')];
        expect(createTranscriptSearcher('继续')(messages)).toEqual([
            { messageId: 'user', partId: 'user-text', occurrence: 0, query: '继续' },
            { messageId: 'folded', partId: 'folded-text', occurrence: 0, query: '继续' },
            { messageId: 'folded', partId: 'folded-text', occurrence: 1, query: '继续' },
        ]);
    });

    test('is case insensitive and literal, ignores synthetic user instructions and ignored text', () => {
        const user = message('user', 'hidden instructions', 'user');
        user.parts[0] = { ...user.parts[0], synthetic: true } as typeof user.parts[0];
        const ignored = message('ignored', 'a.b');
        ignored.parts[0] = { ...ignored.parts[0], ignored: true } as typeof ignored.parts[0];
        const visible = message('visible', 'A.B axb a.b');
        expect(createTranscriptSearcher('a.b')([user, ignored, visible])).toHaveLength(2);
        expect(createTranscriptSearcher('hidden')([user])).toEqual([]);
        expect(createTranscriptSearcher('[')([visible])).toEqual([]);
        expect(createTranscriptSearcher('  ')([visible])).toEqual([]);
    });

    test('uses the latest duplicate record and does not index tool output, reasoning, or files', () => {
        const hidden = message('hidden', '');
        hidden.parts = [
            { type: 'reasoning', id: 'thought', text: 'needle' },
            { type: 'tool', id: 'tool', state: { status: 'completed', output: 'needle' } },
            { type: 'file', id: 'file', filename: 'needle.txt' },
        ] as ChatMessageEntry['parts'];
        const search = createTranscriptSearcher('needle');
        expect(search([hidden, message('same', 'stale'), message('same', 'needle')])).toEqual([
            { messageId: 'same', partId: 'same-text', occurrence: 0, query: 'needle' },
        ]);
    });

    test('does not scan unchanged history over 50 streaming updates and releases the cache on query change', () => {
        let reads = 0;
        const history = Array.from({ length: 2000 }, (_, i) => {
            const entry = message(`history-${i}`, '');
            Object.defineProperty(entry.parts[0], 'text', { get: () => { reads++; return 'history '.repeat(256); } });
            return entry;
        });
        const search = createTranscriptSearcher('needle');
        expect(search(history)).toEqual([]);
        const coldReads = reads;
        expect(coldReads).toBeGreaterThanOrEqual(2000);
        for (let i = 0; i < 50; i++) {
            expect(search([...history, message('live', `needle ${i}`)])).toHaveLength(1);
        }
        expect(reads).toBe(coldReads);
        createTranscriptSearcher('different')(history);
        expect(reads).toBeGreaterThan(coldReads);
    });

    test('maps inline Markdown text across text nodes without changing DOM', () => {
        const root = document.createElement('div');
        root.innerHTML = '<p>hello <strong>world</strong> hello world</p><button>hello world</button><span aria-hidden="true">hello world</span>';
        const before = root.innerHTML;
        const ranges = findTranscriptTextRanges(root, 'hello world');
        expect(ranges).toHaveLength(2);
        expect(ranges.map((range) => range.toString())).toEqual(['hello world', 'hello world']);
        expect(root.innerHTML).toBe(before);
        expect(findTranscriptTextRanges(root, '')).toEqual([]);
    });

    test('searches rendered Markdown words, not link destinations, image URLs or formatting syntax', () => {
        const messages = [message('md', 'hello **world** [label](https://example.com/hidden) ![image](hidden.png) &amp; `&amp;`')];
        expect(createTranscriptSearcher('hello world')(messages)).toHaveLength(1);
        expect(createTranscriptSearcher('hidden')(messages)).toEqual([]);
        expect(createTranscriptSearcher('**')(messages)).toEqual([]);
        expect(createTranscriptSearcher('&')(messages)).toHaveLength(2);
        expect(createTranscriptSearcher('&amp;')(messages)).toHaveLength(1);
    });
});

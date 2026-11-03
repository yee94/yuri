import { expect, it } from 'vitest';
import { splitSpeechText } from './speech-segments';

it.each(['中文句子。'.repeat(3000), 'A sentence with some words. '.repeat(2000), '没有句号'.repeat(3000), '🎵'.repeat(1000)])('keeps all long-text content in bounded requests', (text) => {
    const chunks = splitSpeechText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 280 && chunk.trim().length > 0)).toBe(true);
    expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk) && !/^[\uDC00-\uDFFF]/u.test(chunk))).toBe(true);
});

it('keeps a short reply in a single request and ignores blank text', () => {
    expect(splitSpeechText('  简短的回答。  ')).toEqual(['简短的回答。']);
    expect(splitSpeechText(' \n ')).toEqual([]);
});

it('keeps natural paragraphs separate instead of highlighting several at once', () => {
    expect(splitSpeechText('第一段海风。\n\n第二段夕阳。\n\n第三段树影。')).toEqual(['第一段海风。', '第二段夕阳。', '第三段树影。']);
});

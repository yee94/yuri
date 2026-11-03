import { expect, it } from 'vitest';
import { createSpeechTimeline } from './speech-timeline';

const subtitle = (text: string, startTime: number, endTime: number) => ({ text, words: [{ word: text, startTime, endTime }] });

it('aligns original numbers, Markdown, repeated passages and astral characters without rewriting the source', () => {
    const text = '**2019年**，你好。\n\n你好。𠮷祥。';
    const timeline = createSpeechTimeline(text);
    timeline.append(subtitle('2019年，你好。', 0.1, 2));
    timeline.append(subtitle('你好。', 2.5, 3));
    timeline.append(subtitle('𠮷祥。', 3.5, 4));
    expect(timeline.at(0)).toBeUndefined();
    expect(timeline.at(1)).toEqual(expect.objectContaining({ text: '2019年，你好。', start: 2 }));
    const second = timeline.at(2.8)!;
    expect(text.slice(second.start, second.end)).toBe('你好。');
    const final = timeline.at(3.8)!;
    expect(text.slice(final.start, final.end)).toBe('𠮷祥。');
    expect(timeline.at(4.5)).toBeUndefined();
});

it('orders late subtitles by media time rather than arrival and deduplicates retries', () => {
    const timeline = createSpeechTimeline('第一句。第二句。');
    timeline.append(subtitle('第二句。', 3, 4));
    timeline.append(subtitle('第一句。', 0, 2));
    timeline.append(subtitle('第二句。', 3, 4));
    expect(timeline.at(3.5)?.start).toBe(4);
    expect(timeline.at(1)?.start).toBe(0);
    expect(timeline.lastBefore(3)?.text).toBe('第一句。');
});

it('does not fabricate an alignment for translated or summarized text', () => {
    const timeline = createSpeechTimeline('Source only.');
    timeline.append(subtitle('完全不同的文本。', 0, 2));
    expect(timeline.at(1)).toBeUndefined();
});

it.each([-1, NaN, Infinity, '1', 8000])('rejects malformed or unbounded timestamps: %s', (time) => {
    const timeline = createSpeechTimeline('测试');
    expect(() => timeline.append({ text: '测试', words: [{ word: '测试', startTime: time, endTime: time }] })).toThrow();
});

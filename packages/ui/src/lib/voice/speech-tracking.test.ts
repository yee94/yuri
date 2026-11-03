import { afterEach, expect, it, vi } from 'vitest';
import { getSpeechTracking, pauseSpeechFollowing, resumeSpeechFollowing, subscribeSpeechTracking, trackSpeech } from './speech-tracking';

let playback: ReturnType<typeof trackSpeech> | undefined;
afterEach(() => { playback?.stop(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function reply(html: string) {
    const target = document.createElement('div');
    target.innerHTML = html;
    document.body.append(target);
    return target;
}

it('highlights spoken text across formatting without modifying the DOM or user selection', () => {
    const target = reply('<div data-speech-content><p>支持 <strong>iOS/Android</strong> 和 <code>Web</code>。</p><pre>不读代码</pre></div><button>按钮</button>');
    const html = target.innerHTML;
    const selection = window.getSelection()!;
    selection.selectAllChildren(target.querySelector('strong')!);
    playback = trackSpeech(target);
    playback.update('支持 iOS Android 和 Web。', 0);
    expect(getSpeechTracking()?.range?.toString()).toBe('支持 iOS/Android 和 Web');
    expect(selection.toString()).toBe('iOS/Android');
    expect(target.textContent).toBe('支持 iOS/Android 和 Web。不读代码按钮');
    expect(target.querySelectorAll('mark')).toHaveLength(0);
    // The unsupported-engine fallback is paint-only and disappears on stop.
    playback.stop();
    expect(target.innerHTML).toBe(html);
});

it('advances repeated passages, does not advance on retry, and resumes at the saved passage', () => {
    const target = reply('<div data-speech-content><p>重复段落。</p><p>重复段落。</p><p>最后段落。</p></div>');
    playback = trackSpeech(target);
    playback.update('重复段落。', 0);
    const first = getSpeechTracking()?.range?.startContainer;
    playback.update('重复段落。', 0);
    expect(getSpeechTracking()?.range?.startContainer).toBe(first);
    playback.update('重复段落。', 1);
    expect(getSpeechTracking()?.range?.startContainer).not.toBe(first);
    playback.stop();
    playback = trackSpeech(target, '重复段落。');
    playback.update('重复段落。', 1);
    expect(getSpeechTracking()?.range?.startContainer).not.toBe(first);
});

it('locates technical prose even when speech omits file paths and bare URLs', () => {
    const target = reply('<p data-speech-content>已修改 <code>/workspace/src/main.ts</code>，并发布 https://example.com/test 供测试。</p>');
    playback = trackSpeech(target);
    playback.update('已修改 ，并发布 供测试。', 0);
    expect(getSpeechTracking()?.range?.toString()).toBe('已修改 /workspace/src/main.ts，并发布 https://example.com/test 供测试');
});

it('pauses only view following and resumes without restarting audio', () => {
    const target = reply('<p data-speech-content>当前段落。</p>');
    playback = trackSpeech(target);
    playback.update('当前段落。', 0);
    const range = getSpeechTracking()?.range;
    pauseSpeechFollowing(document.createElement('div'));
    expect(getSpeechTracking()?.following).toBe(true);
    pauseSpeechFollowing(target);
    expect(getSpeechTracking()?.following).toBe(false);
    expect(getSpeechTracking()?.range).toBe(range);
    resumeSpeechFollowing();
    expect(getSpeechTracking()?.following).toBe(true);
    expect(getSpeechTracking()?.range).toBe(range);
});

it('does not guess a highlight for generated summaries', () => {
    const target = reply('<p data-speech-content>原文内容。</p>');
    playback = trackSpeech(target);
    playback.update('不是原文的摘要。', 0);
    expect(getSpeechTracking()?.range).toBeNull();
});

it('indexes a long reply once, with no DOM rewrite over 50 passage updates', () => {
    const paragraphs = Array.from({ length: 100 }, (_, index) => `第${index}段文字。`);
    const target = reply(`<div data-speech-content>${paragraphs.map((text) => `<p>${text}</p>`).join('')}</div>`);
    const walk = vi.spyOn(document, 'createTreeWalker');
    const notify = vi.fn();
    const release = subscribeSpeechTracking(notify);
    playback = trackSpeech(target);
    const nodes = [...target.querySelectorAll('p')];
    for (let index = 0; index < 50; index++) playback.update(paragraphs[index], index);
    expect(walk).toHaveBeenCalledTimes(1);
    expect([...target.querySelectorAll('p')]).toEqual(nodes);
    expect(notify).toHaveBeenCalledTimes(51);
    release();
});

it('rejects late updates and cleanup from a replaced playback on the same element', () => {
    const target = reply('<p data-speech-content>当前段落。</p>');
    const old = trackSpeech(target);
    playback = trackSpeech(target);
    playback.update('当前段落。', 0);
    const snapshot = getSpeechTracking();
    old.update('过期。', 1); old.stop();
    expect(getSpeechTracking()).toBe(snapshot);
});

it('cleans the previous reply’s paint when another owner replaces it', () => {
    const first = reply('<p data-speech-content>旧段落。</p>');
    const second = reply('<p data-speech-content>新段落。</p>');
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
        const range = createRange();
        const rects = [new DOMRect(0, 0, 80, 20)];
        range.getClientRects = () => Object.assign(rects, { item: (index: number) => rects[index] ?? null });
        return range;
    });
    const old = trackSpeech(first);
    old.update('旧段落。', 0);
    expect(first.querySelector('.yuri-speech-marker-layer')).not.toBeNull();
    playback = trackSpeech(second);
    playback.update('新段落。', 0);
    old.stop();
    expect(first.querySelector('.yuri-speech-marker-layer')).toBeNull();
    expect(first.hasAttribute('data-speech-active')).toBe(false);
    expect(second.querySelectorAll('.yuri-speech-marker-layer')).toHaveLength(1);
});

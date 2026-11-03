import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useMessageTTS, type UseMessageTTSReturn } from './useMessageTTS';
import { prepareSpeechCapture } from '@/lib/voice/audio-session';

const mocks = vi.hoisted(() => ({
    config: { voiceProvider: 'volcengine', ttsInputMode: 'raw' },
    speak: vi.fn(), stop: vi.fn(), unlock: vi.fn(), localUnlock: vi.fn(), fetch: vi.fn(), cancelSpeech: vi.fn(), update: vi.fn(),
}));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: Object.assign(
    (selector: (state: typeof mocks.config) => unknown) => selector(mocks.config), { getState: () => mocks.config },
) }));
vi.mock('./useServerTTS', () => ({ useServerTTS: () => ({ speak: mocks.speak, stop: mocks.stop, unlockAudio: mocks.unlock, isAvailable: false }) }));
vi.mock('./useSayTTS', () => ({ useSayTTS: () => ({ stop: () => {}, unlockAudio: async () => {} }) }));
vi.mock('./useLocalTTS', () => ({ useLocalTTS: () => ({ stop: () => {}, unlockAudio: mocks.localUnlock }) }));
vi.mock('@/lib/voice/browserVoiceService', () => ({ browserVoiceService: { cancelSpeech: mocks.cancelSpeech, resumeAudioContext: async () => {} } }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
vi.mock('@/lib/voice/speech-tracking', () => ({ trackSpeech: () => ({ update: mocks.update, stop: () => {} }) }));
let current: UseMessageTTSReturn;
let root: ReturnType<typeof createRoot>;
function Probe() { current = useMessageTTS({ enabled: true }); return null; }
beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks(); mocks.config.voiceProvider = 'volcengine'; mocks.config.ttsInputMode = 'raw';
    mocks.speak.mockResolvedValue(undefined);
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(['volcengine', 'openai', 'openai-compatible'])('delegates %s playback to the Host without cached capability gating or configuration', async (provider) => {
    mocks.config.voiceProvider = provider;
    await act(async () => root.render(<Probe />));
    await act(async () => current.play('你好'));
    expect(mocks.speak).toHaveBeenCalledWith('你好', expect.objectContaining({ onStart: expect.any(Function), onEnd: expect.any(Function), onError: expect.any(Function) }));
});

it('settles once on audio end, not synthesis completion', async () => {
    const settled = vi.fn();
    await act(async () => current.play('你好', settled));
    expect(settled).not.toHaveBeenCalled();
    const options = mocks.speak.mock.calls[0][1];
    await act(async () => { options.onEnd(); options.onEnd(); });
    expect(settled).toHaveBeenCalledTimes(1);
});

it.each(['final', 'sanitized'])('cleans Markdown and slash separators before %s playback', async (mode) => {
    mocks.config.ttsInputMode = mode;
    await act(async () => root.render(<Probe />));
    await act(async () => current.play('## **总结**\n支持 `iOS/Android/Web`，支持输入/输出。 / // ／ \\ \n[说明](https://example.com/guide)\n```sh\nnpm run build\n```'));
    expect(mocks.speak).toHaveBeenCalledWith('总结 支持 iOS Android Web，支持输入 输出。 说明', expect.objectContaining({
        onStart: expect.any(Function), onEnd: expect.any(Function), onError: expect.any(Function),
    }));
});

it('stops active speech on Escape and ignores late playback completion', async () => {
    const settled = vi.fn();
    await act(async () => current.play('你好', settled));
    const options = mocks.speak.mock.calls[0][1];
    mocks.stop.mockClear();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    await act(async () => window.dispatchEvent(escape));
    expect(current.isPlaying).toBe(false);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);
    await act(async () => options.onEnd());
    expect(settled).not.toHaveBeenCalled();
});

it('does not consume Escape while idle or during IME composition', async () => {
    const idleEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    await act(async () => window.dispatchEvent(idleEscape));
    expect(idleEscape.defaultPrevented).toBe(false);
    expect(mocks.stop).not.toHaveBeenCalled();
    await act(async () => current.play('你好'));
    mocks.stop.mockClear();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true })));
    expect(current.isPlaying).toBe(true);
    expect(mocks.stop).not.toHaveBeenCalled();
});

it('does not play a summary that resolves after cancellation', async () => {
    mocks.config.ttsInputMode = 'summarized';
    await act(async () => root.render(<Probe />));
    let resolve!: (response: Response) => void;
    mocks.fetch.mockReturnValue(new Promise((done) => { resolve = done; }));
    let playing!: Promise<void>;
    await act(async () => { playing = current.play('很长的回复'.repeat(200)); });
    await act(async () => prepareSpeechCapture());
    await act(async () => { resolve(Response.json({ text: '迟到的摘要' })); await playing; });
    expect(mocks.speak).not.toHaveBeenCalled();
});

it('stops active playback and clears its UI when microphone capture starts', async () => {
    await act(async () => current.play('正在朗读'));
    mocks.stop.mockClear();
    await act(async () => prepareSpeechCapture());
    expect(current.isPlaying).toBe(false);
    expect(mocks.stop).toHaveBeenCalledOnce();
});

it('unlocks the configured local audio context on the enabling gesture', async () => {
    mocks.config.voiceProvider = 'local';
    await act(async () => root.render(<Probe />));
    await act(async () => current.unlock());
    expect(mocks.localUnlock).toHaveBeenCalledTimes(1);
    expect(mocks.unlock).not.toHaveBeenCalled();
});

it('replaces playback owned by another message and ignores its late completion', async () => {
    let other!: UseMessageTTSReturn;
    function Other() { other = useMessageTTS({ enabled: true }); return null; }
    await act(async () => root.render(<><Probe /><Other /></>));
    const settled = vi.fn();
    await act(async () => current.play('第一条消息', settled));
    const firstCompletion = mocks.speak.mock.calls[0][1].onEnd;
    mocks.stop.mockClear();
    await act(async () => other.play('第二条消息'));
    expect(mocks.stop).toHaveBeenCalledTimes(2);
    expect(current.isPlaying).toBe(false);
    expect(other.isPlaying).toBe(true);
    await act(async () => firstCompletion());
    expect(settled).not.toHaveBeenCalled();
    expect(other.isPlaying).toBe(true);
});

it('stops the owned audio when its message is removed', async () => {
    await act(async () => current.play('被撤回的消息'));
    mocks.stop.mockClear();
    await act(async () => root.render(null));
    expect(mocks.stop).toHaveBeenCalledOnce();
});

it('does not revive a pending summary after another message starts', async () => {
    mocks.config.ttsInputMode = 'summarized';
    let other!: UseMessageTTSReturn;
    function Other() { other = useMessageTTS({ enabled: true }); return null; }
    await act(async () => root.render(<><Probe /><Other /></>));
    let resolve!: (response: Response) => void;
    mocks.fetch.mockReturnValue(new Promise((done) => { resolve = done; }));
    let pending!: Promise<void>;
    await act(async () => { pending = current.play('很长的回复'.repeat(200)); });
    await act(async () => other.play('新的朗读'));
    await act(async () => { resolve(Response.json({ text: '旧的摘要' })); await pending; });
    expect(mocks.speak).toHaveBeenCalledTimes(1);
    expect(mocks.speak.mock.calls[0][0]).toBe('新的朗读');
});

it('does not interrupt the new owner when the replaced message unmounts', async () => {
    let other!: UseMessageTTSReturn;
    function Other() { other = useMessageTTS({ enabled: true }); return null; }
    await act(async () => root.render(<><Probe key="old" /><Other key="new" /></>));
    await act(async () => current.play('旧消息'));
    await act(async () => other.play('新消息'));
    mocks.stop.mockClear();
    mocks.cancelSpeech.mockClear();
    await act(async () => root.render(<><Other key="new" /></>));
    expect(other.isPlaying).toBe(true);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.cancelSpeech).not.toHaveBeenCalled();
});

it('submits the whole reply once, without a paragraph-by-paragraph synthesis queue', async () => {
    const text = Array.from({ length: 8 }, () => '这是一段需要连续读完的长文字。'.repeat(8)).join('\n\n');
    const settled = vi.fn();
    await act(async () => current.play(text, settled));
    expect(mocks.speak.mock.calls[0][0]).toBe(text);
    expect(mocks.speak).toHaveBeenCalledTimes(1);
    await act(async () => mocks.speak.mock.calls[0][1].onEnd());
    expect(mocks.speak).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledOnce();
});

it('recovers a broken stream using its audio key and last audible source offset', async () => {
    vi.useFakeTimers();
    const text = '第一段。\n\n第二段。';
    await act(async () => current.play(text));
    const first = mocks.speak.mock.calls[0][1];
    await act(async () => first.onProgress({ text: '第二段。', start: 6, end: text.length }));
    await act(async () => first.onError('Speech synthesis interrupted or failed'));
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(mocks.speak).toHaveBeenCalledTimes(2);
    expect(mocks.speak.mock.calls[1][0]).toBe(text);
    expect(mocks.speak.mock.calls[1][1]).toEqual(expect.objectContaining({ resume: true, resumeOffset: 6, playbackKey: first.playbackKey }));
    expect(current.isPlaying).toBe(true);
});

it('resumes the interrupted passage on play and supports an explicit restart', async () => {
    const text = Array.from({ length: 20 }, (_, index) => `第${index}段。${'海浪慢慢涌来。'.repeat(15)}`).join('\n\n');
    expect(current.canResume(text)).toBe(false);
    await act(async () => current.play(text));
    const first = mocks.speak.mock.calls[0][1];
    await act(async () => first.onProgress({ text: '海浪慢慢涌来。', start: 80, end: 88 }));
    await act(async () => current.stop());
    expect(current.canResume(text)).toBe(true);
    expect(current.canResume(`${text}changed`)).toBe(false);
    await act(async () => current.play(text));
    expect(mocks.speak.mock.calls[1][0]).toBe(text);
    expect(mocks.speak.mock.calls[1][1]).toEqual(expect.objectContaining({ resume: true, resumeOffset: 80, playbackKey: first.playbackKey }));
    await act(async () => current.play(text, undefined, { restart: true }));
    expect(mocks.speak.mock.calls[2][0]).toBe(text);
    expect(mocks.speak.mock.calls[2][1]).toEqual(expect.objectContaining({ resume: false, resumeOffset: 0 }));
    expect(mocks.speak.mock.calls[2][1].playbackKey).not.toBe(first.playbackKey);
});

it('does not restart after a user stop during recovery backoff', async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    await act(async () => current.play('读到一半的段落。', settled));
    const callbacks = mocks.speak.mock.calls[0][1];
    await act(async () => callbacks.onError('network disconnected'));
    await act(async () => current.stop());
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); callbacks.onEnd(); });
    expect(mocks.speak).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    expect(current.isPlaying).toBe(false);
});

it('bounds automatic retries and settles exactly once on repeated failure', async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    await act(async () => current.play('需要恢复的段落。', settled));
    for (let index = 0; index < 3; index++) {
        await act(async () => mocks.speak.mock.calls[index][1].onError('connection lost'));
        await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    }
    expect(mocks.speak).toHaveBeenCalledTimes(3);
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(current.isPlaying).toBe(false);
});

it('does not retry authorization or autoplay failures', async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    await act(async () => current.play('需要手动解锁音频。', settled));
    await act(async () => mocks.speak.mock.calls[0][1].onError('Audio blocked by browser autoplay policy'));
    await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(mocks.speak).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
});

it('recovers when the provider never reports completion', async () => {
    vi.useFakeTimers();
    await act(async () => current.play('卡住的音频。'));
    await act(async () => { await vi.advanceTimersByTimeAsync(45600); });
    expect(mocks.speak).toHaveBeenCalledTimes(2);
    expect(current.isPlaying).toBe(true);
});

it('hands automatic playback progress to another hook for the same reply', async () => {
    let manual!: UseMessageTTSReturn;
    function Manual() { manual = useMessageTTS({ enabled: true }); return null; }
    await act(async () => root.render(<><Probe /><Manual /></>));
    const target = document.createElement('div');
    target.dataset.speechIdentity = 'test-session:test-reply';
    const text = '第一段。'.repeat(80) + '第二段。'.repeat(80);
    await act(async () => current.play(text, undefined, { target }));
    const first = mocks.speak.mock.calls[0][1];
    await act(async () => first.onProgress({ text: '第二段。', start: 320, end: 324 }));
    await act(async () => current.stop());
    expect(manual.canResume(text, target)).toBe(true);
    const otherTarget = document.createElement('div');
    otherTarget.dataset.speechIdentity = 'test-session:other-reply';
    expect(manual.canResume(text, otherTarget)).toBe(false);
    await act(async () => manual.play(text, undefined, { target }));
    expect(mocks.speak.mock.calls[1][0]).toBe(text);
    expect(mocks.speak.mock.calls[1][1]).toEqual(expect.objectContaining({ resume: true, resumeOffset: 320, playbackKey: first.playbackKey }));
});

it('highlights only audible subtitle progress, not synthesis start, and fences late/backward updates', async () => {
    const target = document.createElement('div');
    await act(async () => current.play('第一句。第二句。', undefined, { target }));
    const callbacks = mocks.speak.mock.calls[0][1];
    await act(async () => callbacks.onStart());
    expect(mocks.update).not.toHaveBeenCalled();
    await act(async () => callbacks.onProgress({ text: '第二句。', start: 4, end: 8 }));
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith('第二句。', 4);
    await act(async () => callbacks.onProgress({ text: '第一句。', start: 0, end: 4 }));
    await act(async () => current.stop());
    await act(async () => callbacks.onProgress({ text: '迟到的字幕', start: 8, end: 12 }));
    expect(mocks.update).toHaveBeenCalledTimes(1);
});

it('offers no resume after completion, a provider/content-mode change or a runtime switch', async () => {
    const text = 'A short passage.';
    await act(async () => current.play(text));
    await act(async () => mocks.speak.mock.lastCall![1].onEnd());
    expect(current.canResume(text)).toBe(false);
    await act(async () => current.play(text));
    await act(async () => current.stop());
    expect(current.canResume(text)).toBe(true);
    mocks.config.voiceProvider = 'openai';
    await act(async () => root.render(<Probe />));
    expect(current.canResume(text)).toBe(false);
    mocks.config.voiceProvider = 'volcengine';
    mocks.config.ttsInputMode = 'sanitized';
    await act(async () => root.render(<Probe />));
    expect(current.canResume(text)).toBe(false);
    mocks.config.ttsInputMode = 'raw';
    await act(async () => root.render(<Probe />));
    expect(current.canResume(text)).toBe(true);
    await act(async () => window.dispatchEvent(new CustomEvent('yuri:runtime-endpoint-changed', { detail: {} })));
    expect(current.canResume(text)).toBe(false);
});

it('does not offer the discarded checkpoint after a restarted reply finishes', async () => {
    const target = document.createElement('div');
    target.dataset.speechIdentity = 'session:restart-completed';
    const text = 'Restart this reply.';
    await act(async () => current.play(text, undefined, { target }));
    await act(async () => current.stop());
    expect(current.canResume(text, target)).toBe(true);
    await act(async () => current.play(text, undefined, { target, restart: true }));
    await act(async () => mocks.speak.mock.lastCall![1].onEnd());
    expect(current.canResume(text, target)).toBe(false);
});

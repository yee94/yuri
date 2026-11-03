import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSpeechMarker } from './speech-marker';

let target: HTMLDivElement;
let range: Range;
let rectangles: DOMRect[];
let marker: ReturnType<typeof createSpeechMarker>;
let resize: () => void;
const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', class {
        constructor(callback: () => void) { resize = callback; }
        observe = observe;
        disconnect = disconnect;
    });
    target = document.createElement('div');
    target.innerHTML = '<p>海风<strong>轻轻</strong>吹来。</p>';
    document.body.append(target);
    target.getBoundingClientRect = () => new DOMRect(10, 20, 300, 100);
    range = document.createRange();
    range.selectNodeContents(target.firstElementChild!);
    rectangles = [new DOMRect(20, 30, 100, 20), new DOMRect(20, 58, 80, 20)];
    range.getClientRects = vi.fn(() => Object.assign([...rectangles], { item: (index: number) => rectangles[index] ?? null }));
    marker = createSpeechMarker(target);
});
afterEach(() => { marker.stop(); target.remove(); vi.unstubAllGlobals(); });

it('merges formatted text boxes into one background per line without wrapping text or changing selection', () => {
    const paragraph = target.firstElementChild;
    const text = target.textContent;
    const selection = window.getSelection()!;
    selection.selectAllChildren(target.querySelector('strong')!);
    rectangles.splice(1, 0, new DOMRect(20, 30, 50, 20), new DOMRect(70, 30, 50, 20));
    marker.update(range);
    const layer = target.querySelector('.yuri-speech-marker-layer')!;
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    const strokes = [...layer.querySelectorAll<HTMLElement>('.yuri-speech-marker-stroke')];
    expect(strokes.map((stroke) => [stroke.style.left, stroke.style.top, stroke.style.width, stroke.style.height]))
        .toEqual([['10px', '10px', '100px', '20px'], ['10px', '38px', '80px', '20px']]);
    expect(target.firstElementChild).toBe(paragraph);
    expect(target.textContent).toBe(text);
    expect(selection.toString()).toBe('轻轻');
    expect(target.querySelectorAll('mark')).toHaveLength(0);
    expect(observe).toHaveBeenCalledExactlyOnceWith(target);
});

it('reflows only the active range on resize with one observer and no text enumeration', () => {
    marker.update(range);
    const layer = target.querySelector('.yuri-speech-marker-layer');
    rectangles = [new DOMRect(20, 30, 180, 20)];
    resize();
    expect(target.querySelector('.yuri-speech-marker-layer')).toBe(layer);
    expect(layer?.children).toHaveLength(1);
    expect((layer?.firstElementChild as HTMLElement).style.width).toBe('180px');
    expect(range.getClientRects).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledTimes(1);
});

it('never fills a non-text gap or invents paint for an unmatched range', () => {
    marker.update(null);
    expect(target.querySelector('.yuri-speech-marker-layer')).toBeNull();
    rectangles = [new DOMRect(20, 30, 30, 20), new DOMRect(200, 30, 40, 20), new DOMRect(20, 50, 0, 20)];
    marker.update(range);
    expect(target.querySelectorAll('.yuri-speech-marker-stroke')).toHaveLength(2);
    marker.update(null);
    expect(target.querySelectorAll('.yuri-speech-marker-stroke')).toHaveLength(0);
});

it('removes all paint and observation on stop, and ignores a queued resize after cleanup', () => {
    const html = target.innerHTML;
    marker.update(range);
    marker.stop();
    resize();
    expect(target.innerHTML).toBe(html);
    expect(target.hasAttribute('data-speech-marker-owner')).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
});

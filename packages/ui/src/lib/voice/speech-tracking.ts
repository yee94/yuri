import { createSpeechMarker } from './speech-marker';

type SpeechTracking = {
    target: HTMLElement;
    range: Range | null;
    following: boolean;
};

let current: SpeechTracking | null = null;
let activeToken: symbol | null = null;
let clearActivePaint: (() => void) | null = null;
const listeners = new Set<() => void>();
export const getSpeechTracking = () => current;
export const getSpeechTarget = () => current?.target ?? null;
export const subscribeSpeechTracking = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};
const publish = () => { for (const listener of listeners) listener(); };

export function pauseSpeechFollowing(container: HTMLElement) {
    if (!current?.following || !container.contains(current.target)) return;
    current = { ...current, following: false };
    publish();
}

export function resumeSpeechFollowing() {
    if (!current) return;
    current = { ...current, following: true };
    publish();
}

const normalize = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/** Index only the selected reply once; never replace DOM or the user's Selection. */
export function trackSpeech(target: HTMLElement, precedingText = '', sanitized = true) {
    clearActivePaint?.();
    const token = Symbol('speech');
    activeToken = token;
    const points: { node: Text; offset: number }[] = [];
    let content = '';
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (!node.parentElement?.closest('[data-speech-content]')) continue;
        if (node.parentElement?.closest('button, [aria-hidden="true"], [data-message-actions], [data-message-footer]')) continue;
        if (sanitized && node.parentElement?.closest('pre')) continue;
        const value = node.data;
        // Mirror the sanitizer's omitted URLs/paths without losing DOM offsets.
        const omissions = sanitized ? [...value.matchAll(/https?:\/\/[^\s]+|(?:^|\s)\/(?:[\w.-]+\/)*[\w.-]+/g)] : [];
        let omission = 0;
        for (let offset = 0; offset < value.length;) {
            const omitted = omissions[omission];
            if (omitted && offset >= omitted.index!) {
                offset = omitted.index! + omitted[0].length;
                omission++;
                continue;
            }
            const character = String.fromCodePoint(value.codePointAt(offset)!);
            const normalized = normalize(character);
            for (let index = 0; index < normalized.length; index++) points.push({ node, offset });
            content += normalized;
            offset += character.length;
        }
    }
    const prefix = normalize(precedingText);
    const prefixStart = prefix ? content.indexOf(prefix) : -1;
    let cursor = prefixStart >= 0 ? prefixStart + prefix.length : 0;
    let lastIndex = -1;
    let fallback: HTMLElement | null = null;
    const marker = createSpeechMarker(target);
    const clearPaint = () => {
        marker.stop();
        if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete('yuri-speech');
        fallback?.removeAttribute('data-speech-active');
        fallback = null;
    };
    clearActivePaint = clearPaint;
    const owner = { target, range: null as Range | null, following: true };
    current = owner;
    publish();
    return {
        update(text: string, index: number) {
            if (activeToken !== token || !current) return;
            if (index === lastIndex) return;
            lastIndex = index;
            const needle = normalize(text);
            const start = needle ? content.indexOf(needle, cursor) : -1;
            let range: Range | null = null;
            if (start >= 0) {
                const first = points[start];
                const last = points[start + needle.length - 1];
                range = document.createRange();
                range.setStart(first.node, first.offset);
                range.setEnd(last.node, last.offset + (last.node.data.codePointAt(last.offset)! > 0xffff ? 2 : 1));
                cursor = start + needle.length;
            }
            marker.update(range);
            if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') {
                CSS.highlights.delete('yuri-speech');
                if (range) CSS.highlights.set('yuri-speech', new Highlight(range));
            } else {
                fallback?.removeAttribute('data-speech-active');
                fallback = range?.startContainer.parentElement?.closest<HTMLElement>('p, li, h1, h2, h3, h4, blockquote, [data-speech-content]') ?? null;
                fallback?.setAttribute('data-speech-active', 'true');
            }
            current = { ...current, range };
            publish();
        },
        stop() {
            if (activeToken !== token) return;
            clearPaint();
            clearActivePaint = null;
            current = null;
            activeToken = null;
            publish();
        },
    };
}

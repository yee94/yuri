import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MARKSTREAM_CHAT_STREAM_PERFORMANCE } from './markstreamPerformance';

describe('MARKSTREAM_CHAT_STREAM_PERFORMANCE', () => {
  test('disables the in-bubble sliding window so TanStack owns row height', () => {
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.maxLiveNodes).toBe(0);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.liveNodeBuffer).toBe(0);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.typewriter).toBe(false);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.fade).toBe(false);
  });

    test('turns off typewriter batch / defer knobs that maxLiveNodes=0 would otherwise enable', () => {
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.batchRendering).toBe(false);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.smoothStreaming).toBe(false);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.deferNodesUntilVisible).toBe(false);
        expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.viewportPriority).toBe(false);
    });

    test('only native iOS primary transcripts isolate Markdown compositing without hiding content', () => {
        const style = document.createElement('style');
        style.textContent = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'markstreamTheme.css'), 'utf8')
            .replace(/^@import[^;]+;/m, '')
            .replace(/^@layer[^;]+;/m, '');
        const originalClasses = document.documentElement.className;
        document.head.append(style);
        try {
            for (const nativeIos of [false, true]) {
                document.documentElement.className = nativeIos ? 'yuri-capacitor-app' : 'yuri-capacitor-app yuri-platform-android';
                const scope = document.createElement('div');
                scope.innerHTML = '<div class="chat-scroll"><div class="yuri-markstream-host">Complete reply</div></div><div class="yuri-markstream-host">Other surface</div>';
                document.body.append(scope);
                const host = scope.querySelector<HTMLElement>('.chat-scroll .yuri-markstream-host')!;
                try {
                    expect(getComputedStyle(host).transform).toBe(nativeIos ? 'translateZ(0)' : '');
                    expect(getComputedStyle(scope.lastElementChild!).transform).toBe('');
                    expect(host.textContent).toBe('Complete reply');
                    expect(getComputedStyle(host).display).not.toBe('none');
                    expect(getComputedStyle(host).contentVisibility).not.toBe('auto');
                } finally {
                    scope.remove();
                }
            }
        } finally {
            document.documentElement.className = originalClasses;
            style.remove();
        }
    });

    test('extra code layers follow only the authoritative streaming host on native iOS', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const renderer = readFileSync(join(here, '../MarkstreamRendererImpl.tsx'), 'utf8');
        expect(renderer).toContain("data-yuri-markstream-streaming={isStreaming ? 'true' : undefined}");
        const style = document.createElement('style');
        style.textContent = readFileSync(join(here, 'markstreamTheme.css'), 'utf8')
            .replace(/^@import[^;]+;/m, '').replace(/^@layer[^;]+;/m, '');
        const originalClasses = document.documentElement.className;
        const scope = document.createElement('div');
        scope.innerHTML = '<div class="chat-scroll"><div class="yuri-markstream-host"><div class="yuri-markstream-code-host">Code</div></div></div><div class="yuri-markstream-host" data-yuri-markstream-streaming="true"><div class="yuri-markstream-code-host">Secondary</div></div>';
        document.head.append(style);
        document.body.append(scope);
        const host = scope.querySelector<HTMLElement>('.chat-scroll .yuri-markstream-host')!;
        const code = host.firstElementChild!;
        try {
            for (const runtime of ['yuri-capacitor-app', 'yuri-capacitor-app yuri-platform-android', '']) {
                document.documentElement.className = runtime;
                expect(getComputedStyle(code).transform).toBe('');
                host.dataset.yuriMarkstreamStreaming = 'true';
                expect(getComputedStyle(code).transform).toBe(runtime === 'yuri-capacitor-app' ? 'translateZ(0)' : '');
                expect(getComputedStyle(scope.lastElementChild!.firstElementChild!).transform).toBe('');
                delete host.dataset.yuriMarkstreamStreaming;
                expect(getComputedStyle(code).transform).toBe('');
                expect(code.textContent).toBe('Code');
            }
        } finally {
            document.documentElement.className = originalClasses;
            scope.remove();
            style.remove();
        }
    });
});

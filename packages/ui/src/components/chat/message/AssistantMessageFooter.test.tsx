import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { AssistantMessageFooter } from './AssistantMessageFooter';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const motionPreference = vi.hoisted(() => ({ reduced: false }));
vi.mock('motion/react', async (importOriginal) => ({
    ...await importOriginal<typeof import('motion/react')>(),
    useReducedMotion: () => motionPreference.reduced,
}));

test.each([false, true])('shared footer keeps optional metadata, action and trailing slots ordered (mobile=%s)', async (isMobile) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<AssistantMessageFooter messageId="message" isMobile={isMobile}
            actions={<button>Copy</button>} tps="20 tok/s" duration="1.3s" timestamp="2026-11-03 10:30"
            activity={<span data-background>Background</span>} trailing={<span data-changes>Changes</span>} />));
        const footer = host.querySelector<HTMLElement>('[data-message-footer]')!;
        expect(footer.style.containerName).toBe('message-footer');
        expect(footer.className).toContain(isMobile ? 'mt-1.5' : 'mt-2.5');
        expect(footer.className).toContain(isMobile ? 'mb-2' : 'mb-3');
        expect(footer.firstElementChild?.getAttribute('data-message-action-group')).toBe('true');
        expect(footer.textContent).toBe('Copy20 tok/s1.3sBackground2026-11-03 10:30Changes');
        await act(async () => root.render(<AssistantMessageFooter messageId="message" isMobile={isMobile} actions={<button>Copy</button>} />));
        expect(footer.children).toHaveLength(1);
        expect(footer.querySelector('[data-message-time]')).toBeNull();
        await act(async () => root.render(<AssistantMessageFooter messageId="message" isMobile={isMobile} tps="20 tok/s" />));
        expect(footer.className).toContain(isMobile ? 'mt-1.5' : 'mt-2.5');
        expect(footer.className).toContain(isMobile ? 'mb-2' : 'mb-3');
        expect(footer.querySelector('[data-message-action-group]')).toBeNull();
        expect(footer.textContent).toBe('20 tok/s');
    } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    }
});

test.each([
    { live: true, reduced: false, opacity: '0' },
    { live: false, reduced: false, opacity: '1' },
    { live: true, reduced: true, opacity: '1' },
])('footer entrance is opacity-only (live=$live, reduced=$reduced)', async ({ live, reduced, opacity }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    motionPreference.reduced = reduced;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<AssistantMessageFooter messageId="message" isMobile={false}
            animateReveal={live} actions={<button>Copy</button>} duration="1s" />));
        const footer = host.querySelector<HTMLElement>('[data-message-footer]')!;
        if (opacity === '0') {
            expect(Number(footer.style.opacity)).toBeLessThan(1);
        } else {
            expect(footer.style.opacity).toBe(opacity);
        }
        expect(footer.style.height).toBe('');
        expect(footer.style.transform).toBe('');
        await act(async () => root.render(<AssistantMessageFooter messageId="message" isMobile={false}
            animateReveal={live} actions={<button>Copy</button>} duration="2s" />));
        expect(host.querySelector('[data-message-footer]')).toBe(footer);
        expect(footer.textContent).toBe('Copy2s');
    } finally {
        await act(async () => root.unmount());
        host.remove();
        motionPreference.reduced = false;
        vi.unstubAllGlobals();
    }
});

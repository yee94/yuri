import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { AssistantMessageFooter } from './AssistantMessageFooter';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

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
        expect(footer.className).toContain(isMobile ? 'mb-0.5' : 'mb-2');
        expect(footer.firstElementChild?.getAttribute('data-message-action-group')).toBe('true');
        expect(footer.textContent).toBe('Copy20 tok/s1.3sBackground2026-11-03 10:30Changes');
        await act(async () => root.render(<AssistantMessageFooter messageId="message" isMobile={isMobile} actions={<button>Copy</button>} />));
        expect(footer.children).toHaveLength(1);
        expect(footer.querySelector('[data-message-time]')).toBeNull();
        await act(async () => root.render(<AssistantMessageFooter messageId="message" isMobile={isMobile} tps="20 tok/s" interrupted />));
        expect(footer.getAttribute('data-message-tps')).toBe('interrupted');
        expect(footer.className).toContain(isMobile ? 'mt-3' : 'mt-1.5');
        expect(footer.className).toContain('mb-0.5');
        expect(footer.querySelector('[data-message-action-group]')).toBeNull();
        expect(footer.textContent).toBe('20 tok/s');
    } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    }
});

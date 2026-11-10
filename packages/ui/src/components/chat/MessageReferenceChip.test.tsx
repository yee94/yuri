import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { MessageReferenceChip } from './MessageReferenceChip';
import { buildMessageReferenceParts } from '@/lib/messages/references';

test.each([false, true])('reference chips inherit text metrics without a separate height (interactive=%s)', async (interactive) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const parts = buildMessageReferenceParts('[image-1.png] [skill:review] [command:/commands/build.md]');
    try {
        await act(async () => root.render(
            <div style={{ fontSize: '18px', lineHeight: '30px' }}>
                {parts?.filter((part) => part.type === 'reference').map((part, index) => (
                    <MessageReferenceChip key={index} decoration={part.decoration} interactive={interactive} />
                ))}
                <span data-prose>正文</span>
            </div>,
        ));
        const chips = host.querySelectorAll<HTMLElement>('[data-message-reference-kind]');
        expect(chips).toHaveLength(3);
        for (const chip of chips) {
            const slot = chip.querySelector<HTMLElement>('[aria-hidden="true"]')!;
            expect(slot.classList.contains('leading-none')).toBe(false);
            expect(slot.classList.contains('align-baseline')).toBe(true);
            for (const element of [chip, slot]) {
                expect(element.style.height).toBe('');
                expect(element.style.fontSize).toBe('');
                expect(element.style.lineHeight).toBe('');
            }
            expect(slot.querySelector('svg')?.classList.contains('size-[1em]')).toBe(true);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    }
});

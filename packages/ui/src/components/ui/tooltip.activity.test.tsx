import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

test('an open tooltip closes when its React.Activity is hidden and stays closed when shown again', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = async (mode: 'visible' | 'hidden') => {
        await act(async () => root.render(<TooltipProvider>
            <React.Activity mode={mode}>
                <Tooltip>
                    <TooltipTrigger asChild><button type="button">trigger</button></TooltipTrigger>
                    <TooltipContent>tip</TooltipContent>
                </Tooltip>
            </React.Activity>
        </TooltipProvider>));
    };
    const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 50)); });
    const openPopup = () => document.querySelector('[data-slot="tooltip-content"][data-open]');
    try {
        await render('visible');
        const trigger = host.querySelector('button')!;
        await act(async () => {
            trigger.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }));
            trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            trigger.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        });
        await settle();
        expect(openPopup()).not.toBeNull();

        await render('hidden');
        await settle();
        await render('visible');
        await settle();
        expect(openPopup()).toBeNull();
    } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    }
});

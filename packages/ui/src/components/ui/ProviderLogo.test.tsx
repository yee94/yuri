import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderLogo } from './ProviderLogo';

describe('provider logo contrast', () => {
    it.each(['cursor', 'codex', 'zcode', 'workbuddy', 'qoder', 'trae'])(
        'paints the %s quota mark as a foreground mask',
        (brand) => {
            const container = document.createElement('div');
            container.innerHTML = renderToStaticMarkup(
                <ProviderLogo providerId={`magpie:gateway:${brand}`} className="size-4 shrink-0" />,
            );
            const mark = container.querySelector('[role="img"]') as HTMLElement | null;
            expect(mark).not.toBeNull();
            expect(mark?.classList.contains('bg-foreground')).toBe(true);
            expect(mark?.classList.contains('size-4')).toBe(true);
            expect(mark?.getAttribute('aria-label')).toBe(`magpie:gateway:${brand} logo`);
            expect(mark?.style.maskImage || mark?.getAttribute('style') || '').toMatch(/url\(/);
            expect(container.querySelector('img')).toBeNull();
        },
    );

    it('keeps the themed stack fallback for providers without a bundled mark', () => {
        const container = document.createElement('div');
        container.innerHTML = renderToStaticMarkup(
            <ProviderLogo providerId="unknown-provider" className="size-4 shrink-0" />,
        );
        expect(container.querySelector('[role="img"]')).toBeNull();
        expect(container.querySelector('use')?.getAttribute('href')).toBe('#yuri-stack');
        expect(container.querySelector('svg')?.classList.contains('bg-foreground')).toBe(false);
    });
});

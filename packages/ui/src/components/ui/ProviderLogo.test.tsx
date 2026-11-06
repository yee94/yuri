import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderLogo } from './ProviderLogo';

describe('provider logo contrast', () => {
    it.each(['cursor', 'codex', 'zcode', 'workbuddy'])(
        'normalizes the %s quota mark before dark-mode inversion',
        (brand) => {
            const container = document.createElement('div');
            container.innerHTML = renderToStaticMarkup(
                <ProviderLogo providerId={`magpie:gateway:${brand}`} className="size-4 shrink-0" />,
            );
            const image = container.querySelector('img');
            expect(image).not.toBeNull();
            expect(image?.classList.contains('brightness-0')).toBe(true);
            expect(image?.classList.contains('dark:invert')).toBe(true);
            expect(image?.classList.contains('size-4')).toBe(true);
            expect(image?.getAttribute('alt')).toBe(`magpie:gateway:${brand} logo`);
        },
    );

    it('keeps the themed stack fallback for providers without a bundled mark', () => {
        const container = document.createElement('div');
        container.innerHTML = renderToStaticMarkup(
            <ProviderLogo providerId="unknown-provider" className="size-4 shrink-0" />,
        );
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('use')?.getAttribute('href')).toBe('#yuri-stack');
        expect(container.querySelector('svg')?.classList.contains('brightness-0')).toBe(false);
    });
});

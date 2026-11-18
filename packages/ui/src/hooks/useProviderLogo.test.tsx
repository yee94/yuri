import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useProviderLogo } from './useProviderLogo';

function Logo({ id }: { id: string }) {
    const { src } = useProviderLogo(id);
    return src ? <img src={src} /> : <span>fallback</span>;
}

describe('provider brand logos', () => {
    it.each([
        ['cursor', 'cursor'], ['grok', 'xai'], ['codex', 'openai'],
        ['zcode', 'zai-coding-plan'], ['workbuddy', 'workbuddy'], ['opencode-go', 'opencode'],
        ['qoder', 'qoder'], ['qoder-cn', 'qoder'], ['trae', 'trae'],
        ['Grok (SuperGrok)', 'xai'], ['custom-cursor', 'cursor'],
        ['antigravity', 'google'], ['agy', 'google'],
    ])('resolves Magpie %s to the %s brand asset', (provider, asset) => {
        const html = renderToStaticMarkup(<Logo id={`magpie:gateway:${encodeURIComponent(provider)}`} />);
        expect(html).toBe(renderToStaticMarkup(<Logo id={asset} />));
        expect(html).not.toContain('fallback');
    });

    it('does not infer a brand from the gateway identity', () => {
        const magpie = renderToStaticMarkup(<Logo id="magpie" />);
        expect(magpie).not.toContain('fallback');
        expect(renderToStaticMarkup(<Logo id="magpie:cursor:unknown" />)).toBe(magpie);
        expect(renderToStaticMarkup(<Logo id="magpie:gateway:%invalid" />)).toBe(magpie);
    });

    it.each([
        ['magpie-workbuddy', 'workbuddy'], ['magpie-codex', 'openai'], ['magpie-cursor', 'cursor'],
        ['magpie-qoder', 'qoder'], ['magpie-trae', 'trae'],
        ['magpie/group/workbuddy', 'workbuddy'], ['MAGPIE-GROUP', 'magpie'], ['magpie-auto', 'magpie'],
        ['remote-magpie', 'magpie'],
        ['magpie-remote-magpie%2Fcodex', 'openai'], ['magpie-remote-magpie%2Fzcode', 'zai-coding-plan'],
        ['magpie-remote-magpie%2Fcursor', 'cursor'], ['magpie-remote-magpie%2Fgrok', 'xai'],
        ['magpie-remote-magpie%2Fclaude-code%2Fvps-us', 'anthropic'], ['magpie-remote-magpie%2Fgroup', 'magpie'],
    ])('prefers a specific brand before Magpie for %s', (provider, asset) => {
        const html = renderToStaticMarkup(<Logo id={provider} />);
        expect(html).toBe(renderToStaticMarkup(<Logo id={asset} />));
        expect(html).not.toContain('fallback');
    });

    it('keeps the generic fallback for unrelated unknown providers', () => {
        expect(renderToStaticMarkup(<Logo id="unknown-provider" />)).toContain('fallback');
    });

    it.each([
        'antigravity', 'agy', 'ANTIGRAVITY', 'AGY',
        'custom-antigravity', 'custom-agy', 'agy /w',
        'magpie-remote-magpie%2Fagy', 'magpie-remote-magpie%2Fantigravity',
    ])('resolves %s to the Google brand asset', (provider) => {
        const google = renderToStaticMarkup(<Logo id="google" />);
        expect(google).not.toContain('fallback');
        expect(renderToStaticMarkup(<Logo id={provider} />)).toBe(google);
    });

    it.each(['antigravitycli', 'agy3', 'stagy'])('does not match partial keywords in %s', (provider) => {
        expect(renderToStaticMarkup(<Logo id={provider} />)).toContain('fallback');
    });

    it('keeps existing provider aliases', () => {
        expect(renderToStaticMarkup(<Logo id="codex" />)).toBe(renderToStaticMarkup(<Logo id="openai" />));
        expect(renderToStaticMarkup(<Logo id="github-copilot" />)).not.toContain('fallback');
    });
});

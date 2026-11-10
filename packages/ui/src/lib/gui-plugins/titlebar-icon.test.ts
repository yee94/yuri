import { describe, expect, it } from 'vitest';
import { normalizeGuiTitlebarIcon } from './titlebar-icon';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>图标</title><path fill="#123456" d="M2 2h20v20H2z"/></svg>';
const svgUri = `data:image/svg+xml,${encodeURIComponent(svg)}`;

describe('GUI titlebar icon strings', () => {
    it('keeps icon names and normalizes raw, percent-encoded and base64 SVG to the same image', () => {
        expect(normalizeGuiTitlebarIcon('globe')).toBe('globe');
        expect(normalizeGuiTitlebarIcon('window-analytics')).toBe('window-analytics');
        for (const input of [svg, `  ${svg}  `, svgUri, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`]) {
            expect(normalizeGuiTitlebarIcon(input)).toBe(svgUri);
        }
    });

    it.each(['png', 'jpeg', 'gif', 'webp', 'avif', 'x-icon', 'vnd.microsoft.icon'])('accepts self-contained %s base64 images', (format) => {
        const uri = `data:image/${format};base64,AA==`;
        expect(normalizeGuiTitlebarIcon(uri)).toBe(uri);
    });

    it.each([
        undefined, null, 42, '', ' ', 'data:text/html;base64,PHNjcmlwdC8+',
        'data:image/png,not-base64', 'data:image/png;base64,%%%', 'data:image/png;base64,A',
        'data:image/svg+xml,%ZZ', 'data:image/svg+xml;base64,/w==', '<svg',
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
        '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.test/icon.svg#icon"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
        '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>',
    ])('ignores malformed or unsupported image input %#', (input) => {
        expect(normalizeGuiTitlebarIcon(input)).toBeUndefined();
    });

    it('applies the same SVG checks to data URIs and bounds image input', () => {
        const unsafe = '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>';
        expect(normalizeGuiTitlebarIcon(`data:image/svg+xml,${encodeURIComponent(unsafe)}`)).toBeUndefined();
        expect(normalizeGuiTitlebarIcon(`data:image/svg+xml;base64,${Buffer.from(unsafe).toString('base64')}`)).toBeUndefined();
        expect(normalizeGuiTitlebarIcon(svg.replace('图标', 'x'.repeat(16 * 1024)))).toBeUndefined();
        expect(normalizeGuiTitlebarIcon(`data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`)).toBeUndefined();
    });
});

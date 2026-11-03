import { describe, expect, it } from 'vitest';

import { sanitizeForTTS } from './summarize';

describe('sanitizeForTTS', () => {
    it('optionally retains paragraph boundaries without speaking fenced code', () => {
        const text = '**第一段。**\n\n```ts\ncode\n\nmore code\n```\n\n第二段。\n同一段。';
        expect(sanitizeForTTS(text, true)).toBe('第一段。\n\n第二段。 同一段。');
        expect(sanitizeForTTS(text)).toBe('第一段。 第二段。 同一段。');
    });
    it.each([
        '![]()',
        '![](https://example.com/image.png)',
        '![Screenshot](./image.png "Preview")',
        '![Screenshot](https://example.com/image_(1).png)',
        '![Screenshot \\] detail](./image.png)',
    ])('removes the entire image: %s', (image) => {
        expect(sanitizeForTTS(`Before${image}After`)).toBe('Before After');
        expect(sanitizeForTTS(image)).toBe('');
    });

    it('preserves speech and inline code around multiple images', () => {
        expect(sanitizeForTTS('On `main`![](a.png)and![Preview](b.png)ready!'))
            .toBe('On main and ready!');
    });
});

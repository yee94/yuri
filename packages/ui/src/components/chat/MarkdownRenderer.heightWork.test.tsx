import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';

vi.mock('@/hooks/useRuntimeAPIs', () => ({
    useRuntimeAPIs: () => ({ editor: undefined, runtime: { isVSCode: false } }),
}));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '' }));
vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./markdown/markdownHeightCache', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./markdown/markdownHeightCache')>();
    return { ...actual, markdownHeightCacheKey: vi.fn(actual.markdownHeightCacheKey) };
});

import { MarkdownRenderer } from './MarkdownRendererImpl';
import { markdownHeightCacheKey } from './markdown/markdownHeightCache';

test('50 live code updates do no settled-height hashing, including disabled stream animation', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    const source = `\`\`\`typescript\n${'const value = 1;\n'.repeat(100)}`;
    const key = vi.mocked(markdownHeightCacheKey);
    const render = (content: string, streaming: boolean, disableStreamAnimation = false) => act(async () => {
        root.render(<MarkdownRenderer content={content} messageId="height-work" isAnimated={false}
            isStreaming={streaming} disableStreamAnimation={disableStreamAnimation} enableFileReferences={false} />);
    });
    try {
        for (const disabled of [false, true]) {
            key.mockClear();
            for (let index = 0; index < 50; index += 1) await render(`${source}// ${index}`, true, disabled);
            expect(key.mock.calls.length).toBe(0);
        }
        const complete = `${source}\n\`\`\``;
        await render(complete, false);
        expect(key).toHaveBeenCalledWith(complete, 'assistant');
    } finally {
        await act(async () => root.unmount());
        vi.restoreAllMocks();
    }
});

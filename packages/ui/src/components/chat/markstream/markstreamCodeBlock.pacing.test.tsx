import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';

vi.mock('@/hooks/useRuntimeAPIs', () => ({
    useRuntimeAPIs: () => ({ editor: undefined, runtime: { isVSCode: false } }),
}));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '' }));
vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { MarkstreamCodeBlockNode } from './markstreamCodeBlock';
import { MarkstreamHostContext } from './markstreamHostContext';
import { MarkdownRenderer } from '../MarkdownRendererImpl';

test('50 paced Markstream code updates do not start another reveal loop; standalone legacy keeps its animation', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const code = 'const value = 1;\n'.repeat(100);
    const host = { messageId: 'paced-code', partId: 'part', isStreaming: true,
        disableStreamAnimation: false, variant: 'assistant' as const, enableFileReferences: false };
    const render = (index: number, streaming = true) => act(async () => {
        root.render(<MarkstreamHostContext.Provider value={{ ...host, isStreaming: streaming }}>
            <MarkstreamCodeBlockNode node={{ type: 'code_block', language: 'typescript', code: `${code}// ${index}`, loading: streaming }}
                indexKey="code-0" />
        </MarkstreamHostContext.Provider>);
    });
    try {
        for (let index = 0; index < 50; index += 1) await render(index);
        expect(raf).not.toHaveBeenCalled();
        expect(container.textContent).toContain('// 49');
        await render(49, false);
        expect(container.textContent).toContain('// 49');
        raf.mockClear();
        await act(async () => root.render(<MarkdownRenderer content={`\`\`\`ts\n${code}`} messageId="standalone"
            isAnimated={false} isStreaming enableFileReferences={false} />));
        expect(raf).toHaveBeenCalled();
    } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    }
});

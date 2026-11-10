import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, expect, test, vi } from 'vitest';
import { findTranscriptTextRanges, searchPartKey, type TranscriptSearchMatch } from './lib/transcriptSearch';

// Exercise the production owner's Hooks without bootstrapping the full sync/runtime.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MessageList.tsx'), 'utf8');
const ast = ts.createSourceFile('MessageList.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let expansion = '';
let positioning = '';
const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'searchTurnUiStates') expansion = `const ${node.getText(ast)};`;
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
        && node.expression.expression.getText(ast) === 'React.useEffect' && node.getText(ast).includes("highlights.set('yuri-transcript-find'")) positioning = node.getText(ast);
    ts.forEachChild(node, visit);
};
visit(ast);

const highlights = new Map<string, { ranges: Range[]; priority?: number }>();
const frames = new Map<number, FrameRequestCallback>();
const cancelScroll = vi.fn();
const scrollToIndex = vi.fn(() => true);
const scrollTo = vi.fn();
const cancelViewportAnchorHold = vi.fn();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

afterEach(async () => {
    if (root) await act(async () => root.unmount());
    host?.remove(); vi.unstubAllGlobals(); frames.clear(); highlights.clear();
    vi.clearAllMocks();
});

test('search opens only the target turn, mounts an offscreen row, refines once, and clears highlights on close', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } });
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    host = document.createElement('div'); document.body.append(host);
    host.scrollTo = scrollTo;
    Object.defineProperty(host, 'clientHeight', { value: 600 });
    host.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    const geometry = vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({ top: 900, height: 20 } as DOMRect);
    const states = new Map([['target-turn', { isExpanded: false }], ['other-turn', { isExpanded: false }]]);
    const allEntries = [{ kind: 'turn', turn: { turnId: 'other-turn' } }, { kind: 'turn', turn: { turnId: 'target-turn' } }];
    const messageIndexMap = new Map([['message', 1]]);
    const resolveScrollContainer = () => host;
    const getSearchMessageIndex = (id: string) => messageIndexMap.get(id);
    const tanstackVirtualizerRef = { current: { cancelScroll } };
    const compiled = ts.transpileModule(`return function Owner({ searchTarget }) {
        const turnUiStates = states;
        ${expansion}
        ${positioning}
        return React.createElement('output', null, JSON.stringify([...searchTurnUiStates]));
    }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
    const Owner = new Function('React', 'states', 'allEntries', 'messageIndexMap', 'resolveScrollContainer', 'getSearchMessageIndex', 'tanstackVirtualizerRef', 'cancelViewportAnchorHold', 'scrollHistoryIndexIntoView', 'findTranscriptTextRanges', 'searchPartKey', compiled)(
        React, states, allEntries, messageIndexMap, resolveScrollContainer, getSearchMessageIndex, tanstackVirtualizerRef, cancelViewportAnchorHold, scrollToIndex, findTranscriptTextRanges, searchPartKey,
    ) as React.ComponentType<{ searchTarget: TranscriptSearchMatch | null }>;
    root = createRoot(host);
    const target = { messageId: 'message', partId: 'part', occurrence: 1, query: 'hello' };
    await act(async () => root.render(<Owner searchTarget={target} />));
    expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, 'auto');
    expect(host.textContent).toContain('["target-turn",{"isExpanded":true}]');
    expect(host.textContent).toContain('["other-turn",{"isExpanded":false}]');
    expect(states.get('target-turn')?.isExpanded).toBe(false);

    const row = document.createElement('div');
    row.dataset.transcriptSearchPart = searchPartKey('message', 'part'); row.textContent = 'hello hello';
    host.append(row);
    const flush = async () => {
        await act(async () => {
            const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0));
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    };
    await flush();
    expect(cancelScroll).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 600, behavior: 'auto' });
    expect(highlights.get('yuri-transcript-find')?.ranges.map((range) => range.toString())).toEqual(['hello', 'hello']);
    expect(highlights.get('yuri-transcript-find-active')?.ranges[0].startOffset).toBe(6);
    expect(highlights.get('yuri-transcript-find-active')?.priority).toBe(1);
    row.textContent = 'hello hello updated'; await flush(); await flush();
    expect(scrollTo).toHaveBeenCalledOnce();
    await act(async () => root.render(<Owner searchTarget={null} />));
    expect(highlights.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(host.querySelector('output')?.textContent).toContain('["target-turn",{"isExpanded":false}]');
    geometry.mockRestore();
    expect(source.match(/turnUiStates=\{searchTurnUiStates\}/g)).toHaveLength(2);
});

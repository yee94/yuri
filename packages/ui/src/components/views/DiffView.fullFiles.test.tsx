import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileDiffFromPatch } from '@/lib/diff/patchFileDiff';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'DiffView.tsx'), 'utf8');
const ast = ts.createSourceFile('DiffView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['isBinaryPatch', 'hasLoadedFullContextBody', 'createTextDiffDataFromPatch', 'InlineDiffViewer', 'MultiFileDiffEntry']);
const declarations: string[] = [];
const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && names.has(node.name.getText(ast))) declarations.push(`const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
};
visit(ast);

const patch = '--- a/example.txt\n+++ b/example.txt\n@@ -2,3 +2,3 @@\n context\n-old\n+new\n context\n';
const full = { original: 'start\ncontext\nold\ncontext\nend\n', modified: 'start\ncontext\nnew\ncontext\nend\n' };
const pending = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

describe('full-file diff switch at the production entry boundary', () => {
    beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
    afterEach(() => vi.unstubAllGlobals());

    const fixture = () => {
        const first = pending<{ diff: string }>();
        const complete = pending<typeof full>();
        const git = {
            getGitDiff: vi.fn(() => pending<{ diff: string }>().promise).mockImplementationOnce(() => first.promise),
            getGitFileDiff: vi.fn(() => pending<typeof full>().promise).mockImplementationOnce(() => complete.promise),
        };
        const state = { directories: new Map(), setDiff: vi.fn(), fetchStatus: vi.fn() };
        const viewerProps: Array<{ original: string; modified: string; expandUnchanged?: boolean }> = [];
        const Viewer = (props: typeof viewerProps[number]) => {
            viewerProps.push(props);
            return <pre data-viewer="">{props.modified || 'patch preview'}</pre>;
        };
        const Button = ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props}>{children}</button>;
        const Icon = ({ name }: { name: string }) => <span data-icon={name} />;
        const noView = () => null;
        const dependencies = {
            React, useRuntimeAPIs: () => ({ git }), useGitStore: (selector: (value: typeof state) => unknown) => selector(state),
            useSessionTurnChangeFileQuery: () => ({ data: null, isPending: false }), useI18n: () => ({ t: (key: string) => key }),
            describeChange: () => ({ code: 'M', color: 'inherit', descriptionKey: 'modified' }),
            cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '), isImageFile: () => false,
            getLanguageFromExtension: () => 'text', fileDiffFromPatch, PierreDiffViewer: Viewer,
            Button, Icon, FileTypeIcon: noView, TruncatedPath: noView, formatDiffTotals: noView,
            InlineImageDiffViewer: noView, BinaryDiffPlaceholder: noView, FileDiffActions: noView,
            toast: { error: vi.fn() }, DIFF_REQUEST_TIMEOUT_MS: 15000,
            FULL_CONTEXT_DIFF_LINES: 1000000, DEFAULT_CONTEXT_DIFF_LINES: 3, LARGE_DIFF_CHANGED_LINES: 500,
        };
        const compiled = ts.transpileModule(`${declarations.join('\n')}\nreturn MultiFileDiffEntry;`, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
        }).outputText;
        const Entry = new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies)) as React.ComponentType<Record<string, unknown>>;
        const host = document.createElement('div');
        const root = createRoot(host);
        const props = {
            directory: '/project', file: { path: 'example.txt', index: ' ', working_dir: 'M', insertions: 1, deletions: 1 },
            layout: 'inline', wrapLines: false, isSelected: false, isExpanded: true, isMounted: true,
            onSelect: vi.fn(), onExpandedChange: vi.fn(), registerSectionRef: vi.fn(), showFileActions: false,
        };
        const render = async (loadFullFiles: boolean, overrides: Record<string, unknown> = {}) => act(async () => root.render(<Entry {...props} loadFullFiles={loadFullFiles} {...overrides} />));
        return { first, complete, git, host, viewerProps, render, dispose: () => act(async () => root.unmount()) };
    };

    test('loads full contents once and actually expands unchanged lines, then can collapse again', async () => {
        const f = fixture();
        try {
            await f.render(false);
            await act(async () => f.first.resolve({ diff: patch }));
            expect(f.git.getGitDiff).toHaveBeenCalledTimes(1);
            await f.render(true);
            const mounted = f.host.querySelector('[data-viewer]');
            expect(mounted).not.toBeNull();
            expect(f.host.querySelector('[aria-busy="true"]')).not.toBeNull();
            await act(async () => f.complete.resolve(full));
            expect(f.git.getGitFileDiff).toHaveBeenCalledTimes(1);
            expect(f.viewerProps.at(-1)).toMatchObject({ ...full, expandUnchanged: true });
            expect(f.host.querySelector('[data-viewer]')).toBe(mounted);
            await f.render(false);
            expect(f.viewerProps.at(-1)?.expandUnchanged).toBe(false);
        } finally { await f.dispose(); }
    });

    test('Git Changes preloads expandable full contents but keeps unchanged lines collapsed by default', async () => {
        const f = fixture();
        try {
            await f.render(false, { preloadFullFiles: true });
            await act(async () => f.complete.resolve(full));
            expect(f.git.getGitDiff).not.toHaveBeenCalled();
            expect(f.git.getGitFileDiff).toHaveBeenCalledTimes(1);
            expect(f.viewerProps.at(-1)).toMatchObject({ ...full, expandUnchanged: false });
            const mounted = f.host.querySelector('[data-viewer]');
            await f.render(true, { preloadFullFiles: true });
            expect(f.viewerProps.at(-1)?.expandUnchanged).toBe(true);
            expect(f.git.getGitFileDiff).toHaveBeenCalledTimes(1);
            expect(f.host.querySelector('[data-viewer]')).toBe(mounted);
            await f.render(false, { preloadFullFiles: true });
            expect(f.viewerProps.at(-1)?.expandUnchanged).toBe(false);
            expect(f.git.getGitFileDiff).toHaveBeenCalledTimes(1);
            expect(source).toContain('const [loadFullFiles, setLoadFullFiles] = React.useState(false)');
            expect(source).toContain('preloadFullFiles={preloadFullFiles}');
        } finally { await f.dispose(); }
    });

    test('shows full-file load failure and retry while retaining the rendered patch', async () => {
        const f = fixture();
        try {
            await f.render(false);
            await act(async () => f.first.resolve({ diff: patch }));
            const mounted = f.host.querySelector('[data-viewer]');
            await f.render(true);
            await act(async () => f.complete.reject(new Error('full contents unavailable')));
            expect(f.host.querySelector('[data-viewer]')).toBe(mounted);
            expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('full contents unavailable');
            expect(f.host.querySelector('[role="alert"] button')?.textContent).toContain('diffView.actions.retry');
        } finally { await f.dispose(); }
    });

    test('does not hydrate historical partial snapshots from the current working tree', async () => {
        const f = fixture();
        try {
            await f.render(true, {
                disableGitFetch: true,
                initialDiffData: { original: '', modified: '', contextMode: 'full', fileDiff: fileDiffFromPatch('example.txt', patch) },
            });
            expect(f.git.getGitFileDiff).not.toHaveBeenCalled();
            expect(f.git.getGitDiff).not.toHaveBeenCalled();
            expect(f.viewerProps.at(-1)?.expandUnchanged).toBe(false);
            expect(source).toContain("changedFiles.length > 0 && activeDiffScope !== 'turn' && (");
        } finally { await f.dispose(); }
    });

    test('a late full-file response cannot overwrite a newer patch request', async () => {
        const f = fixture();
        try {
            await f.render(false);
            await act(async () => f.first.resolve({ diff: patch }));
            await f.render(true);
            await f.render(false);
            await act(async () => f.complete.resolve(full));
            expect(f.viewerProps.at(-1)?.original).toBe('');
            expect(f.viewerProps.at(-1)?.expandUnchanged).toBe(false);
        } finally { await f.dispose(); }
    });
});

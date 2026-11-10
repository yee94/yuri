import React, { act } from 'react';
import { useEvent } from '@reactuses/core';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import {
    activateSidebarNumberedSession,
    buildSidebarNumberedSessionTargets,
    clearSidebarNumberedNavigation,
    publishSidebarNumberedNavigation,
} from '@/sync/sidebar-numbered-navigation';
import type { SessionNavigationTarget } from '@/sync/session-navigation';

test('sidebar does not depend on GitHub auth or PR discovery for its session tree', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../SessionSidebar.tsx'), 'utf8');
    const ast = ts.createSourceFile('SessionSidebar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = ast.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.getText(ast));
    expect(imports.some(path => /githubAuthQueries|useGitHubPrStatusStore/i.test(path))).toBe(false);
    expect(source).not.toContain('refreshPrStatusTargets');
    expect(source).not.toContain('prVisualStateByDirectoryBranch');
});

test('project actions preserve the memo boundary through 50 catalog updates and use the latest loader', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../SessionSidebar.tsx'), 'utf8');
    const ast = ts.createSourceFile('SessionSidebar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let declaration = '';
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'toggleProject') declaration = `const ${node.getText(ast)};`;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    let calls = 0;
    const Leaf = React.memo(({ onClick }: { onClick: (id: string) => void }) => {
        calls++;
        return <button onClick={() => onClick('project')}>toggle</button>;
    });
    const compiled = ts.transpileModule(`return function Surface({ ensureProjectSessionsLoaded }) {
        const ignoreIntersectionUntil = React.useRef(0);
        const [collapsedProjects, setCollapsedProjects] = React.useState(() => new Set(['project']));
        const resetProjectSessionLimits = noop, safeStorage = storage, isVSCode = false;
        const scheduleCollapsedProjectsPersist = noop, PROJECT_COLLAPSE_STORAGE_KEY = 'collapse';
        ${declaration}
        return React.createElement(Leaf, { onClick: toggleProject });
    }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const Surface = new Function('React', 'useEvent', 'noop', 'storage', 'Leaf', compiled)(React, useEvent, () => {}, { setItem: () => {} }, Leaf);
    const host = document.createElement('div');
    const root = createRoot(host);
    const loads = vi.fn();
    try {
        await act(async () => root.render(<Surface ensureProjectSessionsLoaded={() => loads(0)} />));
        calls = 0;
        for (let i = 1; i <= 50; i++) {
            await act(async () => root.render(<Surface ensureProjectSessionsLoaded={() => loads(i)} />));
        }
        expect(calls).toBe(0);
        await act(async () => host.querySelector('button')!.click());
        expect(loads).toHaveBeenCalledExactlyOnceWith(50);
    } finally {
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
    }
});

test('numbered row hints refresh through memoized groups when earlier sidebar rows change', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../SessionSidebar.tsx'), 'utf8');
    const ast = ts.createSourceFile('SessionSidebar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declarations = new Map<string, string>();
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, `const ${node.getText(ast)};`);
        ts.forEachChild(node, visit);
    };
    visit(ast);
    const rowDeclaration = declarations.get('renderSessionNode')!;
    const bindings: Record<string, unknown> = {
        React,
        SessionNodeItem: ({ node, shortcutNumber }: { node: { session: { id: string } }; shortcutNumber: number | null }) => (
            <span data-session={node.session.id}>{shortcutNumber ?? ''}</span>
        ),
        getSessionFocusKey: ({ scope, sessionId, projectId }: { scope: string; sessionId: string; projectId: string | null }) => `${scope}:${projectId ?? ''}:${sessionId}`,
        EMPTY_SUBTREE_SET: new Set(),
    };
    const rowAst = ts.createSourceFile('row.tsx', rowDeclaration, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const collectBindings = (node: ts.Node) => {
        if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isIdentifier(node.initializer.expression)) {
            const name = node.initializer.expression.text;
            if (!(name in bindings)) bindings[name] = null;
        }
        ts.forEachChild(node, collectBindings);
    };
    collectBindings(rowAst);
    delete bindings.renderSessionNode;
    let renders = 0;
    const Group = React.memo(({ renderSessionNode }: { renderSessionNode: (node: { session: { id: string } }, depth: number, directory: string, projectId: string) => React.ReactNode }) => {
        renders++;
        return <>{['a', 'b', 'c'].map(id => renderSessionNode({ session: { id } }, 0, '/project', 'project'))}</>;
    });
    const compiled = ts.transpileModule(`
        ${declarations.get('useStableRenderCallback')}
        return function Surface({ sidebarShortcutNumberByFocusKey }) {
            ${rowDeclaration}
            return React.createElement(Group, { renderSessionNode });
        }
    `, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
    const Surface = new Function(...Object.keys(bindings), 'Group', compiled)(...Object.values(bindings), Group);
    const host = document.createElement('div');
    const root = createRoot(host);
    const numbers = (offset: number) => new Map(['a', 'b', 'c'].map((id, index) => [`project:project:${id}`, offset + index + 1]));
    const hints = () => Array.from(host.querySelectorAll('[data-session]'), row => row.textContent);
    try {
        const initialNumbers = numbers(2);
        await act(async () => root.render(<Surface sidebarShortcutNumberByFocusKey={initialNumbers} />));
        expect(hints()).toEqual(['3', '4', '5']);
        const initialRenders = renders;
        for (let index = 0; index < 50; index++) {
            await act(async () => root.render(<Surface sidebarShortcutNumberByFocusKey={numbers(2)} />));
        }
        expect(renders).toBe(initialRenders);
        await act(async () => root.render(<Surface sidebarShortcutNumberByFocusKey={numbers(5)} />));
        expect(hints()).toEqual(['6', '7', '8']);
        await act(async () => root.render(<Surface sidebarShortcutNumberByFocusKey={new Map()} />));
        expect(hints()).toEqual(['', '', '']);
    } finally {
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
    }
});

test('collapsing the sidebar retains pinned and in-progress shortcut targets until it reopens', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../SessionSidebar.tsx'), 'utf8');
    const ast = ts.createSourceFile('SessionSidebar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const statements: string[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => [
            'sidebarNavigationTargets', 'lastVisibleSidebarNavigationRef', 'numberedSidebarSessionTargets',
        ].includes(declaration.name.getText(ast)))) statements.push(node.getText(ast));
        if (ts.isExpressionStatement(node) && node.getText(ast).startsWith('React.useLayoutEffect(')
            && /publishSidebarNumberedNavigation|publishSessionNavigationSnapshot|lastVisibleSidebarNavigationRef|reconcileSessionFocus/.test(node.getText(ast))) statements.push(node.getText(ast));
        ts.forEachChild(node, visit);
    };
    visit(ast);
    const compiled = ts.transpileModule(`return function Surface({ isVisible, visiblePinnedNavigationTargets, visibleProjectNavigationTargets, activate }) {
        const mobileVariant = false;
        const handleNumberedSidebarSessionActivate = activate;
        const isProjectSessionsSyncing = false, currentSessionId = 'running';
        const sessionFocus = { scope: 'pinned', sessionId: currentSessionId, projectId: 'project' };
        const pinnedFocusIdentities = isVisible ? [sessionFocus] : [];
        const projectFocusIdentities = [{ ...sessionFocus, scope: 'project' }];
        const sessionSidebarMetaById = new Map();
        ${statements.join('\n')}
        return null;
    }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const publishAdjacent = vi.fn(() => () => {});
    const reconcileFocus = vi.fn(({ focus }: { focus: unknown }) => focus);
    const syncVisualSelection = vi.fn();
    const Surface = new Function('React', 'buildSidebarNumberedSessionTargets', 'publishSidebarNumberedNavigation', 'publishSessionNavigationSnapshot', 'reconcileSessionFocus', 'syncSidebarVisualSelection', compiled)(React, buildSidebarNumberedSessionTargets, publishSidebarNumberedNavigation, publishAdjacent, reconcileFocus, syncVisualSelection);
    const target = (scope: 'pinned' | 'project', sessionId: string): SessionNavigationTarget => ({ scope, sessionId, projectId: 'project', directory: '/project' });
    const pinned = [target('pinned', 'pinned'), target('pinned', 'running')];
    const projects = [target('project', 'first'), target('project', 'running')];
    const activate = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
        await act(async () => root.render(<Surface isVisible visiblePinnedNavigationTargets={pinned} visibleProjectNavigationTargets={projects} activate={activate} />));
        for (const isVisible of [true, false, false]) {
            reconcileFocus.mockClear();
            syncVisualSelection.mockClear();
            await act(async () => root.render(<Surface isVisible={isVisible} visiblePinnedNavigationTargets={isVisible ? pinned : pinned.slice(0, 1)} visibleProjectNavigationTargets={projects} activate={activate} />));
            activate.mockClear();
            expect(activateSidebarNumberedSession(2)).toBe(true);
            expect(activate).toHaveBeenCalledExactlyOnceWith(pinned[1]);
            expect(activateSidebarNumberedSession(3)).toBe(true);
            expect(activate).toHaveBeenLastCalledWith(projects[0]);
            expect(publishAdjacent).toHaveBeenLastCalledWith({ pinned, project: projects });
            if (!isVisible) {
                expect(reconcileFocus).not.toHaveBeenCalled();
                expect(syncVisualSelection).not.toHaveBeenCalled();
            }
        }
        await act(async () => root.render(<Surface isVisible visiblePinnedNavigationTargets={pinned.slice(0, 1)} visibleProjectNavigationTargets={projects} activate={activate} />));
        activate.mockClear();
        expect(activateSidebarNumberedSession(2)).toBe(true);
        expect(activate).toHaveBeenCalledExactlyOnceWith(projects[0]);
    } finally {
        await act(async () => root.unmount());
        expect(activateSidebarNumberedSession(1)).toBe(false);
        clearSidebarNumberedNavigation();
        vi.unstubAllGlobals();
    }
});

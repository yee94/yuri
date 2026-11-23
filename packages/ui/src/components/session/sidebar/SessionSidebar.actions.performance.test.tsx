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
import { useSessionFocusStore } from '@/stores/useSessionFocusStore';
import { reconcileSessionFocus } from './sessionFocusReconciliation';
import { resolveFocusedProjectTarget } from './resolveFocusedProjectTarget';

test('task header add opens the add-project dialog rather than a new session', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../SessionSidebar.tsx'), 'utf8');
    const ast = ts.createSourceFile('SessionSidebar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let statement = '';
    const visit = (node: ts.Node) => {
        if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'taskHeaderActions')) {
            statement = node.getText(ast);
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(statement).not.toBe('');
    const requestDirectoryDialog = vi.fn();
    const handleNewTask = vi.fn();
    const compiled = ts.transpileModule(`return function Surface({ taskViewActive = true }) {
        ${statement}
        return taskHeaderActions;
    }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
    const Button = ({ children, variant: _variant, size: _size, ...props }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => <button {...props}>{children}</button>;
    const Surface = new Function('React', 'Button', 'Icon', 't', 'sessionEvents', 'handleNewTask', compiled)(
        React, Button, () => null, (key: string) => key, { requestDirectoryDialog }, handleNewTask,
    );
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
        await act(async () => root.render(<Surface />));
        const button = host.querySelector('button')!;
        expect(button.getAttribute('aria-label')).toBe('sessions.sidebar.header.actions.addProject');
        expect(button.title).toBe('sessions.sidebar.header.actions.addProject');
        await act(async () => button.click());
        expect(requestDirectoryDialog).toHaveBeenCalledOnce();
        expect(handleNewTask).not.toHaveBeenCalled();
        await act(async () => root.render(<Surface taskViewActive={false} />));
        expect(host.querySelector('button')).toBeNull();
    } finally {
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
    }
});

test('archiving the focused task keeps the archive shelf closed and focuses the next visible task only after success', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../SessionSidebar.tsx'), 'utf8');
    const ast = ts.createSourceFile('SessionSidebar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const statements: string[] = [];
    const names = new Set(['handleTaskArchiveSuccess', 'handleSetTaskSessionSettled', 'rowSetSessionSettled', 'revealedSettledSessionRef']);
    const visit = (node: ts.Node) => {
        if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => names.has(declaration.name.getText(ast)))) {
            statements.push(node.getText(ast));
        }
        if (ts.isExpressionStatement(node) && node.getText(ast).startsWith('React.useEffect(')
            && /setTaskShelves/.test(node.getText(ast))) statements.push(node.getText(ast));
        ts.forEachChild(node, visit);
    };
    visit(ast);
    const select = vi.fn();
    const draft = vi.fn();
    const mutation = vi.fn((_id: string, _settled: boolean, _options?: { onSuccess?: () => void }) => {});
    let intent = {};
    const compiled = ts.transpileModule(`return function Surface({ taskBuckets, currentSessionId = 'b', id = 'b', nextSettled = true, taskViewActive = true }) {
        const taskViewAvailable = true, activeMainTab = 'chat', pinnedSessions = [], pinnedSessionIds = new Set();
        const rankedTaskBuckets = taskBuckets;
        const sessionOwnership = { bySessionId: new Map(['a', 'b', 'c'].map(id => [id, { projectId: 'project', scopeDirectory: '/repo' }])) };
        const [taskShelves, setTaskShelves] = React.useState({ settledOpen: false, settledLimit: 30 });
        const handleSessionSelect = select, openNewSessionDraft = draft;
        ${statements.join('\n')}
        return React.createElement('button', { 'data-open': String(taskShelves.settledOpen), onClick: () => rowSetSessionSettled(id, nextSettled) }, 'Archive');
    }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const Surface = new Function('React', 'useEvent', 'setSessionSettled', 'select', 'draft', 'getSessionSwitchIntent', 'cancelPendingSidebarVisualSelection', 'syncSidebarVisualSelection', 'SETTLED_SHELF_PAGE_SIZE', compiled)(
        React, useEvent, mutation, select, draft, () => intent, vi.fn(), vi.fn(), 30,
    );
    const host = document.createElement('div');
    const root = createRoot(host);
    const session = (id: string) => ({ id, directory: '/repo' });
    const before = { active: ['a', 'b', 'c'].map(session), settled: [] };
    const after = { active: ['a', 'c'].map(session), settled: [session('b')] };
    const complete = async () => {
        const options = mutation.mock.calls.at(-1)?.[2];
        await act(async () => options?.onSuccess?.());
    };
    try {
        await act(async () => root.render(<Surface taskBuckets={before} />));
        await act(async () => host.querySelector('button')!.click());
        expect(select).not.toHaveBeenCalled();
        await act(async () => root.render(<Surface taskBuckets={after} />));
        expect(host.querySelector('button')?.getAttribute('data-open')).toBe('false');
        await complete();
        expect(select).toHaveBeenCalledExactlyOnceWith('c', '/repo', 'project', 'project');

        select.mockClear();
        await act(async () => root.render(<Surface taskBuckets={before} />));
        await act(async () => host.querySelector('button')!.click());
        intent = {};
        await complete();
        expect(select).not.toHaveBeenCalled();

        await act(async () => root.render(<Surface taskBuckets={before} id="a" />));
        await act(async () => host.querySelector('button')!.click());
        await complete();
        expect(select).not.toHaveBeenCalled();

        await act(async () => root.render(<Surface taskBuckets={after} nextSettled={false} />));
        await act(async () => host.querySelector('button')!.click());
        await complete();
        expect(select).not.toHaveBeenCalled();

        await act(async () => root.render(<Surface taskBuckets={before} currentSessionId="c" id="c" />));
        await act(async () => host.querySelector('button')!.click());
        await act(async () => root.render(<Surface taskBuckets={{ active: ['a', 'b'].map(session), settled: [session('c')] }} currentSessionId="c" id="c" />));
        await complete();
        expect(select).toHaveBeenCalledExactlyOnceWith('b', '/repo', 'project', 'project');

        select.mockClear();
        await act(async () => root.render(<Surface taskBuckets={before} />));
        await act(async () => host.querySelector('button')!.click());
        await act(async () => root.render(<Surface taskBuckets={after} currentSessionId="a" />));
        await complete();
        expect(select).not.toHaveBeenCalled();

        await act(async () => root.render(<Surface taskBuckets={{ active: [session('b')], settled: [] }} />));
        await act(async () => host.querySelector('button')!.click());
        await act(async () => root.render(<Surface taskBuckets={{ active: [], settled: [session('b')] }} />));
        await complete();
        expect(draft).toHaveBeenCalledOnce();
        expect(host.querySelector('button')?.getAttribute('data-open')).toBe('false');
    } finally {
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
    }
});

test('sidebar does not depend on GitHub auth or PR discovery for its session tree', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../SessionSidebar.tsx'), 'utf8');
    const ast = ts.createSourceFile('SessionSidebar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = ast.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.getText(ast));
    expect(imports.some(path => /githubAuthQueries|useGitHubPrStatusStore/i.test(path))).toBe(false);
    expect(source).not.toContain('refreshPrStatusTargets');
    expect(source).not.toContain('prVisualStateByDirectoryBranch');
});

test('group hover metadata keeps project ownership separate from branch labels and updates on project rename', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SessionGroupSection.tsx'), 'utf8');
    const ast = ts.createSourceFile('SessionGroupSection.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declarations = new Map<string, string>();
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, `const ${node.getText(ast)};`);
        ts.forEachChild(node, visit);
    };
    visit(ast);
    const compiled = ts.transpileModule(`return function Surface({ projectLabel, group }) {
        ${declarations.get('groupSessionSecondaryMeta')}
        return React.createElement('span', null, JSON.stringify(groupSessionSecondaryMeta));
    }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const Surface = new Function('React', compiled)(React);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
        for (const isMain of [false, true]) {
            const group = { isMain, label: 'feat/ext-a2a', branch: 'feat/ext-a2a' };
            await act(async () => root.render(<Surface projectLabel="src" group={group} />));
            expect(JSON.parse(host.textContent!)).toEqual({ projectLabel: 'src', branchLabel: 'feat/ext-a2a' });
            await act(async () => root.render(<Surface projectLabel="Source" group={group} />));
            expect(JSON.parse(host.textContent!)).toEqual({ projectLabel: 'Source', branchLabel: 'feat/ext-a2a' });
        }
        const compareSource = ts.transpileModule(`${declarations.get('areGroupPropsEqual')} return areGroupPropsEqual;`, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const compare = new Function(compareSource)();
        const props = { group: { sessions: [] }, groupKey: 'src:feature', projectId: 'src', projectLabel: 'src', groupSearchDataByGroup: new WeakMap() };
        expect(compare(props, { ...props })).toBe(true);
        expect(compare(props, { ...props, projectLabel: 'Source' })).toBe(false);
    } finally {
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
    }
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
    const compiled = ts.transpileModule(`return function Surface({ isVisible, visiblePinnedNavigationTargets, visibleProjectNavigationTargets, activate, taskViewActive = false, taskNavigationTargets = [] }) {
        const mobileVariant = false;
        const handleNumberedSidebarSessionActivate = activate;
        const isProjectSessionsSyncing = false, currentSessionId = 'running';
        const sessionFocus = { scope: 'pinned', sessionId: currentSessionId, projectId: 'project' };
        const pinnedFocusIdentities = isVisible ? [sessionFocus] : [];
        const projectFocusIdentities = [{ ...sessionFocus, scope: 'project' }];
        const sessionSidebarMetaById = new Map();
        const allProjects = [{ id: 'project' }];
        const remoteNavigationTargets = new Map();
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

        // The task view publishes its own visible order to Mod+1…9 and next/previous session.
        const tasks = [target('project', 'task-a'), target('project', 'task-b')];
        await act(async () => root.render(<Surface isVisible visiblePinnedNavigationTargets={pinned.slice(0, 1)} visibleProjectNavigationTargets={projects} activate={activate} taskViewActive taskNavigationTargets={tasks} />));
        expect(publishAdjacent).toHaveBeenLastCalledWith({ pinned: pinned.slice(0, 1), project: tasks });
        activate.mockClear();
        expect(activateSidebarNumberedSession(2)).toBe(true);
        expect(activate).toHaveBeenCalledExactlyOnceWith(tasks[0]);
    } finally {
        await act(async () => root.unmount());
        expect(activateSidebarNumberedSession(1)).toBe(false);
        clearSidebarNumberedNavigation();
        vi.unstubAllGlobals();
    }
});

test('changing sidebar views follows the routed session in both directions without a new navigation intent', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../SessionSidebar.tsx'), 'utf8');
    const ast = ts.createSourceFile('SessionSidebar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const statements: string[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => [
            'pinnedFocusIdentities', 'projectFocusIdentities', 'focusedProjectTarget',
            'revealedSessionSwitchRevisionRef', 'revealedForCurrentSessionRef',
        ].includes(declaration.name.getText(ast)))) statements.push(node.getText(ast));
        if (ts.isExpressionStatement(node) && /^React\.use(?:Layout)?Effect\(/.test(node.getText(ast))
            && /reconcileSessionFocus|revealedForCurrentSessionRef/.test(node.getText(ast))) statements.push(node.getText(ast));
        ts.forEachChild(node, visit);
    };
    visit(ast);
    const compiled = ts.transpileModule(`return function Surface({ taskViewActive, pinned, isVisible = true }) {
        const sessionFocus = useSessionFocusStore(state => state.focus);
        const currentSessionId = 'current', isProjectSessionsSyncing = false;
        const row = { node: { session: { id: currentSessionId }, children: [] }, projectId: 'project' };
        const projectSections = [{ project: { id: 'project' }, groups: [{ sessions: [row.node] }] }];
        const projectNavigationTargets = [target];
        const pinnedNavigationTargets = pinned || !taskViewActive ? [{ ...target, scope: 'pinned' }] : [];
        const taskNavigationTargets = pinned ? [] : [target];
        const sessionSidebarMetaById = new Map([[currentSessionId, row]]);
        const sessionSwitchIntent = intent;
        const setCollapsedGroups = noop, setVisibleSessionCountByGroup = noop;
        ${statements.join('\n')}
        return null;
    }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const target = { scope: 'project' as const, sessionId: 'current', projectId: 'project', directory: '/project' };
    const intent = { sessionId: target.sessionId, revision: 42 };
    const focus = (scope: 'pinned' | 'project') => ({ scope, sessionId: target.sessionId, projectId: target.projectId });
    const expand = vi.fn();
    const Surface = new Function(
        'React', 'useSessionFocusStore', 'reconcileSessionFocus', 'resolveFocusedProjectTarget',
        'syncSidebarVisualSelection', 'ensureProjectExpanded', 'target', 'intent', 'noop', compiled,
    )(React, useSessionFocusStore, reconcileSessionFocus, resolveFocusedProjectTarget,
        useSessionFocusStore.getState().setFocus, expand, target, intent, () => {});
    const root = createRoot(document.createElement('div'));
    const render = async (taskViewActive: boolean, pinned = false, isVisible = true) => {
        await act(async () => root.render(<Surface taskViewActive={taskViewActive} pinned={pinned} isVisible={isVisible} />));
    };
    const select = async (scope: 'pinned' | 'project') => {
        await act(async () => useSessionFocusStore.getState().setFocus(focus(scope)));
    };
    try {
        await select('pinned');
        await render(false);
        expect(useSessionFocusStore.getState().focus).toEqual(focus('pinned'));
        await render(true);
        expect.soft(useSessionFocusStore.getState().focus).toEqual(focus('project'));
        expect.soft(expand).not.toHaveBeenCalled();
        await render(false);
        expect.soft(expand).toHaveBeenCalledExactlyOnceWith('project');
        expand.mockClear();

        await render(true);
        await render(false, false, false);
        expect.soft(expand).not.toHaveBeenCalled();
        await render(false);
        expect.soft(expand).toHaveBeenCalledExactlyOnceWith('project');
        expand.mockClear();
        for (let index = 0; index < 50; index++) await render(false);
        expect(expand).not.toHaveBeenCalled();

        await render(false, true);
        await select('project');
        await render(true, true);
        expect(useSessionFocusStore.getState().focus).toEqual(focus('pinned'));
    } finally {
        await act(async () => root.unmount());
        useSessionFocusStore.getState().setFocus(null);
        vi.unstubAllGlobals();
    }
});

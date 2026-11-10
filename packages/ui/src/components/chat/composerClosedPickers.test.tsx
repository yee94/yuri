import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { BranchSelector } from '../views/git/BranchSelector';

const presence = vi.hoisted(() => ({ visible: false }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/dropdown-menu', () => ({
    DropdownMenu: ({ children }: React.PropsWithChildren) => <>{children}</>,
    DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
    DropdownMenuContent: ({ children }: React.PropsWithChildren) => presence.visible ? <>{children}</> : null,
}));
vi.mock('@/components/ui/MobileResizableSheet', () => ({
    MobileResizableSheet: ({ children }: React.PropsWithChildren) => presence.visible ? <>{children}</> : null,
}));

const host = document.createElement('div');
const root = createRoot(host);
afterEach(async () => { await act(async () => root.render(null)); presence.visible = false; });

describe('closed composer picker work', () => {
    test('model footer offers add-provider as a labeled icon button beside keyboard hints', async () => {
        const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ModelControls.tsx'), 'utf8');
        const ast = ts.createSourceFile('ModelControls.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        let footer = '';
        const visit = (node: ts.Node) => {
            if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'footerContent' && node.initializer && ts.isJsxExpression(node.initializer)) {
                footer = node.initializer.expression?.getText(ast) ?? '';
            }
            ts.forEachChild(node, visit);
        };
        visit(ast);
        expect(footer).not.toBe('');
        const openAddProviderSettings = vi.fn();
        const scope = {
            React, openAddProviderSettings,
            getModelVariantOptions: () => ['high'],
            t: (key: string) => key,
            Kbd: ({ children }: React.PropsWithChildren) => <kbd>{children}</kbd>,
            Icon: ({ name }: { name: string }) => <i data-icon={name} />,
            Button: ({ children, size: _size, variant: _variant, ...props }: React.PropsWithChildren<React.ComponentProps<'button'> & { size?: string; variant?: string }>) => <button {...props}>{children}</button>,
        };
        const compiled = ts.transpileModule(`const renderFooter = ${footer};`, {
            compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
        }).outputText;
        const renderFooter = new Function(...Object.keys(scope), `${compiled}\nreturn renderFooter;`)(...Object.values(scope));
        await act(async () => root.render(renderFooter({ providerID: 'test', modelID: 'model' })));
        const button = host.querySelector('button')!;
        expect(button.getAttribute('aria-label')).toBe('chat.modelControls.addNewProvider');
        expect(button.title).toBe('chat.modelControls.addNewProvider');
        expect(button.textContent).toBe('');
        expect(button.querySelector('[data-icon="add"]')).not.toBeNull();
        expect(button.parentElement?.lastElementChild).toBe(button);
        expect(button.previousElementSibling?.querySelector('kbd')).not.toBeNull();
        await act(async () => button.click());
        expect(openAddProviderSettings).toHaveBeenCalledOnce();
    });

    test('desktop Agent picker keeps reset below the catalog and selection independent', async () => {
        const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ModelControls.tsx'), 'utf8');
        const ast = ts.createSourceFile('ModelControls.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        let popup = '';
        const visit = (node: ts.Node) => {
            if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'DropdownMenuContent'
                && node.getText(ast).includes('yuri-composer-agent-picker')) popup = node.getText(ast);
            ts.forEachChild(node, visit);
        };
        visit(ast);
        expect(popup).not.toBe('');
        const handleAgentChange = vi.fn();
        const scope = {
            React, cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
            DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
            DropdownMenuItem: ({ children, onSelect, ...props }: React.PropsWithChildren<{ onSelect: () => void }>) => <button {...props} onClick={onSelect}>{children}</button>,
            ScrollableOverlay: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
            Input: 'input', Icon: ({ name }: { name: string }) => <i data-icon={name} />,
            AgentAvatar: () => <i />, Kbd: ({ children, variant }: React.PropsWithChildren<{ variant: string }>) => <kbd data-variant={variant}>{children}</kbd>,
            isAgentSelectorInstant: false, INSTANT_DROPDOWN_CLASS: '', handleAgentCycleShortcut: vi.fn(), resolveComposerFinalFocus: vi.fn(),
            agentSearchQuery: '', setAgentSearchQuery: vi.fn(), setAgentSelectorOpen: vi.fn(),
            defaultAgentName: 'build', uiAgentName: 'plan', handleAgentChange,
            sortedAndFilteredAgents: [{ name: 'build', description: 'Build description' }, { name: 'plan', description: 'Plan description' }],
            getAgentCatalogLabel: (agent: { name: string }) => agent.name,
            capitalizeAgentName: (name: string) => name,
            t: (key: string) => key,
        };
        const compiled = ts.transpileModule(`const Surface = () => (${popup});`, {
            compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
        }).outputText;
        const Surface = new Function(...Object.keys(scope), `${compiled}\nreturn Surface;`)(...Object.values(scope));
        await act(async () => root.render(<Surface />));
        const rows = host.querySelectorAll<HTMLButtonElement>('.composer-agent-row');
        expect(rows).toHaveLength(2);
        expect(rows[0].querySelector('[data-icon="check"]')).toBeNull();
        expect(rows[1].querySelector('[data-icon="check"]')).not.toBeNull();
        expect(rows[1].querySelector('.composer-agent-description')?.getAttribute('title')).toBe('Plan description');
        const actions = host.querySelector('.composer-picker-actions')!;
        expect(rows[1].compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(host.querySelector('kbd')?.dataset.variant).toBe('hint');
        await act(async () => rows[1].click());
        expect(handleAgentChange).toHaveBeenLastCalledWith('plan');
        await act(async () => actions.querySelector('button')!.click());
        expect(handleAgentChange).toHaveBeenLastCalledWith('build');
    });

    test.each(['dropdown', 'mobile-sheet'] as const)('%s does not enumerate branches on repeated composer renders', async (presentation) => {
        const localBranches = Array.from({ length: 300 }, (_, i) => `local-${i}`);
        const remoteBranches = Array.from({ length: 300 }, (_, i) => `remote-${i}`);
        const localMap = vi.spyOn(localBranches, 'map');
        const remoteMap = vi.spyOn(remoteBranches, 'map');
        const worktreeOptions = Array.from({ length: 300 }, (_, i) => ({ value: `/tree-${i}`, label: `tree-${i}` }));
        const worktreeMap = vi.spyOn(worktreeOptions, 'map');
        const onCheckout = vi.fn();
        const render = () => root.render(<BranchSelector
            currentBranch="main" localBranches={localBranches} remoteBranches={remoteBranches}
            branchInfo={{}} onCheckout={onCheckout} onCreate={async () => {}}
            worktreeOptions={worktreeOptions} onSelectDirectory={() => {}}
            hideTooltip open={presence.visible} presentation={presentation}
        />);
        for (let i = 0; i < 20; i++) {
            await act(async () => render());
        }
        expect(localMap.mock.calls.length).toBe(0);
        expect(remoteMap.mock.calls.length).toBe(0);
        expect(worktreeMap.mock.calls.length).toBe(0);
        presence.visible = true;
        await act(async () => render());
        expect(host.textContent).toContain('local-299');
        expect(host.textContent).toContain('remote-299');
        expect(host.textContent).toContain('tree-299');
        const row = Array.from(host.querySelectorAll('[cmdk-item]')).find((element) => element.textContent === 'local-1');
        expect(row).toBeDefined();
        await act(async () => (row as HTMLElement).click());
        expect(onCheckout).toHaveBeenCalledWith('local-1');
        presence.visible = false;
        localMap.mockClear(); remoteMap.mockClear(); worktreeMap.mockClear();
        for (let i = 0; i < 20; i++) await act(async () => render());
        expect(localMap.mock.calls.length + remoteMap.mock.calls.length + worktreeMap.mock.calls.length).toBe(0);
    });

    // Execute the production desktop project popup at its JSX boundary, just as
    // ChatInput's render-branch tests do, without bootstrapping session transport.
    test.each(['desktop', 'mobile'])('closed %s project popup never builds project labels during typing', async (mode) => {
        const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ChatInput.tsx'), 'utf8');
        const ast = ts.createSourceFile('ChatInput.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        let popup = '';
        let items = '';
        const visit = (node: ts.Node) => {
            if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'SelectContent'
                && node.getText(ast).includes('desktopDraftProjectQuery') && mode === 'desktop') popup = node.getText(ast);
            if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'MobileResizableSheet'
                && node.getText(ast).includes('mobile-draft-project-picker-sheet') && mode === 'mobile') popup = node.getText(ast);
            if (ts.isFunctionDeclaration(node) && node.name?.text === 'DraftProjectItems') items = node.getText(ast);
            ts.forEachChild(node, visit);
        };
        visit(ast);
        expect(popup).not.toBe('');
        const renderProjectLabelWithIcon = vi.fn(() => 'project');
        const projects = Array.from({ length: 300 }, (_, i) => ({ id: `${i}`, path: `/project-${i}` }));
        const enumerateProjects = vi.spyOn(projects, 'filter');
        const scope = {
            React, projects, renderProjectLabelWithIcon, desktopDraftProjectQuery: '',
            SelectContent: ({ children }: React.PropsWithChildren) => presence.visible ? <>{children}</> : null,
            MobileResizableSheet: ({ children }: React.PropsWithChildren) => presence.visible ? <>{children}</> : null,
            ScrollableOverlay: ({ children }: React.PropsWithChildren) => <>{children}</>,
            mobileDraftProjectSheetId: 'test', mobileDraftPicker: null, mobileDraftPickerQuery: '',
            setMobileDraftPicker: vi.fn(), setMobileDraftPickerQuery: vi.fn(),
            handleDraftProjectChange: vi.fn(), selectedDraftProject: projects[0],
            SelectItem: 'div', SelectSeparator: 'hr', Input: 'input', Icon: 'i',
            setDesktopDraftProjectQuery: vi.fn(), setDesktopDraftProjectPickerOpen: vi.fn(),
            t: (key: string) => key, matchesModelSearch: () => true,
            getProjectDisplayLabel: (project: { path: string }) => project.path,
        };
        const compiled = ts.transpileModule(`${items}\nconst Surface = () => (${popup});`, {
            compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
        }).outputText;
        const Surface = new Function(...Object.keys(scope), `${compiled}\nreturn Surface;`)(...Object.values(scope));
        for (let i = 0; i < 20; i++) await act(async () => root.render(<Surface />));
        expect(renderProjectLabelWithIcon.mock.calls.length).toBe(0);
        expect(enumerateProjects.mock.calls.length).toBe(0);
        presence.visible = true;
        await act(async () => root.render(<Surface />));
        expect(renderProjectLabelWithIcon.mock.calls.length).toBe(300);
        expect(enumerateProjects.mock.calls.length).toBe(1);
        presence.visible = false;
        renderProjectLabelWithIcon.mockClear();
        enumerateProjects.mockClear();
        for (let i = 0; i < 20; i++) await act(async () => root.render(<Surface />));
        expect(renderProjectLabelWithIcon.mock.calls.length).toBe(0);
        expect(enumerateProjects.mock.calls.length).toBe(0);
    });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectHomeDivider, projectHomeDensityGeometry, projectHomeGeometry, projectHomeSurface, worktreeFormLayout } from './projects-presentation';
import ts from 'typescript';
import geometryPostcss from '../../scripts/postcss-dpt-font-size.mjs';

describe('native Projects uses the current mobile Web hierarchy', () => {
  it.each([50, 100, 105, 200])('keeps custom-variable page inset/group gap fixed at %s%% while Tailwind gap-5 scales', padding => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
    const css = read('../ui/src/styles/mobile.css');
    const shell = css.match(/\.yuri-mobile-project-shell\s*\{([^}]+)\}/)![1];
    const pageInset = css.match(/--yuri-mobile-page-inline-inset:\s*([^;]+);/)![1];
    const groupGap = shell.match(/--yuri-mobile-project-group-gap:\s*([^;]+);/)![1];
    expect(read('../ui/src/mobile/MobileTabsRoot.tsx')).toContain('px-[var(--yuri-mobile-page-inline-inset)]');
    expect(css).toContain('gap: var(--yuri-mobile-project-group-gap);');
    expect(read('../ui/src/mobile/projects/MobileProjectsHome.tsx')).toContain('flex-col gap-5');
    expect(read('../ui/src/styles/design-system.css')).toContain('--spacing-5: calc(1.25rem * var(--padding-scale, 1));');
    const declarations = [
      { prop: '--yuri-mobile-page-inline-inset', value: pageInset },
      { prop: '--yuri-mobile-project-group-gap', value: groupGap },
      { prop: 'padding-inline', value: 'var(--yuri-mobile-page-inline-inset)' },
      { prop: 'gap', value: 'var(--yuri-mobile-project-group-gap)' },
    ];
    const before = declarations.map(declaration => declaration.value);
    for (const declaration of declarations) geometryPostcss().Declaration(declaration);
    expect(declarations.map(declaration => declaration.value)).toEqual(before);
    const geometry = projectHomeDensityGeometry(padding);
    expect(geometry.pageInset).toBe(parseFloat(pageInset) * 16);
    expect(geometry.groupGap).toBe(parseFloat(groupGap) * 16);
    expect(geometry.pageGap).toBeCloseTo(20 * Math.sqrt(padding / 100));
  });

  it('matches the actual compact project-shell dimensions rather than the standalone card defaults', () => {
    const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../ui/src/styles/mobile.css'), 'utf8');
    for (const [variable, points] of [['header-height', projectHomeGeometry.headerHeight], ['icon-size', projectHomeGeometry.icon], ['group-gap', projectHomeGeometry.groupGap]] as const) {
      expect(css).toContain(`--yuri-mobile-project-${variable}: ${variable === 'group-gap' ? `${points / 16}rem;` : `calc(${points / 16}rem * var(--padding-scale, 1));`}`);
    }
    expect(css).toContain(`--yuri-mobile-session-row-height: calc(${projectHomeGeometry.rowHeight / 16}rem * var(--padding-scale, 1));`);
    expect(projectHomeSurface.glassEffect).toBe('regular');
    expect(projectHomeSurface.borderRadius).toBe(24);
    expect(projectHomeSurface).not.toHaveProperty('borderWidth');
  });

  it('uses the Web light/dark foreground-derived group divider without hardcoded theme colors', () => {
    expect(projectHomeDivider('#212121', false)).toBe('#2121210f');
    expect(projectHomeDivider('#dedede', true)).toBe('#dedede08');
    expect(projectHomeDivider('#abc8', false)).toBe('#aabbcc08');
  });

  it.each([50, 100, 200])('worktree form keeps independent scroll and fixed footer geometry at %s%% padding', padding => {
    const scale = Math.sqrt(padding / 100), layout = worktreeFormLayout(scale);
    expect(layout.footer.flexShrink).toBe(0);
    expect(layout.footer.paddingHorizontal).toBe(16 * scale);
    expect(layout.fields.gap).toBe(24 * scale);
    expect(layout.input.paddingVertical).toBe(4 * scale);
    expect(layout.input.minHeight).toBe(36);
    expect(layout.inputHitSlop).toEqual({ top: 4, bottom: 4, left: 0, right: 0 });
    expect(layout.input.minHeight + layout.inputHitSlop.top + layout.inputHitSlop.bottom).toBe(44);
    expect(layout.inputHitSlop.top).toBeLessThan(layout.group.gap);
    expect(layout.inputHitSlop.top + layout.inputHitSlop.bottom).toBeLessThan(layout.fields.gap);
    expect(layout.control.minHeight).toBe(36);
  });

  it('production worktree actions are siblings of the scroll region, ordered cancel then create', () => {
    const filename = path.join(path.dirname(fileURLToPath(import.meta.url)), 'projects.tsx');
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const identified = new Map<string, ts.JsxOpeningElement | ts.JsxSelfClosingElement>();
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        for (const attribute of node.attributes.properties) if (ts.isJsxAttribute(attribute) && attribute.name.getText() === 'testID' && attribute.initializer && ts.isStringLiteral(attribute.initializer)) identified.set(attribute.initializer.text, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    const ancestors = (node: ts.Node) => { const result: ts.Node[] = []; for (let parent = node.parent; parent; parent = parent.parent) result.push(parent); return result; };
    const cancel = identified.get('projects-worktree-cancel')!, create = identified.get('projects-worktree-create')!, footer = identified.get('projects-worktree-footer')!;
    expect(cancel).toBeDefined(); expect(create).toBeDefined();
    expect(cancel.pos).toBeLessThan(create.pos);
    for (const action of [cancel, create]) {
      expect(ancestors(action).some(node => ts.isJsxElement(node) && node.openingElement === footer)).toBe(true);
      expect(ancestors(action).some(node => ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'Scroll')).toBe(false);
    }
    expect(identified.get('projects-worktree-form-scroll')!.tagName.getText()).toBe('Scroll');
  });

  it('assigns field hitSlop directly to the real Inputs without making label/error/reset groups press targets or forwarding focus', () => {
    const filename = path.join(path.dirname(fileURLToPath(import.meta.url)), 'projects.tsx');
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const inputs: ts.JsxSelfClosingElement[] = [];
    function visit(node: ts.Node) {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'Input'
        && node.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText() === 'testID'
          && /projects-worktree-(?:branch|folder)/.test(a.initializer?.getText() ?? ''))) inputs.push(node);
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      const inputAttributes = new Map(input.attributes.properties.filter(ts.isJsxAttribute).map(a => [a.name.getText(), a.initializer?.getText()]));
      expect(inputAttributes.get('hitSlop')).toBe('{formLayout().inputHitSlop}');
      expect(inputAttributes.has('ref')).toBe(false);
      const parent = input.parent;
      expect(ts.isJsxElement(parent)).toBe(true);
      const view = (parent as ts.JsxElement).openingElement;
      expect(view.tagName.getText()).toBe('View');
      const attributes = new Map(view.attributes.properties.filter(ts.isJsxAttribute).map(a => [a.name.getText(), a.initializer?.getText()]));
      expect(attributes.get('style')).toBe('{formLayout().group}');
      expect(attributes.has('hitSlop')).toBe(false);
      expect([...attributes.keys()].filter(name => /^on(?:Press|LongPress|Touch|Responder)/.test(name))).toEqual([]);
      expect(parent.getText()).not.toMatch(/\.focus\s*\(/);
      expect(inputAttributes.get('onBlur')).toBe('{() => form.touched.set(true)}');
    }
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { MobileSessionIndicator } from '../ui/src/mobile/projects/mobileSessionIndicator';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(root, 'projects-attention-indicator.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2023 } }).outputText;
type Node = { type: string | ((props: Record<string, unknown>) => Node); props: Record<string, unknown>; children: Node[] };
function fixture() {
  const exports: { ProjectsSessionIndicator?: (props: { indicator: MobileSessionIndicator; sessionID: string }) => Node } = {};
  const colors: Record<string, string> = { border: '#111111', 'muted-foreground': '#777777', destructive: '#ee1111' };
  const imports: Record<string, unknown> = { nsh: { Image: 'Image', View: 'View', token: (name: string) => colors[name], colorScheme: () => 'dark' },
    './Icon': { Icon: 'Icon' }, './i18n': { t: (key: string) => key }, './appearance': { nativeAgentPaletteTokens: () => ({ '--status-warning': '#cccc11', '--status-info': '#1111ee' }) },
    '../ui/src/lib/theme/themes/yuri-2-dark.json': { colors: { status: {} } }, '../ui/src/lib/theme/themes/yuri-2-light.json': { colors: { status: {} } },
  };
  const If = (props: Record<string, unknown>) => props.when ? props.children : props.else;
  const React = { createElement: (type: Node['type'], props: Record<string, unknown> | null, ...children: Node[]) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children }, children }) };
  vm.runInNewContext(compiled, { exports, require: (id: string) => { if (!(id in imports)) throw new Error(id); return imports[id]; }, React, If });
  const collect = (node: Node | Node[] | undefined): Node[] => !node ? [] : Array.isArray(node) ? node.flatMap(collect)
    : typeof node.type === 'function' ? collect(node.type(node.props)) : [node, ...node.children.flatMap(collect)];
  return (indicator: MobileSessionIndicator) => collect(exports.ProjectsSessionIndicator!({ indicator, sessionID: 'root' }));
}
describe('native Projects Web indicator parity without an engine', () => {
  it('uses the real question/shield artwork, semantic status colors and existing accessible labels', () => {
    const render = fixture();
    for (const [status, icon, color, key] of [['question', 'question', '#cccc11', 'questionRequired'], ['permission', 'shield', '#ee1111', 'permissionRequired']] as const) {
      const nodes = render(status);
      expect(nodes[0].props.accessibilityLabel).toBe(`sessions.sidebar.session.status.${key}`);
      expect(nodes[0].props.testID).toBe(`projects-indicator-root-${status}`);
      expect(nodes.find(node => node.type === 'Icon')?.props).toMatchObject({ name: icon, size: 14, color });
      expect(nodes.some(node => node.type === 'Image')).toBe(false);
    }
  });
  it('retains the Web 14pt two-circle 28% busy ring and 5pt info/muted dots, not a new loading glyph', () => {
    const render = fixture(), running = render('running');
    const image = running.find(node => node.type === 'Image')!;
    const svg = decodeURIComponent(String(image.props.src).replace('data:image/svg+xml,', ''));
    expect(svg.match(/<circle/g)).toHaveLength(2); expect(svg).toContain('r="6.25"'); expect(svg).toContain('stroke-width="1.5"');
    expect(svg).toContain(`stroke-dasharray="${2 * Math.PI * 6.25 * .28} ${2 * Math.PI * 6.25 * .72}"`);
    expect(running.some(node => node.props.class === 'animate-spin')).toBe(true);
    expect(running.some(node => node.type === 'Icon')).toBe(false);
    const unread = render('completed-unread').find(node => node.props.class === 'rounded-full')!;
    expect(unread.props.style).toMatchObject({ width: 5, height: 5, backgroundColor: '#1111ee', opacity: 1 });
    const idle = render('idle'); expect(idle[0].props.accessibilityLabel).toBeUndefined();
    expect(idle.find(node => node.props.class === 'rounded-full')!.props.style).toMatchObject({ width: 5, height: 5, backgroundColor: '#777777', opacity: .35 });
  });
  it('reuses translated labels in every one of the ten shipped languages', async () => {
    const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'pl', 'pt-BR', 'uk'];
    for (const locale of locales) {
      const { dict } = await import(`../ui/src/lib/i18n/messages/${locale}.ts`);
      for (const key of ['questionRequired', 'permissionRequired', 'active', 'unread']) expect(dict[`sessions.sidebar.session.status.${key}`], `${locale}:${key}`).toBeTruthy();
    }
  });
});

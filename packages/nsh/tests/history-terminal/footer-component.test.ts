import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as footer from '../../history-footer';
import * as natural from '../../history-footer-natural';
import * as rows from '../../history-rows';
import * as scroll from '../../history-scroll';
import * as release from './footer-release';
import * as scenario from './scenario';

type Element = { type: string; props: Record<string, unknown>; children: Element[] };
function fixture() {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../history-terminal-fixture.tsx');
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
  let root!: Element;
  const events: Array<{ measurement: { admitted: boolean }; footerHold: { measuredHeight: number } }> = [];
  const native = {
    batch: (work: () => void) => work(), cleanup: () => {}, effect: () => {}, untracked: (work: () => unknown) => work(),
    lifecycle: () => 'inactive', safeArea: () => ({ top: 0, bottom: 0 }), host: { available: () => false },
    signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
    computed: (read: () => unknown) => read, mount: (render: () => Element) => { root = render(); }, View: 'View', List: 'List', Text: 'Text',
  };
  const modules: Record<string, unknown> = { nsh: native, 'nsh/base': { Button: 'Button', TextView: 'TextView' },
    './history-footer': footer, './history-rows': rows, './history-scroll': scroll,
    './history-footer-natural': natural, './tests/history-terminal/footer-release': release,
    './tests/history-terminal/scenario': scenario };
  vm.runInNewContext(source, { exports: {}, performance, setTimeout, clearTimeout, If: 'If',
    require: (id: string) => { if (!(id in modules)) throw new Error('Unexpected fixture import: ' + id); return modules[id]; },
    jsx: (type: string, props: Record<string, unknown> | null, ...children: Element[]) => ({ type, props: props ?? {}, children }),
    console: { info: (line: string) => { if (line.startsWith('HISTORY_TERMINAL_FOOTER ')) events.push(JSON.parse(line.slice('HISTORY_TERMINAL_FOOTER '.length))); } },
  });
  const list = root.children.find(node => node.type === 'List')!;
  const render = list.props.footer as () => Element;
  return { render: () => render().children[0]!, events };
}

it('executes the actual fixture ref/onLayout closures: detach and same-node reattach cannot rename an old event', () => {
  const { render, events } = fixture(), first = render();
  const ref = first.props.ref as (node: unknown) => void, layout = first.props.onLayout as (event: unknown) => void;
  const node = { measure: async () => ({ bounds: { size: { height: 36 } } }) };
  const event = (height: number) => ({ bounds: { size: { height } } });
  ref(node); layout(event(36));
  expect(events.at(-1)).toMatchObject({ measurement: { admitted: true }, footerHold: { measuredHeight: 36 } });
  ref(null); ref(node); layout(event(99));
  expect(events.at(-1)?.measurement.admitted).toBe(false);
  const next = render();
  (next.props.ref as typeof ref)(node); (next.props.onLayout as typeof layout)(event(37));
  expect(events.at(-1)).toMatchObject({ measurement: { admitted: true }, footerHold: { measuredHeight: 37 } });
  layout(event(100));
  expect(events.at(-1)).toMatchObject({ measurement: { admitted: false }, footerHold: { measuredHeight: 37 } });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));

it('forwards application locale, week start and date bounds to the real native component boundary', () => {
  const source = readFileSync(path.join(root, 'native-date-picker.tsx'), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  type Node = { type: string; props: Record<string, unknown>; children: unknown[] };
  const exports: Record<string, (props: Record<string, unknown>) => Node> = {};
  const context = {
    exports,
    React: { createElement: (type: string, props: Record<string, unknown>, ...children: unknown[]): Node => ({ type, props: props ?? {}, children }) },
    require(name: string) {
      if (name === 'nsh') return { nativeComponent: () => 'Calendar', platform: { os: 'ios' }, Scroll: 'Scroll', View: 'View', locale: () => 'en-US', signal: (value: unknown) => Object.assign(() => value, { set: (next: unknown) => { value = next; } }) };
      if (name === 'nsh/base') return { Button: 'Button', DatePicker: 'Fallback' };
      if (name === './native-sheet') return { NativeSheet: 'Sheet' };
      if (name === './Icon') return { Icon: 'Icon' };
      if (name === './i18n') return { language: () => 'fr', t: (key: string) => key };
      throw new Error(`Unexpected module ${name}`);
    },
  };
  vm.runInNewContext(output, context);
  const collect = (node: unknown): Node[] => node && typeof node === 'object' && 'children' in node
    ? [node as Node, ...(node as Node).children.flatMap(collect)] : [];
  const tree = exports.NativeDatePicker({ value: '2026-11-07', firstDayOfWeek: 1, disabledMatcher: { before: '2026-11-07', after: '2026-12-31' } });
  expect(collect(tree).find(node => node.type === 'Calendar')?.props).toMatchObject({ value: '2026-11-07', firstDayOfWeek: 1, minimumDate: '2026-11-07', maximumDate: '2026-12-31', localeIdentifier: 'fr' });
  expect(exports.NativeDatePicker({ range: true }).type).toBe('Fallback');
  expect(exports.NativeDatePicker({ disabledMatcher: [0, 6] }).type).toBe('Fallback');
  expect(exports.NativeDatePicker({ disabledMatcher: () => true }).type).toBe('Fallback');
});

it.skipIf(process.platform !== 'darwin')('applies zero-based weekdays, strict dates and clearable limits using Foundation', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nsh-date-picker-'));
  try {
    const main = path.join(directory, 'main.swift'), binary = path.join(directory, 'date-picker-policy');
    writeFileSync(main, `import Foundation
var configuration = NativeDatePickerConfiguration()
for day in 0...6 {
    precondition(configuration.setProp("firstDayOfWeek", day))
    precondition(configuration.calendar().firstWeekday == day + 1)
}
precondition(!configuration.setProp("firstDayOfWeek", 7))
precondition(configuration.calendar().firstWeekday == 7)
precondition(configuration.setProp("localeIdentifier", "fr_FR"))
precondition(configuration.calendar().locale?.identifier == "fr_FR")
precondition(configuration.setProp("minimumDate", "2024-02-29"))
precondition(!configuration.setProp("minimumDate", "2025-02-29"))
precondition(configuration.minimumDate == "2024-02-29")
precondition(!configuration.setProp("maximumDate", "2026-13-01"))
precondition(configuration.setProp("maximumDate", "2026-12-31"))
precondition(configuration.setProp("minimumDate", NSNull()))
precondition(configuration.setProp("maximumDate", nil))
precondition(configuration.minimumDate == nil && configuration.maximumDate == nil)
precondition(NativeDatePickerConfiguration.date("2026-1-1") == nil)
precondition(NativeDatePickerConfiguration.date("2026-11-07", timeZone: TimeZone(secondsFromGMT: 0)!) != nil)
print("Native date picker policy passed")
`);
    const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', path.join(root, 'ios/DatePicker.swift'), main, '-o', binary], { encoding: 'utf8', timeout: 60_000 });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 75_000);

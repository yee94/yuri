import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as timeCore from '../ui/src/lib/time-format-core';
import { dict as en } from '../ui/src/lib/i18n/messages/en';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(root, 'projects.tsx'), 'utf8');
const parsed = ts.createSourceFile('projects.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function productionRelative(): (timestamp: number) => string {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'relative');
  if (declaration) {
    const compiled = ts.transpileModule(`${declaration.getText(parsed)}\nresult = relative;`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
    const context = vm.createContext({ Date, Intl, result: undefined, t: (key: keyof typeof en, params: Record<string, string | number> = {}) => en[key].replace(/\{(\w+)\}/g, (whole, name: string) => String(params[name] ?? whole)) });
    vm.runInContext(compiled, context); return context.result;
  }
  const imported = parsed.statements.find(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '../ui/src/lib/time-format-core');
  expect(imported?.getText(parsed)).toContain('formatRelativeShort as relative');
  return (timeCore as typeof timeCore & { formatRelativeShort(timestamp: number): string }).formatRelativeShort;
}
afterEach(() => { vi.useRealTimers(); });
describe('production Native Projects compact activity label', () => {
  it('renders the actual old fixture timestamp as Web month/day, never a five-digit day count', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 7, 12));
    const format = productionRelative(), timestamp = 1000;
    expect(format(timestamp)).toBe(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp));
    expect(format(timestamp)).not.toMatch(/^\d{4,}d$/);
  });
  it('routes all Native session/project labels through the same import-free Web formatter', () => {
    const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'relative');
    expect(Boolean(declaration)).toBe(false); expect(productionRelative()).toBe(timeCore.formatRelativeShort);
    const sharedSource = readFileSync(path.join(root, '../ui/src/lib/time-format-core.ts'), 'utf8');
    const sharedAST = ts.createSourceFile('time-format-core.ts', sharedSource, ts.ScriptTarget.Latest, true);
    expect(sharedAST.statements.some(ts.isImportDeclaration)).toBe(false);
  });
});

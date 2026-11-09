import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test } from 'vitest';
import { planNativeComposerCommand, type NativeCommandSnapshot } from './composer-command-router';
import { editNativeReferences, insertNativeReference, type ScopedReferenceDocument } from './composer-references';
import { getSlashTokenRange, shouldSubmitCommandOnSelection } from '../ui/src/components/chat/commandSelection';
import { promoteTypedSlashChipSlots } from '../ui/src/components/chat/typedSlashChipPromotion';

const root = path.dirname(fileURLToPath(import.meta.url));
const web = ts.createSourceFile('ChatInput.tsx', readFileSync(path.join(root, '../ui/src/components/chat/ChatInput.tsx'), 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
let handler: ts.ArrowFunction | undefined;
function find(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(web) === 'handleCommandSelect' && node.initializer && ts.isCallExpression(node.initializer)) {
    const callback = node.initializer.arguments[0]; if (ts.isArrowFunction(callback)) handler = callback;
  }
  ts.forEachChild(node, find);
}
find(web);

/** Execute the real Web event handler; capture its body replacement and preset before backend dispatch. */
function selectWeb(document: ScopedReferenceDocument, name: string, submitIntent: boolean) {
  if (!handler) throw new Error('Missing actual Web command-selection handler');
  let current = document;
  const presets: string[] = [];
  const command = { name, source: 'yuri' as const, isBuiltIn: !['summary', 'explore'].includes(name) };
  const expression = ts.createPrinter().printNode(ts.EmitHint.Expression, handler, web);
  const compiled = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  const callback = vm.runInNewContext(compiled, {
    surface: {}, isChatInputCommandAllowed: () => true,
    knownSlashNames: new Set([name]), promoteTypedSlashChipSlots, getSlashTokenRange,
    getDocument: () => current, textareaRef: { current: { selectionStart: /^\/[^\s]*/.exec(document.text)![0].length } },
    replacePlainDocument: (text: string) => { current = { text, references: [], scope: current.scope }; },
    applyProgrammaticEdit: (text: string) => { current = { ...editNativeReferences(current, text), scope: current.scope }; },
    setShowCommandAutocomplete: () => {}, setCommandQuery: () => {},
    handleSubmit: (options: { presetText: string }) => { presets.push(options.presetText); },
    requestAnimationFrame: () => 0, setTimeout: () => 0,
  }) as (command: { name: string; source: 'yuri'; isBuiltIn: boolean }, submit: boolean) => void;
  callback(command, shouldSubmitCommandOnSelection(command, submitIntent));
  return { document: current, presets };
}

test.each(['new', 'undo', 'redo', 'fork', 'compact', 'model', 'timeline', 'summary', 'explore', 'init', 'btw'])('Native %s selection insertion and preset match actual Web callback for Tab/Enter with trailing text and inline refs', name => {
  for (const submit of [false, true]) {
    const scope = { host: 'host', draft: 'draft', directory: '/repo' };
    const raw: ScopedReferenceDocument = { text: '/x\nold trailing text ', references: [], scope };
    const document = { ...insertNativeReference(raw, { kind: 'file', value: 'a.ts', label: 'a.ts', scope }), scope };
    const snapshot: NativeCommandSnapshot = { owner: {}, revision: 1, document, context: { hasSession: true, hasMessages: name !== 'init', hasNewDraft: false }, inputMode: 'normal' };
    const actual = planNativeComposerCommand(snapshot, { command: { name, id: `yuri:${name}`, source: 'yuri' }, submit,
      context: { owner: snapshot.owner, scope, text: document.text, query: 'x', start: 0, end: 2, editing: true } });
    const expected = selectWeb(document, name, submit);
    expect(actual.kind).toBe('insert');
    if (actual.kind !== 'insert') throw new Error('Expected a candidate insertion');
    expect(actual.document).toEqual(expected.document);
    expect(actual.submit === undefined ? [] : [actual.submit]).toEqual(expected.presets);
  }
});

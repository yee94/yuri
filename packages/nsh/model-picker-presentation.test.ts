import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import { pickerSheetHeight } from './chat-models-helpers';
import { releaseHeightVelocity, resolveHeightSnap, sampleHeight } from '../ui/src/components/ui/heightSnapPhysics';

// Run the production controller, not UIKit. Gesture delivery is a separate device gate.
function controller() {
  const source = ts.createSourceFile('model-picker-presentation.tsx', readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'model-picker-presentation.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'createModelPickerSheet')!;
  const code = ts.transpileModule(node.getText(source).replace('export function', 'function'), { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
  let size = { height: 874 }, insets = { top: 62, bottom: 34 };
  const close = vi.fn();
  const factory = new Function('signal', 'windowSize', 'safeArea', 'pickerSheetHeight', 'releaseHeightVelocity', 'resolveHeightSnap', 'sampleHeight', `${code}; return createModelPickerSheet;`)(signal, () => size, () => insets, pickerSheetHeight, releaseHeightVelocity, resolveHeightSnap, sampleHeight);
  return { sheet: factory(close), close, rotate: () => { size = { height: 402 }; insets = { top: 0, bottom: 21 }; } };
}
test('dragging expands/collapses to the two detents, clamps overshoot, and resets on a new presentation', () => {
  const { sheet, close } = controller();
  expect(sheet.height()).toBeCloseTo(594.16);
  sheet.start(); sheet.move(-180); expect(sheet.height()).toBeCloseTo(774.16);
  sheet.move(-180, true); expect(sheet.height()).toBeCloseTo(796.44);
  sheet.start(); sheet.move(180, true); expect(sheet.height()).toBeCloseTo(594.16);
  sheet.start(); sheet.move(-900); expect(sheet.height()).toBeCloseTo(796.44);
  sheet.cancel(); expect(sheet.height()).toBeCloseTo(594.16);
  sheet.start(); sheet.move(-180, true); sheet.reset(); expect(sheet.height()).toBeCloseTo(594.16);
  expect(close).not.toHaveBeenCalled();
});
test('downward drag below collapsed dismisses, cancellation does not, and rotation re-resolves the safe-area geometry', () => {
  const { sheet, close, rotate } = controller();
  sheet.start(); sheet.move(100); sheet.cancel(); expect(close).not.toHaveBeenCalled();
  sheet.start(); sheet.move(100, true); expect(close).toHaveBeenCalledOnce();
  sheet.reset(); rotate(); expect(sheet.height()).toBeCloseTo(295.32);
  sheet.start(); sheet.move(-100, true); expect(sheet.height()).toBeCloseTo(394.38);
});
test('short flicks use the same Web snap projection and downward collapsed flick-dismiss threshold', () => {
  const { sheet, close } = controller();
  sheet.start(0); sheet.move(-20, false, 20); sheet.move(-20, true, 25);
  expect(sheet.height()).toBeCloseTo(796.44);
  sheet.reset(); sheet.start(100); sheet.move(20, false, 120); sheet.move(20, true, 125);
  expect(close).toHaveBeenCalledOnce();
});

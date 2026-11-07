import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createSettingsHelpers } from '../web/server/lib/opencode/settings-helpers.js';
import { defaultUsageSelectedModels } from '../ui/src/lib/quota/model-selection-core.js';
import { getDefaultModels } from '../ui/src/lib/quota/model-families';
import { formatSettingsResponse as vscodeSettingsResponse } from '../vscode/src/settings-visible-runtime';

const root = path.dirname(fileURLToPath(import.meta.url));
const helpers = createSettingsHelpers({ normalizePathForPersistence: (value: unknown) => value, normalizeDirectoryPath: (value: unknown) => value, sanitizeTypographySizesPartial: () => undefined, normalizeStringArray: (value: unknown) => value, sanitizeModelRefs: () => undefined, sanitizeSkillCatalogs: () => undefined, sanitizeProjects: () => undefined });

/** Actual Web store action, isolated from React/transport; no substitute default-selection algorithm. */
function webDefaultWrites(initial: Record<string, string[]>) {
  const source = readFileSync(path.join(root, '../ui/src/stores/useQuotaStore.ts'), 'utf8');
  const file = ts.createSourceFile('useQuotaStore.ts', source, ts.ScriptTarget.Latest, true);
  let action: ts.Expression | undefined;
  const visit = (node: ts.Node) => { if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'applyDefaultSelections') action = node.initializer; ts.forEachChild(node, visit); }; visit(file);
  if (!action) throw new Error('Web default-selection action was not found');
  const expression = ts.transpileModule(`(${action.getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText.trim().replace(/;$/, '');
  let state = { selectedModels: initial }; const writes: unknown[] = [];
  const invoke = new Function('get', 'set', 'getDefaultModels', 'updateDesktopSettings', 'defaultUsageSelectedModels', `return ${expression};`)(() => state, (update: (value: typeof state) => Partial<typeof state>) => { state = { ...state, ...update(state) }; }, getDefaultModels, (patch: unknown) => { writes.push(patch); }, defaultUsageSelectedModels);
  invoke('google', ['antigravity/claude-sonnet']); return writes;
}

describe('Usage owning Host/Web integration gate — main wires these existing owners', () => {
  it('actual Host write and read sanitizer preserves an explicit provider empty array', () => {
    const patch = { usageSelectedModels: { google: [], claude: ['claude-opus'] } };
    expect(helpers.sanitizeSettingsUpdate(patch)).toEqual(patch);
    expect(helpers.formatSettingsResponse(patch).usageSelectedModels).toEqual(patch.usageSelectedModels);
  });
  it('actual Web action persists nonempty defaults only for a missing provider, never explicit []', () => {
    expect(webDefaultWrites({})).toEqual([{ usageSelectedModels: { google: ['antigravity/claude-sonnet'] } }]);
    expect(webDefaultWrites({ google: [] })).toEqual([]);
  });
  it('actual VSCode visible settings already retains provider empty arrays', () => {
    expect(vscodeSettingsResponse({ usageSelectedModels: { google: [] } }, { themeVariant: 'dark', lastDirectory: '' }).usageSelectedModels).toEqual({ google: [] });
  });
});

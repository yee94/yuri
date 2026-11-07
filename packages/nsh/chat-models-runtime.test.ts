import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type Module = { imports: { path: string; original?: string; external?: boolean }[] };
function graph(entry: string): Record<string, Module> {
  const directory = mkdtempSync(path.join(tmpdir(), 'nsh-picker-dependencies-'));
  try {
    const metafile = path.join(directory, 'graph.json');
    const result = spawnSync('bun', ['build', entry, '--target=browser', '--tree-shaking=false', '--external=nsh', '--external=nsh/*', `--outdir=${directory}`, `--metafile=${metafile}`], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return JSON.parse(readFileSync(metafile, 'utf8')).inputs;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('picker helpers bundle only the native model adapter and two import-free shared pure modules', () => {
  const modules = graph('packages/nsh/chat-models-helpers.ts');
  expect(Object.keys(modules).sort()).toEqual([
    'packages/nsh/chat-models-helpers.ts',
    'packages/nsh/model.ts',
    'packages/ui/src/lib/modelDisplay.ts',
    'packages/ui/src/lib/search/modelSearch.ts',
  ]);
  for (const [file, module] of Object.entries(modules)) {
    if (file !== 'packages/nsh/chat-models-helpers.ts') expect(module.imports).toEqual([]);
    for (const dependency of module.imports) expect(dependency.original).toMatch(/^\./);
  }
});

test.each(['chat-models-fixture.tsx', 'chat-composer-selection-fixture.tsx'])('production %s dependency closure contains no React, browser runtime, desktop, relay, or alias imports', entry => {
  const modules = graph(`packages/nsh/${entry}`);
  const allowedShared = /^packages\/ui\/src\/(?:assets\/|components\/(?:icon\/sprite\.ts$|chat\/(?:mobileControlsUtils\.ts$|todo\/todoStatus\.ts$))|contexts\/theme-validation\.ts$|sync\/(?:session-fork-boundary|transcript-order)\.ts$|lib\/(?:opencode\/goal\.ts$|followUpBehavior\.ts$|(?:modelBrand|providerBrand)\.ts$|modelDisplay\.ts$|search\/(?:modelSearch|fileMentionSearch|fuzzySearch)\.ts$|composer-autocomplete\/(?:rows|icons|mention-rank)\.ts$|agent(?:Colors|AvatarPalette)\.ts$|(?:typography|fontOptions)\.ts$|touch-gestures\/tap\.ts$|theme\/(?:baseTextColors\.ts$|themes\/)|i18n\/messages\/))/;
  const pureSearchDependency = /^node_modules\/\.bun\/(?:fuzzysort|fuse\.js)@[^/]+\/node_modules\/(?:fuzzysort|fuse\.js)\//;
  const pureLeaves = new Set(['packages/ui/src/lib/slimActivityPart.ts', 'packages/ui/src/lib/projectId.ts', 'packages/ui/src/lib/draftStarters.ts', 'packages/ui/src/components/ui/heightSnapPhysics.ts']);
  for (const [file, module] of Object.entries(modules)) {
    expect(file.startsWith('packages/nsh/') || allowedShared.test(file) || pureLeaves.has(file) || pureSearchDependency.test(file), `Non-native runtime dependency: ${file}`).toBe(true);
    if (pureLeaves.has(file)) expect(module.imports).toEqual([]);
    if (file === 'packages/ui/src/lib/opencode/goal.ts' || file === 'packages/ui/src/lib/followUpBehavior.ts' || file === 'packages/ui/src/components/chat/todo/todoStatus.ts') expect(module.imports).toEqual([]);
    for (const dependency of module.imports) {
      expect(dependency.original?.startsWith('@'), `Unresolved alias in ${file}: ${dependency.original}`).not.toBe(true);
      if (dependency.external) expect(dependency.path, `Unsupported external runtime in ${file}`).toMatch(/^nsh(?:\/|$)/);
    }
  }
});

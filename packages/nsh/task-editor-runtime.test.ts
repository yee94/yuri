import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type Module = { imports: { path: string; original?: string; external?: boolean }[] };

test.each(['task-editor-prompt-core.ts', 'task-editor-native.fixture.tsx'])('%s bundles without Web aliases or unsupported runtime externals', entry => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nsh-task-editor-dependencies-'));
  try {
    const metafile = path.join(directory, 'graph.json');
    const result = spawnSync('bun', ['build', `packages/nsh/${entry}`, '--target=browser', '--external=nsh', '--external=nsh/*', `--outdir=${directory}`, `--metafile=${metafile}`], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const graph = JSON.parse(readFileSync(metafile, 'utf8')) as { inputs: Record<string, Module>; outputs: Record<string, Module> };
    const aliases: string[] = [], unsupported: string[] = [];
    for (const [file, module] of Object.entries({ ...graph.inputs, ...graph.outputs })) {
      for (const dependency of module.imports) {
        if (dependency.original?.startsWith('@/') || dependency.path.startsWith('@/')) aliases.push(`${file}: ${dependency.original ?? dependency.path}`);
        if (dependency.external && !/^nsh(?:\/|$)/.test(dependency.path)) unsupported.push(`${file}: ${dependency.path}`);
      }
    }
    expect(aliases, 'Native consumers cannot resolve Web @/ aliases').toEqual([]);
    expect(unsupported, 'Only NSH runtime modules may remain external').toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { expect, test } from 'vitest';
import { agentAvatarDataUri } from '../ui/src/lib/agentAvatarDataUri';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the actual Native artwork bundle imports and renders with no structuredClone or browser globals (VM, not QuickJS)', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nsh-agent-neutral-'));
  try {
    const outfile = path.join(directory, 'identity.cjs');
    const metafile = path.join(directory, 'graph.json');
    const build = spawnSync('bun', ['build', 'packages/nsh/chat-identity-core.ts', '--target=browser', '--format=cjs', `--outfile=${outfile}`, `--metafile=${metafile}`], { cwd: root, encoding: 'utf8' });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const graph = JSON.parse(readFileSync(metafile, 'utf8')) as { inputs: Record<string, { imports: { external?: boolean; path: string }[] }> };
    expect(Object.keys(graph.inputs).sort()).toEqual([
      'packages/nsh/agent-avatar-runtime.generated.js', 'packages/nsh/agent-avatar-templates.ts',
      'packages/nsh/chat-identity-core.ts', 'packages/ui/src/lib/agentAvatarPalette.ts', 'packages/ui/src/lib/agentColors.ts',
    ]);
    for (const module of Object.values(graph.inputs)) expect(module.imports.filter(dependency => dependency.external)).toEqual([]);
    let encodes = 0, oversized = false;
    const context = vm.createContext({ module: { exports: {} }, window: undefined, document: undefined, URL: undefined, Buffer: undefined,
      encodeURIComponent: (value: string) => { encodes++; return oversized ? 'x'.repeat(600_000) : encodeURIComponent(value); },
    });
    expect(vm.runInContext('typeof structuredClone', context)).toBe('undefined');
    vm.runInContext('Object.defineProperty(globalThis, "structuredClone", { get: () => { throw new Error("Native artwork must not read global structuredClone"); }, set: () => { throw new Error("Native artwork must not install a global structuredClone shim"); } });', context);
    vm.runInContext(readFileSync(outfile, 'utf8'), context);
    const render = vm.runInContext('module.exports.nativeAgentAvatarDataUri', context) as typeof import('./chat-identity-core').nativeAgentAvatarDataUri;
    for (const seed of [undefined, '', 'custom-agent', '__proto__', 'constructor', '中文机器人', '🍵', 'name" onload="bad', ...Array.from({ length: 200 }, (_, index) => `vm-child-${index}`)]) {
      expect(render(seed, {}), seed).toBe(agentAvatarDataUri(seed));
    }
    expect(render('vm-child-1', {})).not.toBe(render('vm-child-2', {}));
    oversized = true;
    const before = encodes;
    expect(render('vm-byte-budget', {})).toBe(render('vm-byte-budget', {}));
    expect(encodes - before, 'The real compiled LRU must not retain an oversized URI').toBe(2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the generated renderer is reproducible from the shared source and pinned adapter with no externals', () => {
  const result = spawnSync('bun', ['packages/nsh/scripts/generate-agent-artwork.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const metadata = JSON.parse(readFileSync(path.join(root, 'packages/nsh/agent-avatar-runtime.generated.meta.json'), 'utf8'));
  expect(metadata).toMatchObject({ coreVersion: '10.7.0', stylesVersion: '10.6.0', externalImports: [],
    adaptedCloneSites: { 'Avatar.js': 1, 'Options.js': 1, 'Style.js': 3 } });
  expect(Object.keys(metadata.inputs)).toContain('packages/ui/src/lib/agentAvatarDataUri.ts');
  expect(Object.keys(metadata.inputs)).toContain('packages/ui/src/lib/dualLimitLru.ts');
});

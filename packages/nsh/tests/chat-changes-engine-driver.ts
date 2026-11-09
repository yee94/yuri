import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Files live under the real NSH project so open() can discover its nsh.json ancestor. */
export function prepareChangesEngineDriver(packageDirectory: string, entry: string, steps: string[], options: { title?: string; ios?: boolean; capture?: boolean } = {}) {
  const directory = mkdtempSync(path.join(packageDirectory, 'tests', '.changes-engine-'));
  const testFile = path.join(directory, 'changes-engine.test.tsx');
  const title = options.title ?? entry;
  writeFileSync(testFile, [
    'import { expect, open, test } from "nsh/test";',
    `test(${JSON.stringify(title)}, async () => {`,
    `const app = await open(${JSON.stringify(path.join(packageDirectory, entry))}, { platform: ${JSON.stringify(options.ios ? 'ios' : 'macos')}, storage: {}, network: {} });`,
    `const capture = ${options.capture === true};`,
    `const frames = ${JSON.stringify(path.resolve(packageDirectory, '../../.scratch/nsh/chat-frames'))};`,
    'let step = 0;',
    'try {',
    'await app.wait(1200);',
    ...steps.flatMap((source, index) => [`step = ${index + 1};`, source]),
    `} catch (cause) { throw new Error(${JSON.stringify(title + ' step ')} + step + ': ' + String(cause)); }`,
    'finally { app.dispose(); }',
    '});',
  ].join('\n'));
  return { directory, testFile,
    bundleHost(entry: string) {
      const fixture = path.join(directory, 'host.js');
      const result = spawnSync('bun', ['build', path.resolve(packageDirectory, entry), '--target=browser', '--outfile', fixture], { cwd: packageDirectory, encoding: 'utf8' });
      if (result.error || result.status !== 0) throw new Error(`Fixture host bundle failed: ${String(result.error ?? '')}\n${result.stdout}\n${result.stderr}`);
      return fixture;
    },
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

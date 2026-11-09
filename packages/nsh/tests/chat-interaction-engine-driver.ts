import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** These three interaction suites own their runner and bundled bridge, inside the NSH root. */
export function prepareInteractionEngineDriver(packageDirectory: string, entry: string, host: string, steps: string[], options: Record<string, unknown> = {}) {
  const directory = mkdtempSync(path.join(packageDirectory, 'tests', '.interaction-engine-'));
  const testFile = path.join(directory, 'interaction-engine.test.tsx');
  const hostEntry = path.join(directory, 'host-entry.js'), hostFile = path.join(directory, 'host.js');
  writeFileSync(hostEntry, `import { createHost as fixture } from ${JSON.stringify(path.resolve(packageDirectory, host))};\nexport const createHost = () => fixture(${JSON.stringify(options)});\n`);
  writeFileSync(testFile, [
    'import { expect, open, test } from "nsh/test";',
    `test(${JSON.stringify(entry)}, async () => {`,
    `const app = await open(${JSON.stringify(path.resolve(packageDirectory, entry))}, { platform: "macos", storage: {}, network: {} });`,
    'let step = 0;', 'try {', 'await app.wait(1200);',
    ...steps.flatMap((source, index) => [`step = ${index + 1};`, source]),
    `} catch (cause) { throw new Error(${JSON.stringify(entry + ' step ')} + step + ': ' + String(cause)); }`,
    'finally { app.dispose(); }', '});',
  ].join('\n'));
  return { directory, testFile, hostFile,
    bundleHost() {
      const result = spawnSync('bun', ['build', hostEntry, '--target=browser', '--outfile', hostFile], { cwd: packageDirectory, encoding: 'utf8' });
      if (result.error || result.status !== 0) throw new Error(`Interaction fixture bundle failed: ${String(result.error ?? '')}\n${result.stdout}\n${result.stderr}`);
      return hostFile;
    },
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

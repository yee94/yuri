import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export function prepareContextUsageFixture(root, directory) {
  const host = path.join(directory, 'host.js');
  writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Context overview fixture', id: 'example.yuri.context.' + path.basename(directory).replace(/[^a-z0-9]/gi, '').toLowerCase(), version: '0.1.0', build: 1, appearance: 'dark', theme: path.join(root, 'theme.json'), capabilities: { clipboard: true, host: ['contextUsage.fixture.snapshot', 'contextUsage.fixture.empty'] } }));
  writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'context-usage-fixture.tsx'))};\n`);
  const result = spawnSync('bun', ['build', path.join(root, 'tests/context-usage-host.ts'), '--target=browser', '--format=esm', '--outfile', host], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  return { entry: 'App.tsx', host, directory };
}

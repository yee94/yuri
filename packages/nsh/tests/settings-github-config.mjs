import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function prepareGitHubFixture(root, directory) {
  // NSH defaults all other capabilities to deny. Do not grant actual openUrl/network access.
  writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'GitHub synthetic fixture', id: 'example.yuri.github-fixture', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request', 'github.fixture.scenario', 'github.fixture.scope', 'github.fixture.audit', 'github.fixture.open'] } }));
  writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'settings-github-fixture.tsx'))};\n`);
  const host = path.join(directory, 'host.js');
  const bundled = spawnSync('bun', ['build', path.join(root, 'tests/settings-github-host.js'), '--target=browser', '--outfile', host], { encoding: 'utf8' });
  if (bundled.error || bundled.status !== 0) throw new Error(bundled.error?.message ?? bundled.stdout + bundled.stderr);
  return { entry: 'App.tsx', host };
}

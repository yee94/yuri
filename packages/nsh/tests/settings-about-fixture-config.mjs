import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function prepareAboutFixture(root, directory) {
  writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({
    name: 'About synthetic fixture', id: 'example.yuri.about-fixture', version: '0.1.0', build: 1,
    theme: path.join(root, 'theme.json'),
    capabilities: { host: ['connection.list', 'runtime.request', 'native.clientMetadata', 'native.diagnostics.status', 'native.diagnostics.setEnabled', 'native.diagnostics.export', 'native.diagnostics.append', 'about.fixture.scenario', 'about.fixture.scope', 'about.fixture.audit'] },
  }));
  writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'settings-about-fixture.tsx'))};\n`);
  const host = path.join(directory, 'host.js');
  const bundled = spawnSync('bun', ['build', path.join(root, 'tests/settings-about-host.js'), '--target=browser', '--outfile', host], { encoding: 'utf8' });
  if (bundled.error || bundled.status !== 0) throw new Error(bundled.error?.message ?? bundled.stdout + bundled.stderr);
  return { entry: 'App.tsx', host };
}

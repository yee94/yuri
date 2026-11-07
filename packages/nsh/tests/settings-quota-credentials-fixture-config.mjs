import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function prepareQuotaCredentialsFixture(root, directory) {
  const host = path.join(directory, 'host.js');
  const bundle = spawnSync('bun', ['build', path.join(root, 'tests/settings-quota-credentials-host.js'), '--target=browser', '--format=esm', '--outfile', host], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
  if (bundle.error) throw bundle.error;
  if (bundle.status !== 0) throw new Error(bundle.stdout + bundle.stderr);
  writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({
    name: 'Usage credentials synthetic fixture', id: 'example.yuri.quota-fixture', version: '0.1.0', build: 1,
    theme: path.join(root, 'theme.json'),
    capabilities: { host: ['runtime.request', 'quota.fixture.scenario', 'quota.fixture.audit'] },
  }));
  writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'settings-quota-credentials-fixture.tsx'))};\n`);
  return { entry: 'App.tsx', host };
}

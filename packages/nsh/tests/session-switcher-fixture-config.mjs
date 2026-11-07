import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** The caller owns one unique temporary directory; no production config/artifact is changed. */
export function prepareSessionSwitcherFixture(root, directory) {
  const host = path.join(directory, 'host.js');
  writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({
    name: 'Session switcher synthetic fixture', id: 'example.yuri.switcher.' + path.basename(directory).replace(/[^a-z0-9]/gi, '').toLowerCase(), version: '0.1.0', build: 1,
    theme: path.join(root, 'theme.json'), capabilities: { host: ['runtime.request', 'runtime.stream', 'runtime.stop', 'sessionSwitcher.fixture.audit', 'sessionSwitcher.fixture.scenario'] },
  }));
  writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'session-switcher-fixture.tsx'))};\n`);
  const built = spawnSync('bun', ['build', path.join(root, 'tests/session-switcher-host.js'), '--target=browser', '--format=esm', '--outfile', host], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
  if (built.error) throw built.error;
  if (built.status !== 0) throw new Error(built.stdout + built.stderr);
  return { entry: 'App.tsx', host, directory };
}

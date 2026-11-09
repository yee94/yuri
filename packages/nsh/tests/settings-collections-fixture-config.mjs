import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** Runner-side configuration only; never loaded by NSH's web Host or production. */
export function prepareCollectionsFixture(root, directory) {
  writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({
    name: 'Settings collections fixture', id: 'example.yuri.settings-collections', version: '0.1.0', build: 1,
    theme: path.join(root, 'theme.json'),
    capabilities: { clipboard: true, host: ['connection.list', 'runtime.request', 'collections.fixture.audit'] },
  }));
  writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'settings-collections-fixture.tsx'))};\n`);
  return { entry: 'App.tsx', host: path.join(root, 'tests/settings-collections-host.js') };
}

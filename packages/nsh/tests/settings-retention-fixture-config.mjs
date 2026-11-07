import { writeFileSync } from 'node:fs';
import path from 'node:path';

export function prepareRetentionFixture(root, directory) {
  writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({
    name: 'Retention synthetic fixture', id: 'example.yuri.retention-fixture', version: '0.1.0', build: 1,
    theme: path.join(root, 'theme.json'),
    capabilities: { host: ['runtime.request', 'retention.fixture.scenario', 'retention.fixture.audit', 'retention.fixture.storage'] },
  }));
  writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'settings-retention-fixture.tsx'))};\n`);
  return { entry: 'App.tsx', host: path.join(root, 'tests/settings-retention-host.js') };
}

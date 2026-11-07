import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** Only called by the explicitly enabled future engine test; no build or engine runs at import. */
export function prepareSettingsUsageFixture(root, directory) {
  writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Usage fixture', id: 'example.yuri.usagefixture', version: '0.1.0', build: 1, appearance: 'dark', theme: path.join(root, 'theme.json') }));
  writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'settings-usage-fixture.tsx'))};\n`);
  return { entry: 'App.tsx', directory };
}

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Stage an isolated headless App; no engine or process is started here. */
export function prepareNewSessionNativeFixture(directory: string, temporary: string, entry: string, steps: readonly string[]) {
  const app = path.join(temporary, 'App.tsx'), test = path.join(temporary, 'new-session-engine.test.tsx');
  const config = JSON.parse(readFileSync(path.join(directory, 'nsh.json'), 'utf8'));
  config.theme = path.resolve(directory, config.theme);
  writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify(config));
  writeFileSync(app, `import ${JSON.stringify(path.resolve(directory, entry))};\n`);
  writeFileSync(test, [
    'import { expect, open, test } from "nsh/test";',
    'test("new-session on the isolated non-iOS headless surface", async () => {',
    `const app = await open(${JSON.stringify(app)}, { platform: 'macos', storage: {}, network: {} });`,
    'try {', ...steps, '} finally { app.dispose(); }', '});',
  ].join('\n'));
  return { test, host: path.join(temporary, 'host.js') };
}

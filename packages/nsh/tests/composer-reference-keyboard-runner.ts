import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prepareInteractionEngineDriver } from './chat-interaction-engine-driver';

/** Keyboard-only App/config; the shared interaction driver owns platform and Host bundling. */
export function prepareReferenceKeyboardDriver(root: string, steps: string[]) {
  const fixtureDirectory = mkdtempSync(path.join(root, 'tests', '.reference-keyboard-'));
  try {
    writeFileSync(path.join(fixtureDirectory, 'nsh.json'), JSON.stringify({
      name: 'Reference keyboard fixture', id: 'example.yuri.reference-keyboard.' + path.basename(fixtureDirectory).replace(/[^a-z0-9]/gi, '').toLowerCase(), version: '0.1.0', build: 1,
      theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request', 'runtime.stream', 'runtime.stop', 'referenceKeyboard.fixture.audit'] },
    }));
    writeFileSync(path.join(fixtureDirectory, 'tsconfig.json'), JSON.stringify({ extends: path.join(root, 'tsconfig.json'), include: ['*.ts', '*.tsx'] }));
    const app = path.join(fixtureDirectory, 'App.tsx');
    writeFileSync(app, `import ${JSON.stringify(path.join(root, 'composer-reference-keyboard-fixture.tsx'))};\n`);
    const driver = prepareInteractionEngineDriver(root, app, 'tests/composer-reference-keyboard-host.js', [
      'await app.waitFor("text:ready");', 'await app.paste("id:keyboard-composer", {text:""});', ...steps,
      'await app.press("id:reference-keyboard-audit");',
      'await app.waitFor("text:keyboard-audit:0:0");',
      'expect(app.texts()).toContain("keyboard-audit:0:0");',
    ]);
    return { ...driver, fixtureDirectory, dispose() { driver.dispose(); rmSync(fixtureDirectory, { recursive: true, force: true }); } };
  } catch (error) { rmSync(fixtureDirectory, { recursive: true, force: true }); throw error; }
}

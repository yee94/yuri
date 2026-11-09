import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepareNewSessionNativeFixture } from './tests/new-session-native-runner';
import { newSessionUIEntry, newSessionUIScenarios } from './new-session-ui-steps';

const directory = path.dirname(fileURLToPath(import.meta.url));
describe('new-session headless fixture preparation without starting an engine', () => {
  it.each([newSessionUIEntry, 'new-session-production.fixture.tsx'])('stages %s with exact capabilities, absolute theme, isolated Storage and explicit non-iOS Sheet runtime', entry => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'new-session-runner-contract-'));
    try {
      const originalConfig = readFileSync(path.join(directory, 'nsh.json'), 'utf8');
      const steps = [...newSessionUIScenarios.modelAgentVariant, ...newSessionUIScenarios.unknownCreateRecovery];
      const prepared = prepareNewSessionNativeFixture(directory, temporary, entry, steps);
      const sourceConfig = JSON.parse(originalConfig);
      expect(JSON.parse(readFileSync(path.join(temporary, 'nsh.json'), 'utf8'))).toEqual({ ...sourceConfig, theme: path.resolve(directory, sourceConfig.theme) });
      expect(readFileSync(path.join(temporary, 'App.tsx'), 'utf8')).toBe(`import ${JSON.stringify(path.resolve(directory, entry))};\n`);
      const script = readFileSync(prepared.test, 'utf8');
      expect(script).toContain("platform: 'macos', storage: {}, network: {}");
      expect(script).toContain(steps.join('\n'));
      expect(script).toContain('finally { app.dispose(); }');
      expect(prepared.host).toBe(path.join(temporary, 'host.js'));
      expect(readFileSync(path.join(directory, 'nsh.json'), 'utf8')).toBe(originalConfig);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
  it('owned production-pages fixture does not mount a production startup root and retains real preference/Host readiness', () => {
    const source = readFileSync(path.join(directory, 'new-session-production.fixture.tsx'), 'utf8');
    expect(source).toContain("import { ProjectsHome } from './projects'");
    expect(source).toContain("import { NativeNewSessionPage } from './new-session-page'");
    expect(source).not.toMatch(/import[^\n]+(?:application|native-startup)/);
    expect(source).toContain('Promise.all([loadConnections(), deviceChatPreferenceStore.load()]).then(refresh)');
    expect(source).toContain('deviceChatPreferences={deviceChatPreferences}');
    expect(source).toContain('<NativeAppearanceSync />');
    const runner = readFileSync(path.join(directory, 'new-session-native.test.ts'), 'utf8');
    expect(runner).toContain("['build', hostSource, '--target=browser', '--outfile', host]");
    expect(runner).toContain('timeout: 60_000'); expect(runner).toContain('95_000');
    expect(runner).toContain('Production Projects draft survives Back');
    expect(runner).toContain('audit:2 writes:0 creates:0 prompts:0');
  });
});

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it } from 'vitest';
import { withProjectsNativeFixture } from './tests/projects-native-runner.js';

it('production root and Projects keep partial rows usable, retry persistent failure and adopt explicit healthy empty recovery', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  withProjectsNativeFixture(directory, 'catalog', (fixture: { directory: string; entry: string; host: string }) => {
    const steps = [
      'await app.waitFor("id:projects-catalog-retry");',
      'await app.waitFor("text:Saved failed row retained");',
      'expect(app.shows("text:Catalog incomplete")).toBe(true);',
      'expect(app.shows("text:Root usable")).toBe(true);',
      'expect(app.shows("text:Host reachable")).toBe(true);',
      'await app.press("id:project-session-good-session");',
      'await app.waitFor("text:Opened good-session");',
      'await app.press("id:projects-catalog-retry");',
      'await app.waitFor("text:Catalog idle");',
      'expect(app.shows("text:Saved failed row retained")).toBe(true);',
      'expect(app.shows("text:Catalog incomplete")).toBe(true);',
      'await app.press("id:fixture-recover-directory");',
      'await app.waitFor("text:Catalog confirmed");',
      'await app.waitFor("text:Failed directory confirmed empty");',
      'await app.waitFor("id:project-session-failed-seed", { state: "gone" });',
      'await app.waitFor("id:projects-catalog-retry", { state: "gone" });',
      'expect(app.shows("text:Root usable")).toBe(true);',
      'expect(app.shows("id:project-session-good-session")).toBe(true);',
    ].join('\n');
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: fixture.directory, input: steps, encoding: 'utf8', timeout: 45000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}, 60000);

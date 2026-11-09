import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { withProjectsNativeFixture } from './tests/projects-native-runner.js';
import { readFileSync, writeFileSync } from 'node:fs';

// Mount frames come from the real NSH layout engine; headless has no UIKit drawing.
test.each([50, 100, 105, 200])('Projects native layout preserves symmetric insets and rotation at %i%% density', padding => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  for (const [width, height, left, right] of [[402, 874, 0, 0], [874, 402, 47, 21], [1024, 1366, 0, 0]]) {
    withProjectsNativeFixture(root, 'home', (fixture: { directory: string; entry: string; host: string }) => {
      const source = readFileSync(path.join(root, 'projects-native.fixture.tsx'), 'utf8')
        .replace(/from '(\.\/[^']+)'/g, (_, specifier: string) => `from ${JSON.stringify(path.resolve(root, specifier))}`)
        .replace('mount(ProjectsFixture);', `
const ready = signal(false);
void appearanceFromSettings({ padding: ${padding} }, async () => ({ themes: [] })).then(value => {
  nativeAppearance.current.set({ ...value, uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [] }); ready.set(true);
});
mount(() => <View class="flex-1" style={{ paddingLeft: ${left}, paddingRight: ${right} }}><If when={ready()}><ProjectsFixture /></If></View>);`);
      writeFileSync(path.join(fixture.directory, fixture.entry), `import { nativeAppearance } from ${JSON.stringify(path.join(root, 'appearance'))};\nimport { appearanceFromSettings } from ${JSON.stringify(path.join(root, 'appearance-core'))};\n${source}`);
      const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host, '--trace'], { cwd: fixture.directory, encoding: 'utf8', timeout: 45000, input: `await app.waitFor("id:projects-menu-p"); await app.setViewport(${width}, ${height});` });
      expect(result.error, result.stdout + result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const frames = new Map<number, { x: number; width: number }>(), parents = new Map<number, number>(), ids = new Map<string, number>();
      for (const line of (result.stdout + result.stderr).split('\n')) {
        const insert = /Insert \{ parent: (\d+), child: (\d+)/.exec(line);
        if (insert) parents.set(Number(insert[2]), Number(insert[1]));
        const identity = /ViewProps \{ id: (\d+),.*test_id: Some\("([^"]+)"\)/.exec(line);
        if (identity) ids.set(identity[2], Number(identity[1]));
        const frame = /Frame \{ id: (\d+), x: (-?[\d.]+), y: -?[\d.]+, w: ([\d.]+)/.exec(line);
        if (frame) frames.set(Number(frame[1]), { x: Number(frame[2]), width: Number(frame[3]) });
      }
      const bounds = (key: string) => {
        let id = ids.get(key)!; expect(id, key).toBeDefined();
        const frame = frames.get(id)!; expect(frame, key).toBeDefined();
        let x = 0; const seen = new Set<number>();
        while (!seen.has(id)) { seen.add(id); x += frames.get(id)?.x ?? 0; const parent = parents.get(id); if (parent === undefined) break; id = parent; }
        return { x, width: frame.width };
      };
      const card = bounds('projects-card-p'), scroll = bounds('projects-home-scroll'), add = bounds('projects-open-menu');
      const shell = Math.min(452, width - left - right), inset = left + (width - left - right - shell) / 2 + 18;
      expect(scroll.width).toBe(width - left - right);
      expect(card.x).toBeCloseTo(inset, 1);
      expect(card.width).toBeCloseTo(shell - 36, 1);
      expect(add.x + add.width).toBeCloseTo(card.x + card.width - 4 * Math.sqrt(padding / 100), 0);
      const menu = bounds('projects-menu-p'), toggle = bounds('projects-toggle-p');
      expect(menu.x + menu.width).toBeCloseTo(card.x + card.width - 4 * Math.sqrt(padding / 100), 0);
      expect(toggle.x).toBeCloseTo(card.x, 1);
      expect(toggle.x + toggle.width).toBeCloseTo(menu.x, 1);
    });
  }
}, 180000);

test('projects render through the native engine and open a real session target', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const script = [
    'await app.waitFor("text:Native projects fixture");',
    'await app.waitFor("text:Native projects conversation");',
    'await app.waitFor("text:native-first-branch");',
    'await app.waitFor("text:native-second-branch");',
    'expect(app.texts().indexOf("native-second-branch")).toBeLessThan(app.texts().indexOf("native-first-branch"));',
    'expect(app.texts().join("\\n")).not.toMatch(/Invalid active snapshot|Unexpected projects request/);',
    'const before = app.texts().filter(text => text === "Native projects conversation").length;',
    'await app.press("id:project-session-projects_session >> nth=0");',
    'expect(app.texts().filter(text => text === "Native projects conversation").length).toBeGreaterThan(before);',
  ].join('\n');
  withProjectsNativeFixture(directory, 'home', (fixture: { directory: string; entry: string; host: string }) => {
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: fixture.directory, input: script, encoding: 'utf8', timeout: 45000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}, 60000);

test('production Projects retains expanded paging through collapse/remount and hidden tabs', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  withProjectsNativeFixture(directory, 'home', (fixture: { directory: string; entry: string; host: string }) => {
    const script = [
      'await app.waitFor("id:projects-more-/repo");',
      'expect(app.shows("id:project-session-fixture_extra_3")).toBe(false);',
      'await app.press("id:projects-more-/repo");',
      'await app.waitFor("id:project-session-fixture_extra_3");',
      'await app.press("id:projects-toggle-p");',
      'await app.waitFor("id:project-session-fixture_extra_3", { state: "gone" });',
      'await app.press("id:fixture-projects-tab"); await app.press("id:fixture-projects-tab");',
      'expect(app.shows("id:project-session-fixture_extra_3")).toBe(false);',
      'await app.press("id:projects-toggle-p");',
      'await app.waitFor("id:project-session-fixture_extra_3");',
      'await app.press("id:projects-fewer-/repo");',
      'await app.waitFor("id:project-session-fixture_extra_3", { state: "gone" });',
      'expect(app.shows("id:projects-more-/repo")).toBe(true);',
      'await app.press("id:project-worktree-/repo/first");',
      'await app.waitFor("id:project-session-tree_0");',
      'await app.press("id:fixture-projects-audit"); await app.waitFor("text:directory reads:1");',
      'await app.press("id:project-worktree-/repo/first"); await app.press("id:project-worktree-/repo/first");',
      'await app.waitFor("id:project-session-tree_0");',
      'await app.press("id:fixture-projects-audit"); await app.waitFor("text:directory reads:1");',
      'await app.press("id:projects-more-/repo/first");',
      'await app.press("id:fixture-projects-audit"); await app.waitFor("text:directory reads:2");',
    ].join('\n');
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: fixture.directory, input: script, encoding: 'utf8', timeout: 45000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}, 60000);

test('actual Home keeps the Projects surface mounted while retaining its explicit active fence', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(directory, 'application.tsx'), 'utf8');
  expect(source).toContain('<View class="flex-1 flex-col" style={{ display: app.tab() === 0 ? \'flex\' : \'none\' }}>');
  expect(source).not.toContain('<If when={app.tab() === 0}>');
  expect(source).toContain('active={nav.routes().length === 1 && app.tab() === 0}');
});

test('production project menu shares Web labels and icon order and preserves extra destinations', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  withProjectsNativeFixture(directory, 'home', (fixture: { directory: string; entry: string; host: string }) => {
    const steps = [
      'await app.waitFor("id:projects-menu-p");',
      'await app.press("id:projects-menu-p");',
      'await app.waitFor("id:projects-option-newWorktree");',
      'const labels = ["New Session", "New worktree", "Sync sessions", "Edit", "Close project", "Worktrees", "Files", "Changes"];',
      'const texts = app.texts(); for (let i = 1; i < labels.length; i++) expect(texts.indexOf(labels[i])).toBeGreaterThan(texts.indexOf(labels[i-1]));',
      'for (const icon of ["add", "node-tree", "refresh", "pencil-ai", "close", "folder", "git-branch"]) expect(app.shows(`id:projects-option-icon-${icon} >> nth=0`)).toBe(true);',
      'expect(app.shows("id:projects-action-options-close")).toBe(true);',
    ].join('\n');
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: fixture.directory, input: steps, encoding: 'utf8', timeout: 45000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}, 60000);

function outerTest(steps: string[]) {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  withProjectsNativeFixture(directory, 'outer', (fixture: { directory: string; entry: string; host: string }) => {
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: fixture.directory, input: steps.join('\n'), encoding: 'utf8', timeout: 45000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}

test('native project clone keeps input after registry conflict and retry does not clone twice', () => {
  outerTest([
    'await app.press("id:fixture-directory");',
    'await app.waitFor("id:projects-directory-path");',
    'await app.clear("id:projects-directory-path");',
    'await app.type("id:projects-directory-path", "/workspace/new-repo");',
    'expect(app.value("id:projects-directory-path")).toBe("/workspace/new-repo");',
    'await app.press("id:projects-directory-mode-toggle");',
    'await app.waitFor("id:projects-clone-url");',
    'await app.type("id:projects-clone-url", "https://repo.example/team/repo");',
    'const input = app.value("id:projects-clone-url");',
    'await app.press("id:projects-directory-submit");',
    'await app.waitFor("text:Error: HTTP 409: Fixture registry conflict");',
    'expect(app.value("id:projects-clone-url")).toBe(input);',
    'await app.press("id:projects-directory-submit");',
    'await app.waitFor("text:Draft: /workspace/new-repo");',
    'await app.back();',
    'await app.waitFor("id:fixture-directory");',
  ]);
}, 60000);

test('native global search isolates content failure, retries and forwards the exact message anchor', () => {
  outerTest([
    'await app.press("id:fixture-search");',
    'await app.waitFor("id:projects-global-search");',
    'await app.type("id:projects-global-search", "Native");',
    'await app.waitFor("text:Message search could not load. Other results are still shown.");',
    'expect(app.texts().includes("Native global title hit")).toBe(true);',
    'expect(app.texts().includes("src/native.ts")).toBe(true);',
    'await app.press("id:projects-search-retry");',
    'await app.waitFor("text:Native body match");',
    'await app.press("id:projects-search-message:fixture-session:fixture-message");',
    'await app.waitFor("text:fixture-session:fixture-message");',
    'await app.back();',
    'await app.back();',
    'await app.waitFor("id:fixture-search");',
  ]);
}, 60000);

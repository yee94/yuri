import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { UI_FONT_OPTIONS, CODE_FONT_OPTIONS } from '../ui/src/lib/fontOptions';

const root = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, binary: string;
beforeAll(() => {
  temporary = mkdtempSync(path.join(tmpdir(), 'nsh-native-font-owner-')); binary = path.join(temporary, 'check');
  const result = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library',
    ...['NativeFontCatalog', 'NativeFontRegistry', 'NativeFontOwner'].map(name => path.join(root, 'ios', name + '.swift')),
    path.join(root, 'tests/native-fonts/owner-check.swift'), '-o', binary], { encoding: 'utf8', timeout: 60_000 });
  expect(result.status, result.stderr).toBe(0);
}, 90_000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
function run(...args: string[]) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 60_000 });
  expect(result.status, result.stderr + result.stdout).toBe(0); return result.stdout.trim();
}
test('Swift fixed catalog covers every Web UI/mono source, same weights and exact pinned Fontsource Latin/normal paths', () => {
  const catalog = JSON.parse(run('catalog')) as Array<{ id: string; family: string; version: string; kind: string; faces: Array<{ weight: number; sha256: string; bytes: number; url: string }> }>;
  expect(catalog).toHaveLength(16);
  for (const [kind, options] of [['ui', UI_FONT_OPTIONS], ['mono', CODE_FONT_OPTIONS]] as const) {
    for (const option of options.filter(option => option.source)) {
      const row = catalog.find(row => row.id === option.id)!;
      expect(row).toMatchObject({ family: option.source!.family, kind });
      expect(row.faces.map(face => face.weight)).toEqual(option.source!.weights);
      for (const face of row.faces) {
        expect(face.url).toBe(`https://cdn.jsdelivr.net/npm/${option.source!.packageName}@${row.version}/files/${option.source!.filePrefix}-latin-${face.weight}-normal.woff2`);
        expect(face.sha256).toMatch(/^[a-f0-9]{64}$/); expect(face.bytes).toBeLessThanOrEqual(1_048_576);
      }
    }
  }
  expect(catalog.flatMap(row => row.faces)).toHaveLength(47);
  const source = readFileSync(path.join(root, 'ios/NativeFontRegistry.swift'), 'utf8');
  expect(source).not.toContain('UIFont.familyNames');
});
test('production Swift owner fences deferred Host/revision completions, retains prior on failure and avoids default/no-op reads', () => {
  expect(run('owner')).toBe('owner-system-noop-unknown-partial-failure-retry-host-revision-late-ok');
});
test('malformed bytes never register/cache as success and repeated failures release the two-reader budget', () => {
  expect(run('malformed')).toBe('malformed-retry-budget-released');
});
test('three simultaneous sources have at most two active readers, including across failures', () => {
  expect(run('budget')).toBe('two-readers-across-three-selected-sources');
});
const fixtures = process.env.NSH_FONT_FIXTURE_DIRECTORY;
test.skipIf(!fixtures)('all 47 original Web WOFF2 faces register through production registry, descriptor family/PSName read back and duplicate loads coalesce (macOS)', () => {
  expect(run('register', fixtures!)).toBe('registered-faces-47-exact-source-no-duplicate-reads');
});
test.skipIf(!fixtures)('same PSName/family pre-registration is rejected rather than accepted as source identity', () => {
  expect(run('collision', fixtures!)).toBe('collision-rejected');
});
test.skipIf(!fixtures)('a later face collision rolls back earlier process registrations and does not cache partial success', () => {
  expect(run('collision-late', fixtures!)).toBe('collision-rejected');
});
test.skipIf(!fixtures)('a later external same-name registration cannot borrow a previously valid source cache entry', () => {
  expect(run('cache-replaced', fixtures!)).toBe('replaced-registration-invalidates-source-cache');
});
test.skipIf(!fixtures)('only checksum-verified bundled JetBrains Mono 2.304 overlaps are replaced by Web 2.211 in this process', () => {
  const bundle = path.join(temporary, 'Fixture.bundle'), fonts = path.join(bundle, 'fonts/jetbrains-mono'); mkdirSync(fonts, { recursive: true });
  writeFileSync(path.join(bundle, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>example.nsh.font.fixture</string></dict></plist>');
  for (const name of ['Regular', 'Medium', 'SemiBold']) cpSync(path.join(root, 'assets/fonts/jetbrains-mono', `JetBrainsMono-${name}.ttf`), path.join(fonts, `JetBrainsMono-${name}.ttf`));
  expect(run('bundled-overlap', fixtures!, bundle)).toBe('registered-faces-3-exact-source-no-duplicate-reads');
  expect(run('bundled-malformed', fixtures!, bundle)).toBe('all-bytes-validated-before-registration-prior-retained');
});
test.skipIf(!fixtures)('P2 retired A download cannot replace B bundled fonts, while current explicit B can reuse the same bytes', () => {
  const bundle = path.join(temporary, 'Retirement.bundle'), fonts = path.join(bundle, 'fonts/jetbrains-mono'); mkdirSync(fonts, { recursive: true });
  writeFileSync(path.join(bundle, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>example.nsh.font.retirement</string></dict></plist>');
  for (const name of ['Regular', 'Medium', 'SemiBold']) cpSync(path.join(root, 'assets/fonts/jetbrains-mono', `JetBrainsMono-${name}.ttf`), path.join(fonts, `JetBrainsMono-${name}.ttf`));
  expect(run('retired-bundled', fixtures!, bundle)).toBe('retired-byte-completion-keeps-new-B-bundled-font-explicit-selection-reuses-bytes');
  expect(run('shared-authority', fixtures!, bundle)).toBe('shared-byte-flight-distinct-consumer-registration-authority');
});
test.skipIf(!fixtures)('P2 one invalidated face recovers after removing a foreign collision, keeping shared own faces and cached bytes', () => {
  expect(run('partial-recovery', fixtures!)).toBe('one-face-conflict-removal-restores-all-without-disturbing-shared-own-faces');
});

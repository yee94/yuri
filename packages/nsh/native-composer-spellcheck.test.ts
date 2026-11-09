import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
const here = path.join(root, 'tests/native-composer-spellcheck');
const core = path.join(root, 'ios/NativeComposerSpellcheckLease.swift');
const owner = path.join(root, 'ios/NativeComposerSpellcheck.swift');
const temporary = () => mkdtempSync(path.join(os.tmpdir(), 'opencode', 'composer-spellcheck-'));

it('executes production spellcheck leases, generations and exact local resolver without an engine', () => {
  const directory = temporary();
  try {
    const binary = path.join(directory, 'checks');
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', core, path.join(here, 'LeaseChecks.swift'), '-o', binary], { timeout: 110_000, encoding: 'utf8' });
    expect(execFileSync(binary, { timeout: 10_000, encoding: 'utf8' })).toContain('16 composer spellcheck state checks passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);

it.skipIf(!process.env.NSH_DIST)('emits a real UIKit/NativeShell SDK object including the frozen AX modules', () => {
  const directory = temporary();
  try {
    const sdk = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim();
    const framework = path.join(process.env.NSH_DIST!, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
    execFileSync('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-whole-module-optimization', '-emit-object', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework,
      core, owner, path.join(root, 'ios/NativeInputMetadataBinding.swift'), path.join(root, 'ios/NativeInputMetadataOwner.swift'), path.join(here, 'UIKitSDKProbe.swift'), '-o', path.join(directory, 'spellcheck.o')], { timeout: 110_000, encoding: 'utf8' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);

it('wires independent retirement, both production composers and both native installs', () => {
  const helper = readFileSync(path.join(root, 'native-composer-spellcheck.tsx'), 'utf8');
  expect(helper).toContain("cleanup(() => registration?.command('retire'))");
  expect(helper).not.toContain('active:');
  for (const [file, ownerID, inputID] of [
    ['application.tsx', 'composer-glass', 'composer'],
    ['new-session-page.tsx', 'new-session-composer-glass', 'new-session-composer'],
  ]) {
    expect(readFileSync(path.join(root, file), 'utf8')).toContain(`<NativeComposerSpellcheck ownerID="${ownerID}" inputID="${inputID}" />`);
  }
  for (const main of ['ios/main.swift', 'tests/history-production-uikit/main.swift']) {
    expect(readFileSync(path.join(root, main), 'utf8')).toContain('NativeComposerSpellcheck.install(on: surface)');
  }
  const build = readFileSync(path.join(root, 'tests/history-production-uikit/build.mjs'), 'utf8');
  expect(build).toContain("'ios/NativeComposerSpellcheckLease.swift'");
  expect(build).toContain("'ios/NativeComposerSpellcheck.swift'");
});

it('keeps Web mobile spellcheck fixed on while hiding its preference', () => {
  const ui = path.resolve(root, '../ui/src');
  expect(readFileSync(path.join(ui, 'components/chat/ChatInput.tsx'), 'utf8')).toContain('spellCheck: isMobile || inputSpellcheckEnabled');
  expect(readFileSync(path.join(ui, 'components/views/git/CommitInput.tsx'), 'utf8')).toContain('spellCheck={isMobile || inputSpellcheckEnabled}');
  expect(readFileSync(path.join(ui, 'components/sections/yuri/YuriVisualSettings.tsx'), 'utf8')).toContain("!isMobile && shouldShow('inputSpellcheck')");
});

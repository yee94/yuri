import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
const here = path.join(root, 'tests/native-input-metadata');
const binding = path.join(root, 'ios/NativeInputMetadataBinding.swift');
const owner = path.join(root, 'ios/NativeInputMetadataOwner.swift');
const temporary = () => mkdtempSync(path.join(os.tmpdir(), 'opencode', 'input-metadata-'));

it('executes production Swift binding state checks without UIKit, engine, device or Host', () => {
  const directory = temporary();
  try {
    const binary = path.join(directory, 'checks');
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', binding, path.join(here, 'BindingChecks.swift'), '-o', binary], { timeout: 110_000, encoding: 'utf8' });
    const output = execFileSync(binary, { timeout: 10_000, encoding: 'utf8' });
    expect(output).toContain('12 native input metadata state checks passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it.skipIf(!process.env.NSH_DIST)('compiles production owner and public UIKit/NativeShell install seam against the actual SDK', () => {
  const directory = temporary();
  try {
    const sdk = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim();
    const framework = path.join(process.env.NSH_DIST!, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
    execFileSync('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-whole-module-optimization', '-emit-object', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework, binding, owner, path.join(here, 'UIKitSDKProbe.swift'), '-o', path.join(directory, 'metadata.o')], { timeout: 110_000, encoding: 'utf8' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('installs the component in production and production UIKit fixture mains', () => {
  for (const main of ['ios/main.swift', 'tests/history-production-uikit/main.swift']) {
    expect(readFileSync(path.join(root, main), 'utf8')).toContain('NativeInputMetadataOwner.install(on: surface)');
  }
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));

it.skipIf(!process.env.NSH_DIST)('links the full builder Swift input set against the iOS SDK without executing the binary', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'history-v4-sdk-link-'));
  try {
    const builder = readFileSync(path.join(root, 'build.mjs'), 'utf8');
    const names = JSON.parse(builder.match(/^const swiftSources = (\[.*\]);$/m)![1].replaceAll("'", '"')) as string[];
    const inputs = names.map(file => path.join(root, '../..', file));
    const frozen = inputs.map(file => readFileSync(file));
    const sources = inputs.map((file, index) => {
      const output = path.join(temporary, path.basename(file)); writeFileSync(output, frozen[index]); return output;
    });
    const sdk = spawnSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8', timeout: 10000 });
    expect(sdk.status, sdk.stderr).toBe(0);
    const framework = path.join(process.env.NSH_DIST!, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
    const frameworks = JSON.parse(builder.match(/const frameworks = (\[.*\]);/m)![1].replaceAll("'", '"')) as string[];
    const result = spawnSync('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-O', '-swift-version', '5', '-parse-as-library',
      '-sdk', sdk.stdout.trim(), '-target', 'arm64-apple-ios15.0-simulator', '-F', framework, '-framework', 'NativeShell',
      ...frameworks.flatMap(name => ['-framework', name]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', ...sources,
      '-o', path.join(temporary, 'HistoryV4UnexecutedSDKProbe')], { encoding: 'utf8', timeout: 220000 });
    expect(result.status, result.stderr).toBe(0);
    for (const [index, file] of inputs.entries()) expect(readFileSync(file).equals(frozen[index]), file + ' changed during compile').toBe(true);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240000);

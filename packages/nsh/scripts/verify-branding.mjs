#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, '.nsh/out/YuriNative.app');
const evidence = path.join(root, '.nsh/out/branding-evidence');
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
await mkdir(evidence, { recursive: true });
const plist = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')]));
assert.equal(plist.CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconName, 'AppIcon');
assert.equal(plist['CFBundleIcons~ipad'].CFBundlePrimaryIcon.CFBundleIconName, 'AppIcon');
assert.equal(plist.UILaunchStoryboardName, 'LaunchScreen');
assert.equal(plist.CFBundleIdentifier, 'com.yee94.yuri.nsh');
await access(path.join(app, 'LaunchScreen.storyboardc/Info.plist'));
const assets = JSON.parse(run('xcrun', ['assetutil', '--info', path.join(app, 'Assets.car')]));
const icons = assets.filter(asset => asset.Name === 'AppIcon' && asset.AssetType === 'Icon Image');
for (const idiom of ['phone', 'pad']) {
  for (const dark of [false, true]) {
    assert(icons.some(icon => icon.Idiom === idiom && (icon.Appearance === 'UIAppearanceDark') === dark && icon.Opaque === true && icon.PixelWidth === 1024));
  }
}
for (const name of ['YuriMark', 'YuriWordmark', 'YuriLaunchBackground']) {
  assert(assets.some(asset => asset.Name === name && asset.Appearance === 'UIAppearanceDark'));
  assert(assets.some(asset => asset.Name === name && !asset.Appearance));
}
run('codesign', ['--verify', '--strict', app]);
const sectionDump = run('xcrun', ['llvm-objdump', '--macho', '--section=__TEXT,__entitlements', path.join(app, 'YuriNative')]);
const entitlements = Buffer.concat(sectionDump.split('\n').filter(line => /^[0-9a-f]{16}\s/.test(line)).flatMap(line => line.trim().split(/\s+/).slice(1).map(word => Buffer.from(word, 'hex').reverse()))).toString('utf8');
assert(entitlements.includes('keychain-access-groups'));
assert(entitlements.includes('com.yee94.yuri.nsh'));
async function files(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? files(absolute) : [absolute];
  }))).flat();
}
const bundled = await files(path.join(app, 'nsh'));
for (const name of ['yuri-b-mark-black.svg', 'yuri-b-mark-white.svg', 'yuri-wordmark-black.svg', 'yuri-wordmark-white.svg']) {
  assert(bundled.some(file => path.basename(file) === name), `Missing imported NSH asset: ${name}`);
}
await writeFile(path.join(evidence, 'Info.json'), JSON.stringify(plist, null, 2));
await writeFile(path.join(evidence, 'Assets.json'), JSON.stringify(assets, null, 2));
await writeFile(path.join(evidence, 'Keychain-entitlements.txt'), entitlements);
await writeFile(path.join(evidence, 'NSH-imported-assets.json'), JSON.stringify(bundled.map(file => path.relative(root, file)), null, 2));
console.log(`Verified iPhone/iPad light+dark AppIcon, adaptive launch assets, compiled storyboard, signature, Keychain entitlements and all four NSH imported brand assets. Evidence: ${evidence}`);

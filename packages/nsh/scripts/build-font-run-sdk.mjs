#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const overlay = path.join(root, 'tests/native-fonts/sdk-font-runs');
const origin = process.env.NSH_FONT_SDK_SOURCE, work = process.env.NSH_FONT_SDK_WORKDIR, originalDist = process.env.NSH_FONT_ORIGINAL_DIST;
const overlaps = (a, b) => a && b && (path.resolve(a) === path.resolve(b) || path.resolve(a).startsWith(path.resolve(b) + path.sep) || path.resolve(b).startsWith(path.resolve(a) + path.sep));
if (!origin || !work || !originalDist || overlaps(origin, work) || overlaps(originalDist, work)) throw new Error('Set non-overlapping NSH_FONT_SDK_SOURCE / NSH_FONT_SDK_WORKDIR / NSH_FONT_ORIGINAL_DIST; input source and distribution are read-only');
const source = path.join(work, 'source'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 900_000, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})`);
  return result.stdout?.trim();
}
const files = ['Cargo.toml', 'src/lib.rs', 'src/text.rs', 'src/text_view.rs', 'src/embed.rs', 'include/nsh.h', 'swift/NativeShell.swift'].map(file => 'crates/nsh-platform-ios/' + file);
const baseline = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(origin, file)))])));
await mkdir(work, { recursive: true });
try { await access(source); if (!process.argv.includes('--resume')) throw new Error('Existing SDK workdir requires --resume'); }
catch (error) { if (error.code !== 'ENOENT') throw error; run('cp', ['-cRp', origin, source]); }
for (const file of files) {
  const original = await readFile(path.join(origin, file));
  await writeFile(path.join(source, file), original);
}
async function replace(relative, anchor, replacement) {
  const file = path.join(source, 'crates/nsh-platform-ios', relative), before = await readFile(file, 'utf8');
  if (before.split(anchor).length !== 2) throw new Error(`Non-unique SDK anchor: ${relative}`);
  await writeFile(file, before.replace(anchor, replacement));
}
await replace('Cargo.toml', 'embed = ["js"]', 'embed = ["js"]\n# Explicit test carrier; disabled in distribution builds.\nfont-diagnostics = ["embed"]');
await replace('src/lib.rs', 'mod text_view;', '#[cfg(feature = "font-diagnostics")]\nmod font_diagnostics;\nmod text_view;');
await writeFile(path.join(source, 'crates/nsh-platform-ios/src/font_diagnostics.rs'), await readFile(path.join(overlay, 'font_diagnostics.rs')));
await replace('src/text_view.rs', 'pub(crate) struct TextViewIvars {', 'pub(crate) struct TextViewIvars {\n    #[cfg(feature = "font-diagnostics")]\n    diagnostic_layout_generation: std::cell::Cell<u64>,');
await replace('src/text_view.rs', '        *self.ivars().layout.borrow_mut() = Some((layout, content));', '        #[cfg(feature = "font-diagnostics")]\n        self.ivars().diagnostic_layout_generation.set(self.ivars().diagnostic_layout_generation.get() + 1);\n        *self.ivars().layout.borrow_mut() = Some((layout, content));');
await replace('src/text_view.rs', '            CGContext::restore_g_state(c);\n        }\n    }', '            CGContext::restore_g_state(c);\n            #[cfg(feature = "font-diagnostics")]\n            crate::font_diagnostics::after_draw(self, text, self.ivars().diagnostic_layout_generation.get());\n        }\n    }');
await replace('src/text.rs', '    kCTFontTraitsAttribute, kCTFontWeightTrait, kCTForegroundColorAttributeName,', '    kCTFontTraitsAttribute, kCTFontWeightTrait, kCTForegroundColorAttributeName,\n    CTFontTableOptions, kCTFontTableOS2,');
await replace('src/text.rs', '        FamilyName::Named(name) => family_font(name, size, weight),', '        #[cfg(feature = "font-diagnostics")]\n        FamilyName::Named(name) => css_family_font(name, size, weight).or_else(|| family_font(name, size, weight)),\n        #[cfg(not(feature = "font-diagnostics"))]\n        FamilyName::Named(name) => family_font(name, size, weight),');
const textPath = path.join(source, 'crates/nsh-platform-ios/src/text.rs');
await writeFile(textPath, (await readFile(textPath, 'utf8')).replace('fn family_font(family: &str, size: CGFloat, weight: u16) -> Option<CFRetained<CTFont>> {', (await readFile(path.join(overlay, 'text.rs.inc'), 'utf8')) + 'fn family_font(family: &str, size: CGFloat, weight: u16) -> Option<CFRetained<CTFont>> {'));
const embedPath = path.join(source, 'crates/nsh-platform-ios/src/embed.rs');
await writeFile(embedPath, (await readFile(embedPath, 'utf8')) + await readFile(path.join(overlay, 'embed.rs.inc'), 'utf8'));
await replace('src/embed.rs', '    app.view.view().removeFromSuperview();', '    #[cfg(feature = "font-diagnostics")]\n    crate::font_diagnostics::stop(app.view.view());\n    app.view.view().removeFromSuperview();');
await replace('include/nsh.h', '#ifdef __cplusplus\n}\n#endif\n\nNS_ASSUME_NONNULL_END', '/* Test SDK feature font-diagnostics only. Strings freed with nsh_string_free. */\nchar *_Nullable nsh_app_text_font_diagnostics_begin(NshApp *app, const char *ids, uint64_t generation);\nchar *_Nullable nsh_app_text_font_diagnostics_read(NshApp *app, uint64_t generation);\nvoid nsh_app_text_font_diagnostics_stop(NshApp *app);\n\n#ifdef __cplusplus\n}\n#endif\n\nNS_ASSUME_NONNULL_END');
await replace('swift/NativeShell.swift', '    /// Grants the apps loaded from now on at most these capabilities:', (await readFile(path.join(overlay, 'NativeShell.swift.inc'), 'utf8')) + '\n    /// Grants the apps loaded from now on at most these capabilities:');
const changed = [...files, 'crates/nsh-platform-ios/src/font_diagnostics.rs'];
let diff = '';
for (const file of changed) {
  const before = files.includes(file) ? path.join(origin, file) : '/dev/null';
  const result = spawnSync('diff', ['-u', '--label', 'a/' + file, '--label', 'b/' + file, before, path.join(source, file)], { encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 1) throw new Error('Could not freeze SDK diff');
  diff += result.stdout;
}
await writeFile(path.join(work, 'font-runs-sdk.patch'), diff);
const manifest = { contract: 'nsh-ctrun-after-draw-v1', baseline, patched: Object.fromEntries(await Promise.all(changed.map(async file => [file, hash(await readFile(path.join(source, file)))]))),
  originalSourceUntouched: true, originalDistributionUntouched: true, inputSelectionFilesChanged: false, diagnosticsDefaultOff: true,
  rootOptimization: 'opt-level=1,lto=thin,codegen-units=8', performanceValidated: false, built: false };
await writeFile(path.join(work, 'font-runs-sdk.json'), JSON.stringify(manifest, null, 2));
if (process.argv.includes('--prepare-only')) { console.log(JSON.stringify({ prepared: true, work }, null, 2)); process.exit(0); }
const cargoHome = process.env.NSH_FONT_CARGO_HOME, rustupHome = process.env.NSH_FONT_RUSTUP_HOME;
if (!cargoHome || !rustupHome) throw new Error('Set existing NSH_FONT_CARGO_HOME / NSH_FONT_RUSTUP_HOME; no dependency or toolchain installation is permitted');
const installed = await readdir(path.join(rustupHome, 'toolchains'));
const toolchain = process.env.NSH_FONT_RUST_TOOLCHAIN || (installed.length === 1 ? installed[0] : undefined);
if (!toolchain || !installed.includes(toolchain)) throw new Error('Select an already installed NSH_FONT_RUST_TOOLCHAIN directory name; no toolchain installation is permitted');
const environment = { ...process.env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome, RUSTUP_TOOLCHAIN: toolchain, RUSTUP_AUTO_INSTALL: '0', CARGO_NET_OFFLINE: 'true', CARGO_BUILD_JOBS: '2', PATH: path.join(cargoHome, 'bin') + path.delimiter + process.env.PATH };
run(path.join(cargoHome, 'bin/cargo'), ['rustc', '--offline', '--locked', '--release', '-p', 'nsh-platform-ios', '--target', 'aarch64-apple-ios-sim', '--features', 'embed,font-diagnostics', '--crate-type', 'staticlib', '--', '-Copt-level=1', '-Clto=thin', '-Ccodegen-units=8'], { cwd: source, env: environment });
const sdkResult = spawnSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' });
if (sdkResult.status !== 0) throw new Error('Missing installed iOS SDK');
const sdk = sdkResult.stdout.trim(), crate = path.join(source, 'crates/nsh-platform-ios'), output = path.join(work, 'simulator');
await mkdir(output, { recursive: true });
const module = path.join(output, 'arm64-apple-ios-simulator');
run('xcrun', ['swiftc', '-parse-as-library', '-module-name', 'NativeShell', '-target', 'arm64-apple-ios15.0-simulator', '-sdk', sdk, '-swift-version', '5', '-enable-library-evolution', '-O', '-whole-module-optimization', '-D', 'NSH_TEXT_FONT_DIAGNOSTICS', '-emit-library', '-static', '-emit-module-path', module + '.swiftmodule', '-emit-module-interface-path', module + '.swiftinterface', '-I', path.join(crate, 'include'), path.join(crate, 'swift/NativeShell.swift'), '-o', path.join(output, 'libNativeShellSwift.a')]);
const rustLibrary = path.join(source, 'target/aarch64-apple-ios-sim/release/libnsh_platform_ios.a'), exports = path.join(output, 'exports.txt'), runtime = path.join(output, 'runtime.o');
await writeFile(exports, '_nsh_*\n');
run('xcrun', ['--sdk', 'iphonesimulator', 'clang', '-r', '-nostdlib', '-target', 'arm64-apple-ios15.0-simulator', '-isysroot', sdk, '-Wl,-force_load,' + rustLibrary, '-Wl,-exported_symbols_list,' + exports, '-o', runtime]);
const distribution = path.join(work, 'dist'), xcframework = path.join(distribution, 'embed/ios/NativeShell.xcframework');
await mkdir(path.dirname(xcframework), { recursive: true });
try { await access(xcframework); } catch { run('cp', ['-cRp', path.join(originalDist, 'embed/ios/NativeShell.xcframework'), xcframework]); }
const framework = path.join(xcframework, 'ios-arm64-simulator/NativeShell.framework'), modules = path.join(framework, 'Modules/NativeShell.swiftmodule');
run('xcrun', ['libtool', '-static', '-no_warning_for_no_symbols', '-o', path.join(framework, 'NativeShell'), runtime, path.join(output, 'libNativeShellSwift.a')]);
for (const extension of ['swiftmodule', 'swiftdoc', 'swiftinterface', 'private.swiftinterface']) {
  try { await writeFile(path.join(modules, 'arm64-apple-ios-simulator.' + extension), await readFile(module + '.' + extension)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
for (const [file, sha] of Object.entries(baseline)) if (hash(await readFile(path.join(origin, file))) !== sha) throw new Error('Original SDK source changed');
manifest.built = true; manifest.simulatorOnly = true;
manifest.publicInterfaceSHA256 = hash(await readFile(module + '.swiftinterface'));
manifest.frameworkSHA256 = hash(await readFile(path.join(framework, 'NativeShell')));
await writeFile(path.join(work, 'font-runs-sdk.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ work, distribution, patch: path.join(work, 'font-runs-sdk.patch'), built: true, simulatorOnly: true }, null, 2));

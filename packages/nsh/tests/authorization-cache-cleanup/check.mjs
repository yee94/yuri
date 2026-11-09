import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ios = path.resolve(here, '../../ios');
const out = await mkdtemp(path.join(tmpdir(), 'authorization-cache-cleanup-'));
const swift = args => execFileSync('xcrun', ['swiftc', '-swift-version', '5', ...args], { stdio: 'inherit' });
try {
  swift(['-emit-library', '-emit-module', '-module-name', 'NativeShell', path.join(here, 'NativeShell.swift'), '-emit-module-path', path.join(out, 'NativeShell.swiftmodule'), '-o', path.join(out, 'libNativeShell.dylib')]);
  const sources = ['AuthorizationCacheCleanup.swift', 'AuthorizationCacheCleanupBridge.swift'].map(file => path.join(ios, file));
  swift(['-parse-as-library', '-I', out, '-L', out, '-lNativeShell', '-Xlinker', '-rpath', '-Xlinker', out, ...sources, path.join(here, 'bridge.swift'), '-o', path.join(out, 'bridge-checks')]);
  execFileSync(path.join(out, 'bridge-checks'), [], { stdio: 'inherit' });
  const sdk = execFileSync('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  const flags = ['-sdk', sdk, '-target', 'arm64-apple-ios15.0'];
  swift([...flags, '-emit-module', '-module-name', 'NativeShell', path.join(here, 'NativeShell.swift'), '-emit-module-path', path.join(out, 'NativeShell.swiftmodule')]);
  swift([...flags, '-I', out, '-typecheck', ...sources]);
} finally {
  await rm(out, { recursive: true, force: true });
}

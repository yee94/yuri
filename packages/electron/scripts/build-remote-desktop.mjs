import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildRemoteDesktopHelper() {
  if (process.platform !== 'darwin') return;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const output = path.join(root, 'resources/remote-desktop/input-helper');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const source = path.join(root, 'native/remote-desktop-input.swift');
  for (const arch of ['arm64', 'x86_64']) {
    execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macosx12.0`, source, '-o', `${output}-${arch}`], { stdio: 'inherit' });
  }
  execFileSync('xcrun', ['lipo', '-create', `${output}-arm64`, `${output}-x86_64`, '-output', output], { stdio: 'inherit' });
  // Dev launches need a valid signature too; electron-builder re-signs with the release identity.
  execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'dev.yuri.remote-desktop-input', output], { stdio: 'inherit' });
  for (const arch of ['arm64', 'x86_64']) fs.unlinkSync(`${output}-${arch}`);
}

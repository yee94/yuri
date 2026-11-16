import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const installer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-portable.sh');
const directories = [];
afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function executable(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o755 });
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-portable-install-'));
  directories.push(root);
  const bin = path.join(root, 'tools'), install = path.join(root, 'installation');
  fs.mkdirSync(bin);
  executable(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n');
  executable(path.join(bin, 'ldd'), '#!/bin/sh\necho "glibc 2.36"\n');
  executable(path.join(bin, 'curl'), `#!/bin/sh
url=""; out=""
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; https://*) url="$1"; shift ;; *) shift ;; esac
done
case "$url" in
  */latest) printf '{"tag_name": "v1.2.3"}\\n' > "$out" ;;
  *.sha256) cp "$FIXTURE/checksum" "$out" ;;
  *) cp "$FIXTURE/artifact.tar.gz" "$out" ;;
esac
`);
  executable(path.join(bin, 'sha256sum'), `#!${process.execPath}
const fs = require('fs'), crypto = require('crypto');
console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex') + '  ' + process.argv[2]);
`);
  // Model GNU rename-over-symlink on macOS too; all other moves use the host utility.
  executable(path.join(bin, 'mv'), `#!${process.execPath}
const fs = require('fs'), cp = require('child_process');
const args = process.argv.slice(2);
if (args[0] === '-Tf') { fs.renameSync(args[1], args[2]); }
else { const result = cp.spawnSync('/bin/mv', args, { stdio: 'inherit' }); process.exit(result.status); }
`);
  for (const tool of ['node', 'npm', 'python3', 'gcc', 'g++']) {
    executable(path.join(bin, tool), '#!/bin/sh\necho "Unexpected target tool" >&2\nexit 99\n');
  }
  const unpacked = path.join(root, 'source/yuri');
  executable(path.join(unpacked, 'runtime/node'), '#!/bin/sh\nexit "${VERIFY_FAIL:-0}"\n');
  fs.writeFileSync(path.join(unpacked, 'verify.mjs'), 'fixture');
  executable(path.join(unpacked, 'yuri'), '#!/bin/sh\necho fixture\n');
  const archive = spawnSync('tar', ['-czf', path.join(root, 'artifact.tar.gz'), '-C', path.join(root, 'source'), 'yuri']);
  expect(archive.status).toBe(0);
  const digest = createHash('sha256').update(fs.readFileSync(path.join(root, 'artifact.tar.gz'))).digest('hex');
  fs.writeFileSync(path.join(root, 'checksum'), `${digest}  fixture.tar.gz\n`);
  const run = (args = [], extra = {}) => spawnSync('/bin/bash', [
    installer, '--install-dir', install, '--bin-dir', path.join(root, 'user-bin'), ...args,
  ], {
    encoding: 'utf8', env: { ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin`, FIXTURE: root, ...extra },
  });
  return { root, install, run };
}

it('installs and repeats safely without system Node/npm/Python/compiler', () => {
  const { root, install, run } = fixture();
  const result = run(['--version', '1.2.3']);
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readlinkSync(path.join(install, 'current'))).toBe('versions/1.2.3-linux-x64');
  expect(fs.readlinkSync(path.join(root, 'user-bin/yuri'))).toBe(path.join(install, 'current/yuri'));
  expect(run(['--version', '1.2.3']).status).toBe(0);
  expect(fs.existsSync(path.join(root, '.profile'))).toBe(false);
  expect(fs.existsSync(path.join(install, '.install-lock'))).toBe(false);
});

it('discovers stable without a JSON parser and accepts exact prereleases only when requested', () => {
  const { install, run } = fixture();
  expect(run().status).toBe(0);
  expect(run(['--version', '1.2.4-beta.1', '--no-link']).status).toBe(0);
  expect(fs.readlinkSync(path.join(install, 'current'))).toBe('versions/1.2.4-beta.1-linux-x64');
  expect(fs.existsSync(path.join(install, 'versions/1.2.3-linux-x64'))).toBe(true);
});

it('checksum and native preflight failures leave the previous installation selected', () => {
  const { root, install, run } = fixture();
  expect(run(['--version', '1.2.3']).status).toBe(0);
  expect(run(['--version', '1.2.4'], { VERIFY_FAIL: '7' }).status).not.toBe(0);
  expect(fs.readlinkSync(path.join(install, 'current'))).toBe('versions/1.2.3-linux-x64');
  fs.writeFileSync(path.join(root, 'checksum'), `${'0'.repeat(64)}  fixture\n`);
  const result = run(['--version', '1.2.4']);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('checksum mismatch');
  expect(fs.readlinkSync(path.join(install, 'current'))).toBe('versions/1.2.3-linux-x64');
});

it('does not overwrite another installation or race an active installer', () => {
  const { root, install, run } = fixture();
  executable(path.join(root, 'user-bin/yuri'), '#!/bin/sh\necho existing\n');
  expect(run(['--version', '1.2.3']).stderr).toContain('another installation');
  expect(fs.readFileSync(path.join(root, 'user-bin/yuri'), 'utf8')).toContain('existing');
  fs.mkdirSync(path.join(install, '.install-lock'));
  expect(run(['--version', '1.2.3', '--no-link']).stderr).toContain('Another installation');
  expect(fs.existsSync(path.join(install, 'current'))).toBe(false);
});

it('rejects traversal-like versions and unsupported libc explicitly', () => {
  const { root, run } = fixture();
  expect(run(['--version', '../not-a-version']).stderr).toContain('Invalid release version');
  executable(path.join(root, 'tools/ldd'), '#!/bin/sh\necho musl\n');
  expect(run(['--version', '1.2.3']).stderr).toContain('musl/Alpine is not supported');
});

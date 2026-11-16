import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readPortableInstallation } from './portable-installation.js';

const directories = [];
afterEach(() => { for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('recognizes only a valid sibling manifest and never infers ownership from environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-portable-owner-'));
  directories.push(root);
  const lib = path.join(root, 'lib');
  fs.mkdirSync(lib);
  fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({ name: '@yuriai/web', version: '1.2.3' }));
  expect(readPortableInstallation(lib)).toBeNull();
  fs.writeFileSync(path.join(root, 'portable.json'), JSON.stringify({
    format: 1, version: '1.2.3', platform: process.platform, arch: process.arch,
  }));
  expect(readPortableInstallation(lib)).toMatchObject({ root, manifest: { version: '1.2.3' } });
  fs.writeFileSync(path.join(root, 'portable.json'), '{"format":1,"version":"9.9.9"}');
  expect(() => readPortableInstallation(lib)).toThrow('Invalid Yuri portable installation');
});

it('uses the installer current symlink for startup without guessing a stable entry for manual archives', () => {
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-portable-stable-'));
  directories.push(install);
  const root = path.join(install, 'versions/1.2.3-linux-x64');
  const lib = path.join(root, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({ name: '@yuriai/web', version: '1.2.3' }));
  fs.writeFileSync(path.join(root, 'portable.json'), JSON.stringify({
    format: 1, version: '1.2.3', platform: process.platform, arch: process.arch,
  }));
  expect(readPortableInstallation(lib).launcher).toBe(path.join(root, 'yuri'));
  fs.symlinkSync('versions/1.2.3-linux-x64', path.join(install, 'current'));
  expect(readPortableInstallation(lib).launcher).toBe(path.join(install, 'current/yuri'));
});

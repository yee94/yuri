import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { isBinaryFile } from '@yuriai/web/server/lib/fs/binary-file.js';

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const binaryCase = source.slice(source.indexOf("    case 'desktop_is_binary_path':"), source.indexOf("    case 'desktop_open_external_url':"));
const context = vm.createContext({ fsp, Buffer, TextDecoder, isBinaryFile, browserWindow: { __yuriRuntimeConfig: { apiBaseUrl: 'local' } }, state: { localOrigin: 'local', sidecarUrl: 'local' }, sameOrigin: (a, b) => a === b });
vm.runInContext(`globalThis.invoke = async (args) => { switch ('desktop_is_binary_path') { ${binaryCase} } };`, context);
vm.runInContext(`globalThis.isDirectory = async (args) => { switch ('desktop_is_directory_path') { ${binaryCase} } };`, context);

describe('desktop binary-path command', () => {
  it('distinguishes a directory from a file for local link opening', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuri-directory-path-'));
    const filePath = path.join(directory, 'report.txt');
    try {
      await fsp.writeFile(filePath, 'report');
      expect(await context.isDirectory({ path: directory })).toBe(true);
      expect(await context.isDirectory({ path: filePath })).toBe(false);
      await expect(context.isDirectory({ path: path.join(directory, 'missing') })).rejects.toThrow();
      context.browserWindow.__yuriRuntimeConfig.relayHostId = 'remote';
      await expect(context.isDirectory({ path: directory })).rejects.toThrow('Local runtime required');
      delete context.browserWindow.__yuriRuntimeConfig.relayHostId;
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    ['Chinese crossing sample boundary', Buffer.from('a'.repeat(8191) + '好'), false],
    ['invalid UTF-8', Buffer.from([0xff]), true],
    ['NUL', Buffer.from([0x61, 0, 0x62]), true],
    ['incomplete UTF-8 at EOF', Buffer.from([0xe5]), true],
    ['incomplete UTF-8 at exact 8192-byte EOF', Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from([0xe5])]), true],
  ])('%s', async (_name, bytes, expected) => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuri-binary-path-'));
    const filePath = path.join(directory, 'report.eficy');
    try {
      await fsp.writeFile(filePath, bytes);
      expect(await context.invoke({ path: filePath })).toBe(expected);
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  });
});

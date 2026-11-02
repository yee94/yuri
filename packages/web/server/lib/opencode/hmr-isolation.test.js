import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const run = promisify(execFile);

it.each([false, true])('HMR isolates Yuri state with private OpenCode: %s', async (isolated) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hmr-isolation-'));
  const hmrData = path.join(directory, 'hmr');
  const sharedData = path.join(directory, 'shared-yuri');
  const capture = path.join(directory, 'api-env.json');
  const preload = path.join(directory, 'capture-spawn.cjs');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
require('node:child_process').spawn = (_command, args, options) => {
  if (args.includes('dev:server:watch')) {
    fs.writeFileSync(process.env.TEST_HMR_CAPTURE, JSON.stringify({
      yuriData: options.env.YURI_DATA_DIR,
      index: options.env.YURI_SESSION_INDEX_DB_PATH,
      sharedService: options.env.YURI_OPENCODE_SHARED_SERVICE,
    }));
  }
  return new EventEmitter();
};
require('node:module').syncBuiltinESMExports();
`);
  try {
    await run(process.execPath, ['--require', preload, path.join(repoRoot, 'scripts/dev-web-hmr.mjs')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        YURI_HMR_ISOLATED_OPENCODE: isolated ? '1' : '0',
        YURI_HMR_DATA_DIR: hmrData,
        YURI_DATA_DIR: sharedData,
        YURI_OPENCODE_SHARED_SERVICE: '1',
        YURI_VITE_FORCE: '0',
        XDG_DATA_HOME: path.join(directory, 'xdg-data'),
        TEST_HMR_CAPTURE: capture,
      },
    });
    expect(JSON.parse(fs.readFileSync(capture, 'utf8'))).toEqual({
      yuriData: isolated ? path.join(hmrData, 'yuri') : sharedData,
      index: path.join(hmrData, 'session-index.sqlite'),
      sharedService: isolated ? '0' : '1',
    });
    expect(fs.existsSync(sharedData)).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

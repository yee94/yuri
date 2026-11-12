import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { readHelperAx, shownKeyboardFrame, systemKeyboardKey } from './ios-ax-runtime.mjs';

test('software keys never hit a same-name directory outside the actual native keyboard frame', () => {
  const frame = shownKeyboardFrame([{ name: 'UIKeyboardDidShowNotification', endFrame: '{{0, 539}, {402, 335}}', epochMs: 1 }]);
  const directory = { type: 'Button', AXLabel: 'T', enabled: true, frame: { x: 40, y: 440, width: 100, height: 30 } };
  const key = { type: 'Button', AXLabel: 'T', enabled: true, frame: { x: 180, y: 590, width: 30, height: 54 } };
  expect(systemKeyboardKey([directory], frame, 'T', true)).toBeNull();
  expect(() => systemKeyboardKey([directory], frame, 'T')).toThrow('got 0');
  expect(systemKeyboardKey([directory, key], frame, 'T')).toBe(key);
  expect(() => shownKeyboardFrame([{ name: 'UIKeyboardDidHideNotification' }])).toThrow('currently shown');
});

test('AX collector serializes requests and requires helper reset after client timeout, not App restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-projects-ax-test-'));
  const helper = { pid: 100, port: 1 };
  try {
    let release;
    const pending = readHelperAx({ helper, root, fetchImpl: () => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => [{ frame: { width: 1, height: 1 }, children: [] }] }); }) });
    await expect(readHelperAx({ helper, root, fetchImpl: async () => { throw Error('must not start'); } })).rejects.toThrow();
    release(); await pending;
    await expect(readHelperAx({ helper, root, fetchImpl: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); } })).rejects.toThrow('timeout');
    await expect(readHelperAx({ helper, root, fetchImpl: async () => { throw Error('must not start'); } })).rejects.toThrow('restart only this task helper');
    const result = await readHelperAx({ helper: { ...helper, pid: 101 }, root, fetchImpl: async () => ({ ok: true, json: async () => [{ frame: { width: 402, height: 874 }, children: [] }] }) });
    expect(result.app.width).toBe(402);
  } finally { for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file)); fs.rmdirSync(root); }
});

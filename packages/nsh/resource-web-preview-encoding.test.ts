import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerFsRoutes } from '../web/server/lib/fs/routes.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const webRequire = createRequire(path.join(root, '../web/package.json'));
const express = webRequire('express') as { response: object };
type Response = {
  statusCode: number;
  getHeader(name: string): string | undefined;
  setHeader(name: string, value: string): void;
  sendFile(file: string): Response;
  status(code: number): Response;
  json(): never;
};

it('retains the real Host fs serve Content-Type charset through current Express header handling, without a listener or Host', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-web-preview-encoding-'));
  try {
    const handlers: Array<(request: object, response: Response) => Promise<unknown>> = [];
    registerFsRoutes({ get(route: string | RegExp, handler: (request: object, response: Response) => Promise<unknown>) { if (route instanceof RegExp) handlers.push(handler); }, post() {}, put() {} }, {
      os, path, fsPromises: fs, spawn() {}, crypto: globalThis.crypto,
      normalizeDirectoryPath: (value: string) => value, resolveProjectDirectory: async () => ({ directory }),
      buildAugmentedPath: () => '', resolveGitBinaryForSpawn: () => 'git', yuriUserConfigRoot: directory,
    });
    expect(handlers).toHaveLength(1);
    for (const [filename, type] of [['index.html', 'text/html; charset=utf-8'], ['style.css', 'text/css; charset=utf-8'], ['app.js', 'application/javascript; charset=utf-8'], ['raw.bin', 'application/octet-stream']]) {
      const file = path.join(directory, filename);
      await fs.writeFile(file, filename.endsWith('.bin') ? Buffer.from([0xff, 0, 0x80]) : '<p>资源预览</p>');
      const headers = new Map<string, string>();
      let served: string | undefined;
      const response = Object.create(express.response) as Response;
      Object.assign(response, {
        statusCode: 200,
        getHeader(name: string) { return headers.get(name.toLowerCase()); },
        setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
        sendFile(value: string) { served = value; return response; },
        status(code: number) { response.statusCode = code; return response; },
        json() { throw new Error(`Synthetic fs serve unexpectedly failed (${response.statusCode})`); },
      });
      await handlers[0]({ params: { 0: file.slice(1) }, query: { directory }, headers: {} }, response);
      expect(served).toBe(await fs.realpath(file));
      expect(headers.get('content-type')).toBe(type);
      expect(headers.get('x-content-type-options')).toBe('nosniff');
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

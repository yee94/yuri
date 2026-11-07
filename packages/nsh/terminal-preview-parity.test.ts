import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { extractTerminalPreviewUrl, extractTerminalActionURL } from './terminal-preview';

it('retained pure extraction matches the actual Web owner over split/ANSI/Python/port fixtures', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(root, '../ui/src/lib/terminalPreview.ts'), 'utf8').replace(/^import .*;\n/, '').split('export const isTerminalPreviewUrlAvailable')[0];
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: { extractTerminalPreviewUrl?: (text: string) => string | null } = {};
  new Script(compiled).runInNewContext({ exports, URL });
  for (const text of ['', 'ordinary http://localhost:3000', 'ready http://localhost:3000/path', '\x1b[32m➜ Local: http://0.0.0.0:5173/\x1b[0m', 'Serving HTTP on :: port 8000',
    'server http://[::1]:4000/', 'available http://localhost:80/ and http://localhost:4000/', 'running https://localhost:443/ and https://localhost:8000/', 'vite http://localhost:65536/', 'ready (http://localhost:3000/path).']) {
    expect(extractTerminalPreviewUrl(text), text).toBe(exports.extractTerminalPreviewUrl!(text));
  }
});
it('Action output URL choice matches actual ProjectActionsButton owner without running React or transport', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const owner = readFileSync(path.join(root, '../ui/src/components/layout/ProjectActionsButton.tsx'), 'utf8');
  const source = owner.slice(owner.indexOf('const ANSI_ESCAPE_PREFIX'), owner.indexOf('export const ProjectActionsButton')) + '\nexport { extractBestUrl };';
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: { extractBestUrl?: (text: string) => string | null } = {};
  new Script(compiled).runInNewContext({ exports, URL });
  for (const text of ['', 'Visit https://example.invalid/docs.', 'https://remote.invalid:4000/path and http://localhost:3000/', '\x1b[32mhttp://localhost:3000/deep/path?q=x http://localhost:4000/\x1b[0m', 'http://localhost:80/ https://remote.invalid:4000/path', 'http://[::1]:5000/']) expect(extractTerminalActionURL(text), text).toBe(exports.extractBestUrl!(text));
});

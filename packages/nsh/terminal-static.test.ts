import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
it('parses real installed offline Ghostty artifact and document without executing a browser/VT engine', () => {
  const javascript = readFileSync(path.join(root, '../../node_modules/ghostty-web/dist/ghostty-web.umd.cjs'), 'utf8');
  const wasm = readFileSync(path.join(root, '../../node_modules/ghostty-web/ghostty-vt.wasm'));
  const native = readFileSync(path.join(root, 'ios/NativeTerminalPreview.swift'), 'utf8');
  const bootstrap = native.split('static let bootstrap = #"""')[1].split('"""#')[0];
  expect(() => new Script(javascript)).not.toThrow(); expect(() => new Script(bootstrap)).not.toThrow();
  expect(wasm.subarray(0, 4)).toEqual(Buffer.from([0, 97, 115, 109]));
  expect(native).toContain("connect-src 'none'"); expect(native).toContain("frame-src 'none'");
  expect(bootstrap).not.toMatch(/fetch\(|WebSocket\(|host\.call|localStorage|sessionStorage|window\.nsh/);
  expect(native).toContain('WKNavigationDelegate'); expect(native).toContain('WKUIDelegate');
  expect(readFileSync(path.join(root, 'terminal.tsx'), 'utf8')).not.toContain('<WebView');
});
it('focused NSH public SDK TypeScript typecheck only; does not invoke nsh or build main', () => {
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'terminal-ts-'));
  try {
    const config = path.join(temporary, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({ extends: path.join(root, 'tsconfig.json'), include: [], exclude: [], files: [path.join(root, '.nsh/types/nsh/globals.d.ts'), path.join(root, '.nsh/types/nsh/assets.d.ts'), path.join(root, '.nsh/types/nsh/tokens.d.ts'), path.join(root, 'terminal.tsx')] }));
    const result = spawnSync(process.execPath, [path.join(root, '../../node_modules/typescript/bin/tsc'), '--project', config, '--pretty', 'false'], { encoding: 'utf8', timeout: 60_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 70_000);

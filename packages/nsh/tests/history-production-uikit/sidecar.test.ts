import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('executes the actual clock-only sidecar and records the real JS round-trip without assuming native and JS epochs agree', async () => {
  const source = ts.transpileModule(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'sidecar.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
  const listeners = new Map<string, (payload: unknown) => void>(), calls: Array<{ name: string; input: Record<string, number | string> }> = [];
  const host = { on: (name: string, callback: (payload: unknown) => void) => listeners.set(name, callback), call: async (name: string, input: Record<string, number | string>) => {
    calls.push({ name, input });
    return name === 'history.qa.clock' ? { receivedNativeMs: 9_000_000, returnedNativeMs: 9_000_001 } : true;
  } };
  vm.runInNewContext(source, { exports: {}, performance, console, require: (id: string) => { if (id !== 'nsh') throw new Error('Unexpected sidecar dependency'); return { host }; } });
  listeners.get('history.qa.clock.request')!({ nonce: 'actual-sidecar-roundtrip' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(calls.map(call => call.name)).toEqual(['history.qa.ready', 'history.qa.clock', 'history.qa.clockAck']);
  expect(calls[2].input.jsReceiveMs).toBeGreaterThanOrEqual(calls[1].input.jsSendMs as number);
  expect(calls[2].input).toMatchObject({ nonce: 'actual-sidecar-roundtrip', jsSendMs: calls[1].input.jsSendMs, receivedNativeMs: 9_000_000, returnedNativeMs: 9_000_001 });
});

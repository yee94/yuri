import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { terminalHostCalls, verifyBuiltTerminalCapabilities, verifyTerminalConfig } from './capabilities.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
it('grants only the two local observation calls and uses packaged capabilities for the Swift ceiling', () => {
  const config = JSON.parse(readFileSync(path.join(directory, 'nsh.json'), 'utf8'));
  expect(() => verifyTerminalConfig(config)).not.toThrow();
  expect(terminalHostCalls).toEqual(['terminal.record', 'terminal.capture']);
  const swift = readFileSync(path.join(directory, 'main.swift'), 'utf8');
  expect(swift).toContain('withExtension: "json", subdirectory: "nsh"');
  expect(swift).toContain('surface.grantCapabilities(capabilities)');
  expect(swift).not.toContain('grantCapabilities("{}")');
});

it('rejects the original empty host grant and any network/process/fs or wildcard escalation', () => {
  expect(() => verifyTerminalConfig({ capabilities: {} })).toThrow();
  expect(() => verifyTerminalConfig({ capabilities: { host: ['terminal.*'] } })).toThrow();
  const built = { network: { hosts: [], http: [] }, process: { execute: [], exit: false, env: [] }, fs: { read: [], write: [] },
    statusBar: false, clipboard: false, picker: false, openUrl: false, host: [...terminalHostCalls] };
  expect(() => verifyBuiltTerminalCapabilities(built)).not.toThrow();
  for (const patch of [{ host: [] }, { host: true }, { network: { hosts: ['*'], http: [] } }, { fs: { read: ['*'], write: [] } }, { process: { execute: ['*'], exit: false, env: [] } }]) {
    expect(() => verifyBuiltTerminalCapabilities({ ...built, ...patch })).toThrow();
  }
});

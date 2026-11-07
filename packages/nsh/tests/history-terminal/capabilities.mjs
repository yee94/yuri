import assert from 'node:assert/strict';

export const terminalHostCalls = Object.freeze(['terminal.record', 'terminal.capture']);

export function verifyTerminalConfig(config) {
  assert.deepEqual(config.capabilities, { host: [...terminalHostCalls] }, 'Fixture config must grant only the two exact terminal calls');
}

/** Verify actual compiler output, not merely the input declaration. Fail closed on extra grants. */
export function verifyBuiltTerminalCapabilities(capabilities) {
  assert.deepEqual(capabilities, {
    network: { hosts: [], http: [] },
    process: { execute: [], exit: false, env: [] },
    fs: { read: [], write: [] },
    statusBar: false, clipboard: false, picker: false, openUrl: false,
    host: [...terminalHostCalls],
  }, 'Built fixture must grant exactly terminal.record/terminal.capture and no other capabilities');
}

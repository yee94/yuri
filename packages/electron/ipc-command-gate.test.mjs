import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isRemoteIpcCommandAllowed } from './ipc-command-gate.mjs';

test('allows remote Electron pages to use the desktop updater', () => {
  assert.equal(isRemoteIpcCommandAllowed('desktop_check_for_updates'), true);
  assert.equal(isRemoteIpcCommandAllowed('desktop_download_and_install_update'), true);
  assert.equal(isRemoteIpcCommandAllowed('desktop_restart', { applyUpdate: true }), true);
});

test('keeps generic desktop restarts local to the packaged UI', () => {
  assert.equal(isRemoteIpcCommandAllowed('desktop_restart'), false);
  assert.equal(isRemoteIpcCommandAllowed('desktop_restart', { applyUpdate: false }), false);
});

test('does not allow remote pages to prepare SSH hosts', () => {
  assert.equal(isRemoteIpcCommandAllowed('desktop_host_prepare'), false);
});

test('remote pages cannot read, enable or request native remote-desktop permissions', () => {
  for (const command of ['desktop_remote_desktop_status', 'desktop_remote_desktop_enable', 'desktop_remote_desktop_permission']) {
    assert.equal(isRemoteIpcCommandAllowed(command, { enabled: true, permission: 'screen' }), false);
  }
});

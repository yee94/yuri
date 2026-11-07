import { expect, test } from 'vitest';
import { createHost } from './tests/settings-about-host.js';
import { aboutReadResponse, aboutSubmitResponse, createSettingsAbout } from './settings-about-core';

test('isolated fixture drives production core without a network, credential, update or engine', async () => {
  const host = createHost();
  const expectedHost = host.call('connection.list', {}).runtimeScope;
  const controller = createSettingsAbout({ current: () => true, hostID: 'synthetic-about-host', call: async (name, input) => host.call(name, input), read: async path => aboutReadResponse(path, host.call('runtime.request', { path, method: 'GET', expectedHost })) });
  await controller.refresh();
  expect(controller.state().client.value?.version).toBe('0.8.1');
  expect(controller.state().host.value?.version).toBe('2.3.0');
  expect(controller.state().opencode.value?.version).toBe('2.1.7');
  expect(controller.state().hostUpdate.value?.availableVersion).toBe('2.4.0');
  await controller.setDiagnostics(true);
  for (const mode of ['cancelled', 'failed', 'shared']) {
    host.call('about.fixture.scenario', { mode }); await controller.exportDiagnostics();
    expect(controller.state().exportOutcome).toBe(mode);
  }
  host.call('about.fixture.scenario', { mode: 'fail-info' }); await controller.refresh();
  expect(controller.state().host).toMatchObject({ value: { version: '2.3.0' }, status: 'failed' });
  host.call('about.fixture.scenario', { mode: 'missing' }); await controller.refresh();
  expect(controller.state().client.value?.version).toBeNull(); expect(controller.state().host.value?.version).toBeNull(); expect(controller.state().opencode.value?.version).toBeNull();
  const audit = host.call('about.fixture.audit'); expect(audit).toMatchObject({ exports: 3, enabled: true });
  expect(JSON.stringify(audit.safeSnapshot)).not.toMatch(/private|token|message|serverId|guidance|pid|startedAt/);
  for (const path of ['/api/system/update', '/api/opencode/upgrade']) expect(() => host.call('runtime.request', { path, method: 'POST' })).toThrow();
  expect(() => host.call('runtime.request', { path: '/api/config/settings', method: 'GET' })).toThrow();
});

test('exact synthetic CGI runs confirmation, progress, failure, fresh-plan retry and server success, never a shell or network', async () => {
  const host = createHost();
  const expectedHost = host.call('connection.list', {}).runtimeScope;
  const controller = createSettingsAbout({ current: () => true, hostID: 'synthetic-about-host', call: async (name, input) => host.call(name, input),
    read: async path => aboutReadResponse(path, host.call('runtime.request', { path, method: 'GET', expectedHost })),
    submitUpdate: async body => aboutSubmitResponse(host.call('runtime.request', { path: '/api/system/update', method: 'POST', body, expectedHost })) });
  await controller.prepareUpdate(); controller.cancelUpdate(); await controller.confirmUpdate(); expect(host.call('about.fixture.audit').submissions).toBe(0);
  await controller.prepareUpdate(); await controller.confirmUpdate(); expect(host.call('about.fixture.audit').submissions).toBe(1);
  host.call('about.fixture.scenario', { mode: 'downloading' }); await controller.reconcileUpdate(); expect(controller.state().hostUpdate.value?.task?.progress).toBe(40);
  host.call('about.fixture.scenario', { mode: 'restarting' }); await controller.reconcileUpdate();
  host.call('about.fixture.scenario', { mode: 'gap' }); await controller.reconcileUpdate(); expect(controller.state().hostUpdate).toMatchObject({ status: 'failed', value: { operation: 'restarting' } });
  host.call('about.fixture.scenario', { mode: 'normal' }); host.call('about.fixture.scenario', { mode: 'update-failed' }); await controller.reconcileUpdate();
  await controller.prepareUpdate(); expect(controller.state().updateConfirm?.plan?.planId).toBe('synthetic-plan-2'); await controller.confirmUpdate();
  host.call('about.fixture.scenario', { mode: 'succeeded' }); await controller.reconcileUpdate();
  expect(controller.state().hostUpdate.value?.operation).toBe('succeeded'); expect(host.call('about.fixture.audit').submissions).toBe(2);
  for (const input of [
    { path: '/api/system/update', method: 'POST', body: { command: 'never-executed' } },
    { path: '/api/system/update?url=x', method: 'GET' },
    { path: '/api/opencode/upgrade', method: 'POST' },
    { path: '/api/system/update', method: 'GET', url: 'https://external.example.invalid' },
  ]) expect(() => host.call('runtime.request', input)).toThrow();
  expect(() => host.call('native.diagnostics.unknown', {})).toThrow();
});

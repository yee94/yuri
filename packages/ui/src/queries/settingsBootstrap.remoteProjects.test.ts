import { expect, it } from 'vitest';
import { parseSettingsBootstrap, parseSettingsBootstrapPatch, projectSettingsBootstrapPatch } from './settingsBootstrapParser';

it('accepts the optional Hub discovery hint without allowing clients to mutate it as settings', () => {
  expect(parseSettingsBootstrap({ schemaVersion: 1 })).toEqual({ schemaVersion: 1 });
  expect(parseSettingsBootstrap({ schemaVersion: 1, hasRemoteProjects: true })).toEqual({ schemaVersion: 1, hasRemoteProjects: true });
  expect(parseSettingsBootstrap({ schemaVersion: 1, hasRemoteProjects: false })).toEqual({ schemaVersion: 1, hasRemoteProjects: false });
  expect(parseSettingsBootstrap({ schemaVersion: 1, hasRemoteProjects: 'true' })).not.toHaveProperty('hasRemoteProjects');
  expect(() => parseSettingsBootstrapPatch({ hasRemoteProjects: true })).toThrow('Invalid settings bootstrap patch');
  expect(projectSettingsBootstrapPatch({ hasRemoteProjects: true, defaultAgent: 'build' })).toEqual({ defaultAgent: 'build' });
});

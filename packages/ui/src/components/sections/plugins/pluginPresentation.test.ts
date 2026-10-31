import { expect, test } from 'vitest';
import { splitPluginSpec } from './pluginPresentation';

test('splits the selector without splitting scoped names or local paths', () => {
  expect(splitPluginSpec('@scope/plugin@1.2.3')).toEqual({ name: '@scope/plugin', version: '1.2.3' });
  expect(splitPluginSpec('@scope/plugin')).toEqual({ name: '@scope/plugin', version: null });
  expect(splitPluginSpec('plugin@latest')).toEqual({ name: 'plugin', version: 'latest' });
  expect(splitPluginSpec('./plugin@local.ts', false)).toEqual({ name: './plugin@local.ts', version: null });
});

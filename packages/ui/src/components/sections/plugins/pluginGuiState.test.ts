import { expect, test } from 'vitest';
import { findPluginGuiMatches } from './pluginGuiState';

test('GUI ownership uses exact source targets rather than package names or GUI IDs', () => {
  const inventory = [
    { id: 'canvas', enabled: false, source: { type: 'package' as const, target: '@scope/plugin@1.0.0' } },
    { id: '@scope/plugin', enabled: true, source: { type: 'package' as const, target: 'other' } },
  ];
  expect(findPluginGuiMatches({ kind: 'package', target: '@scope/plugin@1.0.0' }, inventory).map((item) => item.id)).toEqual(['canvas']);
  expect(findPluginGuiMatches({ kind: 'package', target: '@scope/plugin@latest' }, inventory)).toEqual([]);
  expect(findPluginGuiMatches(null, inventory)).toEqual([]);
});

test('local sources respect path boundaries', () => {
  const inventory = [{ id: 'local', enabled: true, source: { type: 'local' as const, path: '/workspace/plugin/index.ts' } }];
  expect(findPluginGuiMatches({ kind: 'local', path: '/workspace/plugin' }, inventory)).toHaveLength(1);
  expect(findPluginGuiMatches({ kind: 'local', path: '/workspace/plu' }, inventory)).toEqual([]);
});

import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import { filterSyncedPluginConfig } from './plugins.js';

describe('portable plugin declarations', () => {
  it.each([
    'file:///home/user/plugin', 'file:../plugin', '/opt/plugins/local', '//server/share/plugin',
    './plugins/local', '../local', '~/plugins/local', 'C:\\plugins\\local', '\\\\server\\share\\local',
    'plugins/local', '.\\plugins\\local', 'link:../plugin', 'workspace:*',
    'https://example.com/plugin.tgz', 'git+https://example.com/plugin.git', 'github:org/plugin',
    'plugin@file:../local', 'plugin@/opt/local', '@scope/plugin@link:../local',
  ])('excludes %s in string, tuple and object declarations', (spec) => {
    const content = JSON.stringify({
      plugin: [spec, [spec, { enabled: true }], 'registry-plugin@^1.2.0'],
      plugins: [spec, { package: spec, options: { enabled: true } }, '@scope/registry@beta'],
    });
    expect(JSON.parse(filterSyncedPluginConfig(content))).toEqual({
      plugin: ['registry-plugin@^1.2.0'], plugins: ['@scope/registry@beta'],
    });
  });

  it('preserves registry versions, scopes, ordering, tuple options and V2 object fields', () => {
    const config = {
      plugin: [['existing@1.2.3', { mode: 'safe', path: '/keep-option' }]],
      plugins: ['bare', '@scope/bare', 'range@>=1.0.0 <2.0.0', 'tag@latest',
        { package: '@scope/plugin@2.0.0-beta.1+build.3', options: { nested: [1, true] }, disabled: true }],
    };
    const content = JSON.stringify(config, null, 2);
    expect(filterSyncedPluginConfig(content)).toBe(content);
  });

  it('filters both keys while retaining BOM, comments, trailing commas and unrelated content', () => {
    const content = '\uFEFF{\r\n  // Keep provider configuration.\r\n  "provider": { "example": { "options": { "baseURL": "http://localhost:3000" } } },\r\n  "plugins": [\r\n    "file:///opt/local",\r\n    // Registry options stay intact.\r\n    { "package": "@scope/plugin@^2", "options": { "mode": "safe" } },\r\n    "./local",\r\n  ],\r\n  "plugin": [["../legacy", {}], ["legacy@1", { "flag": true }]],\r\n}\r\n';
    const filtered = filterSyncedPluginConfig(content);
    const config = parse(filtered.slice(1));
    expect(config.plugins).toEqual([{ package: '@scope/plugin@^2', options: { mode: 'safe' } }]);
    expect(config.plugin).toEqual([['legacy@1', { flag: true }]]);
    expect(filtered.startsWith('\uFEFF')).toBe(true);
    expect(filtered).toContain('// Keep provider configuration.\r\n  "provider": { "example": { "options": { "baseURL": "http://localhost:3000" } } },');
    expect(filtered).toContain('// Registry options stay intact.');
    expect(filterSyncedPluginConfig(filtered)).toBe(filtered);
  });

  it.each(['{}\n', '// Empty configuration.\n', '', '{ "plugins": [], "plugin": [] }'])('leaves unchanged config byte-identical: %j', (content) => {
    expect(filterSyncedPluginConfig(content)).toBe(content);
  });

  it('retains empty plugin arrays when every declaration is local', () => {
    expect(JSON.parse(filterSyncedPluginConfig('{"plugins":["/local"],"plugin":[["file:../local",{}]]}')))
      .toEqual({ plugins: [], plugin: [] });
  });

  it('keeps strict JSON valid for every combination of leading, adjacent and trailing removals', () => {
    for (let mask = 0; mask < 32; mask += 1) {
      const plugins = Array.from({ length: 5 }, (_, index) => mask & (1 << index) ? `registry-${index}@latest` : `/local/${index}`);
      const filtered = filterSyncedPluginConfig(JSON.stringify({ plugins, model: 'unchanged' }));
      expect(JSON.parse(filtered)).toEqual({ plugins: plugins.filter((entry) => !entry.startsWith('/')), model: 'unchanged' });
    }
  });

  it.each(['{broken', 'null', '[]', '{"plugins":"/local"}', '{"plugin":{}}', '{"plugins":[],"plugins":["/local"]}'])('fails closed for invalid or ambiguous configuration: %s', (content) => {
    expect(() => filterSyncedPluginConfig(content)).toThrow('invalid OpenCode JSONC configuration');
  });
});

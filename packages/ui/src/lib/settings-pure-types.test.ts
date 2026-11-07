import { expect, expectTypeOf, test } from 'vitest';
import type { McpDraft, McpScope } from './mcp-config-types';
import type { McpDraft as StoreMcpDraft, McpScope as StoreMcpScope } from '../stores/useMcpConfigStore';
import type { PluginRuntimeInfo, PluginRuntimeSource, PluginRuntimeState } from './opencode/plugin-runtime-types';
import type { PluginRuntimeInfo as ApiPluginRuntimeInfo, PluginRuntimeSource as ApiPluginRuntimeSource, PluginRuntimeState as ApiPluginRuntimeState } from './opencode/plugins';
import { applyImportedMcpToDraft, parseImportedMcpSnippet } from '../components/sections/mcp/mcpImport';
import { findRuntimeMatches } from '../components/sections/plugins/pluginLoadState';

test('original settings owners keep their structural type API after extraction', () => {
  expectTypeOf<McpDraft>().toEqualTypeOf<StoreMcpDraft>();
  expectTypeOf<McpScope>().toEqualTypeOf<StoreMcpScope>();
  expectTypeOf<PluginRuntimeInfo>().toEqualTypeOf<ApiPluginRuntimeInfo>();
  expectTypeOf<PluginRuntimeSource>().toEqualTypeOf<ApiPluginRuntimeSource>();
  expectTypeOf<PluginRuntimeState>().toEqualTypeOf<ApiPluginRuntimeState>();
  expectTypeOf<Parameters<typeof applyImportedMcpToDraft>[1]>().toEqualTypeOf<Partial<StoreMcpDraft> & { name?: string }>();
  expectTypeOf<Parameters<typeof findRuntimeMatches>[1]>().toEqualTypeOf<readonly ApiPluginRuntimeInfo[]>();
});

test('the same import parser populates a framework-neutral draft', () => {
  const result = parseImportedMcpSnippet('{"mcp":{"example":{"command":["example-mcp"]}}}');
  if (!result.ok) throw new Error(result.error);
  const next = applyImportedMcpToDraft(result, { name: '', scope: 'project' }, { isNewServer: true });
  expectTypeOf(next).toEqualTypeOf<Partial<McpDraft> & { name: string }>();
  expect(next).toMatchObject({ name: 'example', scope: 'project', type: 'local', command: ['example-mcp'], url: '', headers: [], oauthEnabled: false });
});

import { expect, test } from 'vitest';
import { prepareCollectionSearchTarget, searchSettingsFields } from './settings-search-core';

test('collection search uses the same Web field IDs and prepares conditional editors', () => {
  expect(searchSettingsFields('variant', key => key).some(item => item.id === 'agents.model')).toBe(true);
  expect(prepareCollectionSearchTarget('agents', 'agents.model')).toEqual({ create: true, draft: {} });
  expect(prepareCollectionSearchTarget('mcp', 'mcp.advanced')).toEqual({ create: true, draft: { type: 'remote' } });
  expect(prepareCollectionSearchTarget('mcp', 'mcp.command')).toEqual({ create: true, draft: { type: 'local' } });
  expect(prepareCollectionSearchTarget('commands', 'agents.model')).toBeNull();
  expect(prepareCollectionSearchTarget('skills.installed', 'skills.supporting-files')).toEqual({ create: true, draft: {} });
});

import { describe, expect, test } from 'vitest';
import { getAgentDisplayName, getCycledPrimaryAgentName, resolveAgentModelSelection } from './mobileControlsUtils';

describe('primary Agent cycling shared by Web and native composer', () => {
  test('cycles primary/all/default modes in source order, excluding subagents', () => {
    const agents = [{ name: 'build', mode: 'primary' as const }, { name: 'child', mode: 'subagent' as const }, { name: 'plan', mode: 'primary' as const }, { name: 'custom', mode: 'all' as const }];
    expect(getCycledPrimaryAgentName(agents, 'build')).toBe('plan');
    expect(getCycledPrimaryAgentName(agents, 'custom')).toBe('build');
    expect(getCycledPrimaryAgentName(agents, 'build', -1)).toBe('custom');
    expect(getCycledPrimaryAgentName([{ name: 'build' }, { name: 'plan' }], 'build')).toBe('plan');
  });
  test('keeps Web fallback order for missing selection and has no fake switch with one Agent', () => {
    expect(getCycledPrimaryAgentName([{ name: 'build' }, { name: 'plan' }], 'missing')).toBe('plan');
    expect(getCycledPrimaryAgentName([{ name: 'build' }], 'build')).toBeNull();
    expect(getCycledPrimaryAgentName([], undefined)).toBeNull();
    expect(getAgentDisplayName([{ name: 'plan' }], 'plan')).toBe('Plan');
  });
  test('pinned Agent models are used only if the exact catalog entry exists', () => {
    const selection = { providerID: 'p', modelID: 'existing', agent: 'build' };
    const agents = [{ name: 'plan', model: { providerID: 'q', modelID: 'pinned' } }];
    expect(resolveAgentModelSelection(selection, 'plan', agents, [{ id: 'q', models: [{ id: 'pinned' }] }])).toEqual({ providerID: 'q', modelID: 'pinned', agent: 'plan' });
    expect(resolveAgentModelSelection(selection, 'plan', agents, [])).toEqual({ ...selection, agent: 'plan' });
  });
});

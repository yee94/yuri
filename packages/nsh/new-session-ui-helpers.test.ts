import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as native from './new-session-ui-helpers';
import * as web from '../ui/src/lib/draftStarters';
import { createProjectIdFromPath } from '../ui/src/lib/projectId';
import { getCycledPrimaryAgentName } from '../ui/src/components/chat/mobileControlsUtils';

const label = (key: string) => key;
const command = (name: string): native.DraftStarterRef => ({ type: 'command', name });
afterEach(() => vi.useRealTimers());

describe('Web starter contract', () => {
  it('uses the same shared Web catalog/defaults/functions, not a parallel native data source', () => {
    expect(native.BUILTIN_STARTERS).toBe(web.BUILTIN_STARTERS);
    expect(native.DEFAULT_GLOBAL_STARTERS).toBe(web.DEFAULT_GLOBAL_STARTERS);
    expect(native.getBuiltInStarter).toBe(web.getBuiltInStarter);
    expect(native.sanitizeStarterRefs).toBe(web.sanitizeStarterRefs);
    expect(native.normalizeStarterLabel).toBe(web.normalizeStarterLabel);
    expect(native.starterKey).toBe(web.starterKey);
    expect(native.globalStarterRefs({})).toEqual(web.DEFAULT_GLOBAL_STARTERS);
    expect(native.globalStarterRefs({ draftStarters: [] })).toEqual([]);
    expect(native.globalStarterRefs({ draftStarters: [{ type: 'command', name: 'weigh' }] })).toEqual([command('weigh')]);
  });
  it.each([null, [], [{ type: 'skill', name: '  plan  ' }, { type: 'skill', name: 'plan' }, { type: 'command', name: 'plan' }], [{ type: 'bad', name: 'x' }, null, 2, { type: 'skill', name: 3 }, { type: 'command', name: '' }]])('sanitizes saved refs like Web: %j', value => {
    expect(native.sanitizeStarterRefs(value)).toEqual(web.sanitizeStarterRefs(value));
  });
  it.each(['/review-code', 'a_b-c', '   ', '中文工具'])('formats custom labels like Web: %s', value => {
    expect(native.normalizeStarterLabel(value)).toBe(web.normalizeStarterLabel(value));
  });
  it('resolves real catalog members only, preserving order and independent scope identities', () => {
    const refs = [command('review'), command('missing'), { type: 'skill', name: 'plan' } as const, command('custom')];
    const global = native.resolveStarters(refs, 'global', [{ name: 'custom' }], [{ name: 'plan' }], label);
    expect(global.map(row => [row.id, row.icon, row.submitText])).toEqual([
      ['global:command:review', 'search-eye', '/workspace-review'], ['global:skill:plan', 'book-open', '@plan'], ['global:command:custom', 'terminal-box', '/custom'],
    ]);
    expect(native.resolveStarters([command('review')], 'project', [], [], label)[0].id).toBe('project:command:review');
  });
  it('offers unpinned built-ins and actual commands/skills with Web scope, excluding skill-source commands', () => {
    const options = native.starterOptions([command('explore')], [{ type: 'skill', name: 'already' }], [
      { name: 'explore' }, { name: 'hidden', isBuiltIn: true }, { name: 'skill-command', source: 'skill' }, { name: 'team-command', scope: 'project' }, { name: 'user-command', scope: 'user' },
    ], [{ name: 'team-skill', scope: 'project' }, { name: 'already' }], label);
    expect(options.some(item => item.ref.name === 'craft-goal' && item.section === 'built-in')).toBe(true);
    expect(options.filter(item => item.section !== 'built-in').map(item => [item.ref.name, item.group])).toEqual([['team-command', 'project'], ['user-command', 'global'], ['team-skill', 'project']]);
    expect(options.some(item => ['explore', 'already', 'hidden', 'skill-command'].includes(item.ref.name))).toBe(false);
  });
  it('uses the same canonical project path ID as Web, including worktree-independent root and Unicode', () => {
    const location = native.projectStarterLocation('/home/user/', '/workspace/项目/');
    expect(location.path).toBe(`/home/user/.config/yuri/projects/${createProjectIdFromPath('/workspace/项目')}.json`);
    expect(location.legacy).toBe('/workspace/项目/.yuri/yuri.json');
    expect(() => native.projectStarterLocation('', '/repo')).toThrow();
    expect(native.projectStarterConfig('')).toEqual({});
    expect(() => native.projectStarterConfig('{broken')).toThrow();
    expect(() => native.projectStarterConfig('[]')).toThrow();
  });
});

it('bundles the new UI helper through only the shared pure modules, with no React, browser API or alias runtime', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), output = mkdtempSync(path.join(tmpdir(), 'nsh-new-session-ui-'));
  try {
    const metafile = path.join(output, 'graph.json');
    const result = spawnSync('bun', ['build', 'packages/nsh/new-session-ui-helpers.ts', '--target=browser', `--outdir=${output}`, `--metafile=${metafile}`], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const modules = JSON.parse(readFileSync(metafile, 'utf8')).inputs as Record<string, { imports: { original?: string; external?: boolean }[] }>;
    expect(Object.keys(modules).sort()).toEqual([
      'packages/nsh/chat-models-helpers.ts', 'packages/nsh/model.ts', 'packages/nsh/new-session-ui-helpers.ts',
      'packages/ui/src/components/chat/mobileControlsUtils.ts', 'packages/ui/src/lib/draftStarters.ts', 'packages/ui/src/lib/modelDisplay.ts', 'packages/ui/src/lib/projectId.ts', 'packages/ui/src/lib/search/modelSearch.ts',
    ]);
    expect(modules['packages/ui/src/lib/draftStarters.ts'].imports).toEqual([]);
    expect(modules['packages/ui/src/lib/projectId.ts'].imports).toEqual([]);
    for (const module of Object.values(modules)) for (const dependency of module.imports) {
      expect(dependency.external).not.toBe(true); expect(dependency.original?.startsWith('@')).not.toBe(true);
    }
  } finally { rmSync(output, { recursive: true, force: true }); }
});

describe('native wrapping drag contract', () => {
  const rects: native.StarterRect[] = [
    { id: 'global:command:z', x: 0, y: 0, width: 80, height: 28 },
    { id: 'global:command:a', x: 82, y: 0, width: 140, height: 28 },
    { id: 'global:command:m', x: 0, y: 30, width: 100, height: 28 },
    { id: 'project:skill:local', x: 102, y: 30, width: 50, height: 28 },
    { id: native.STARTER_TRASH, x: 250, y: 0, width: 24, height: 24 },
  ];
  it('uses 2D center collisions across rows and reaches the same plus-slot trash target', () => {
    expect(native.closestStarter(rects, rects[0], 10, 30)).toBe('global:command:m');
    expect(native.closestStarter(rects, rects[0], 222, -2)).toBe(native.STARTER_TRASH);
  });
  it('previews only translation without stretching, committing a stable-ID reorder only at drop', () => {
    const refs = [command('z'), command('a'), command('m')];
    expect(native.starterTranslation(rects[1].id, rects[0].id, rects[2].id, rects)).toEqual({ x: -82, y: 0 });
    expect(native.starterTranslation(rects[2].id, rects[0].id, rects[2].id, rects)).toEqual({ x: 82, y: -30 });
    expect(native.moveStarter(refs, 'global', rects[0].id, rects[2].id)).toEqual([command('a'), command('m'), command('z')]);
    expect(refs).toEqual([command('z'), command('a'), command('m')]);
    expect(native.moveStarter(refs, 'global', rects[0].id, rects[3].id)).toBe(refs);
    expect(native.starterTranslation(rects[3].id, rects[0].id, rects[2].id, rects)).toEqual({ x: 0, y: 0 });
  });
});

describe('Agent and favorite selection contracts', () => {
  const agents = [{ name: 'build' }, { name: 'plan', model: { providerID: 'p', modelID: 'pinned' } }, { name: 'hidden', mode: 'subagent' }];
  const providers = [{ id: 'p', models: { pinned: { id: 'pinned' }, current: { id: 'current' } } }];
  const selection = { agent: 'build', model: { providerID: 'p', id: 'current', variant: 'high' } };
  it('uses real primary catalog order for short-tap cycling, never identity sort or invented defaults', () => {
    expect(getCycledPrimaryAgentName(agents.map(row => ({ name: row.name, mode: row.mode as 'primary' | 'subagent' | undefined })), 'build')).toBe('plan');
    expect(getCycledPrimaryAgentName([{ name: 'build' }], undefined)).toBeNull();
  });
  it('honors a validated Agent-pinned model and the cycle versus picker variant semantics', () => {
    expect(native.agentDraftSelection(selection, 'plan', agents, providers)).toEqual({ agent: 'plan', model: { providerID: 'p', id: 'pinned', variant: 'high' } });
    expect(native.agentDraftSelection(selection, 'plan', agents, providers, true)).toEqual({ agent: 'plan', model: { providerID: 'p', id: 'pinned' } });
    expect(native.agentDraftSelection(selection, 'plan', agents, [])).toEqual({ ...selection, agent: 'plan' });
    expect(native.agentDraftSelection({}, 'build', agents, providers)).toEqual({ agent: 'build' });
  });
  it('cycles once on short press; opens after 500ms with no extra cycle on release', () => {
    vi.useFakeTimers(); const cycle = vi.fn(), open = vi.fn();
    const press = native.createAgentPress({ enabled: () => true, cycle, open, schedule: work => setTimeout(work, 500), cancelTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) });
    press.down(); vi.advanceTimersByTime(499); press.up(); press.press(); expect(cycle).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled();
    press.down(); vi.advanceTimersByTime(500); press.up(); press.press(); expect(cycle).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(1);
    press.down(); press.cancel(); vi.advanceTimersByTime(500); press.press(); expect(cycle).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(1);
  });
  it('does not open or cycle a disabled/deactivated control', () => {
    vi.useFakeTimers(); let enabled = true; const cycle = vi.fn(), open = vi.fn();
    const press = native.createAgentPress({ enabled: () => enabled, cycle, open, schedule: work => setTimeout(work, 500), cancelTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) });
    press.down(); enabled = false; vi.advanceTimersByTime(500); press.up(); press.press(); expect(cycle).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it('favorite toggle writes only favoriteModels, takes live selected variant, and removes without touching selection/recents', () => {
    const settings = { favoriteModels: [{ providerID: 'other', modelID: 'x' }], recentModels: [{ providerID: 'p', modelID: 'current', variant: 'low' }], unrelated: true };
    const patch = native.favoriteDraftPatch(settings, { providerID: 'p', modelID: 'current' }, selection);
    expect(patch).toEqual({ favoriteModels: [{ providerID: 'p', modelID: 'current', variant: 'high' }, { providerID: 'other', modelID: 'x' }] });
    expect(native.favoriteDraftPatch({ ...settings, ...patch }, { providerID: 'p', modelID: 'current' }, selection)).toEqual({ favoriteModels: [{ providerID: 'other', modelID: 'x' }] });
    expect(settings.recentModels[0].variant).toBe('low'); expect(selection.model.id).toBe('current');
  });
  it('non-selected favorites preserve remembered recent variants rather than copying the current model effort', () => {
    expect(native.favoriteDraftPatch({ recentModels: [{ providerID: 'p', modelID: 'remembered', variant: 'low' }] }, { providerID: 'p', modelID: 'remembered' }, selection)).toEqual({ favoriteModels: [{ providerID: 'p', modelID: 'remembered', variant: 'low' }] });
  });
});

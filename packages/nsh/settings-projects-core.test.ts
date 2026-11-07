import { describe, expect, it } from 'vitest';
import { settingsProjectPatch } from './settings-projects-core';
import { settingsMutation, settingsSkillReadOnly, settingsProviderModelsPatch } from './settings-protocol';

describe('native project settings mutation', () => {
  const selected = { id: 'a', path: '/fixture/a', label: 'Old', iconImage: { updatedAt: 1 }, defaultModel: 'p/m', extension: { enabled: true } };
  const unrelated = { id: 'b', path: '/fixture/b', label: 'Other', order: 7 };
  const snapshot = { projects: [selected, unrelated], activeProjectId: 'b', privateHostSetting: true };
  it('patches allowed fields into the fresh collection without serializing unrelated settings', () => {
    const result = settingsProjectPatch(snapshot, 'a', { label: ' New ', icon: 'code', color: 'keyword', iconBackground: ' #ABC ', defaultModel: 'p/m', activeProjectId: 'a', path: '/wrong', extension: null });
    expect(Object.keys(result)).toEqual(['projects']);
    expect(result.projects[0]).toEqual({ ...selected, label: 'New', icon: 'code', color: 'keyword', iconBackground: '#abc' });
    expect(result.projects[1]).toBe(unrelated);
    expect(snapshot.projects[0]).toBe(selected);
  });
  it('clears an inherited default without dropping custom image metadata', () => {
    const result = settingsProjectPatch(snapshot, 'a', { defaultModel: null, icon: null, color: null, iconBackground: null });
    expect(result.projects[0]).toEqual({ id: 'a', path: '/fixture/a', label: 'Old', iconImage: { updatedAt: 1 }, extension: { enabled: true }, icon: null, color: null, iconBackground: null });
  });
  it('does not recreate a removed project or convert a malformed collection to empty success', () => {
    expect(() => settingsProjectPatch({ projects: [] }, 'a', { label: 'New' })).toThrow('no longer exists');
    expect(() => settingsProjectPatch({}, 'a', { label: 'New' })).toThrow('Invalid settings collection');
  });
  it.each([{ label: ' ' }, { icon: 'unknown' }, { color: '#ffffff' }, { iconBackground: 'red' }, { defaultModel: 'model-only' }])('rejects invalid metadata without mutating the snapshot: %j', changes => {
    expect(() => settingsProjectPatch(snapshot, 'a', changes)).toThrow();
    expect(snapshot.projects).toEqual([selected, unrelated]);
  });
});

describe('native built-in skill write guard', () => {
  it('recognizes both collection and detail identities and refuses constructing a write', () => {
    expect(settingsSkillReadOnly({ path: '<built-in>' })).toBe(true);
    expect(settingsSkillReadOnly({ targetPath: '<built-in>' })).toBe(true);
    expect(settingsSkillReadOnly({ path: '/fixture/SKILL.md' })).toBe(false);
    expect(() => settingsMutation('skills.installed', 'builtin', { targetPath: '<built-in>', instructions: 'write' }, false)).toThrow('read-only');
  });
});

describe('native Provider model add/remove preference', () => {
  const unrelated = { providerID: 'other', modelID: 'b' };
  const snapshot = { hiddenModels: [{ providerID: 'fixture', modelID: 'a' }, unrelated], privateHostSetting: true };
  it('adds a model back without erasing another provider and keeps the patch narrow', () => {
    expect(settingsProviderModelsPatch(snapshot, 'fixture', ['a'], true)).toEqual({ hiddenModels: [unrelated] });
  });
  it('removes all selected models with no duplicated hidden identities', () => {
    expect(settingsProviderModelsPatch(snapshot, 'fixture', ['a', 'a', 'c'], false)).toEqual({ hiddenModels: [unrelated, { providerID: 'fixture', modelID: 'a' }, { providerID: 'fixture', modelID: 'c' }] });
  });
  it('never treats malformed preferences or failed settings reads as an empty set', () => {
    expect(() => settingsProviderModelsPatch({ hiddenModels: {} }, 'fixture', ['a'], true)).toThrow();
    expect(() => settingsProviderModelsPatch({ hiddenModels: [{}] }, 'fixture', ['a'], false)).toThrow();
    expect(() => settingsProviderModelsPatch({ success: false }, 'fixture', ['a'], true)).toThrow();
  });
});

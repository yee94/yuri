import { describe, expect, it } from 'vitest';
import { createSettingsArchiveRestore, type SettingsRequestLane } from './settings-protocol';
import { createMagicPromptsEditor } from './settings-magic-state';
import { nativeMagicDefaults } from './settings-magic-defaults';
import { createProjectSettingsEditor } from './project-settings';
import { createSettingsUsage } from './settings-usage-core';
import { createRetentionController } from './settings-retention-controller';
import { createVoiceModelManager, voiceLocalModels } from './settings-voice-models-core';

const flush = async () => { for (let index = 0; index < 80; index++) await Promise.resolve(); };
function transport(respond: (path: string, method: string, body: unknown) => Promise<unknown>) {
  let generation = 1;
  const calls: Array<{ generation: number; path: string; method: string; body: unknown }> = [];
  const capture = (): SettingsRequestLane => {
    const captured = generation;
    const current = () => captured === generation;
    return { current, request: async (path, method = 'GET', body) => {
      if (!current()) throw new Error('Retired synthetic lane');
      calls.push({ generation: captured, path, method, body });
      const value = await respond(path, method, body);
      if (!current()) throw new Error('Retired synthetic lane');
      return value;
    } };
  };
  return { calls, capture, retire: () => { generation++; } };
}

describe('retained Settings controller lanes', () => {
  it.each([['reset', false], ['all', false], ['reset', true], ['all', true]] as const)('Magic %s completes draft cleanup only for edits captured before the background boundary (newer=%s)', async (kind, newer) => {
    const id = 'git.commit.generate.visible';
    let overrides: Record<string, string> = { [id]: 'Host override' };
    const wire = transport(async (_path, method) => {
      if (method === 'DELETE') { overrides = {}; throw new Error('Synthetic lost reset ACK'); }
      expect(method).toBe('GET'); return { version: 1, overrides };
    });
    const initial = wire.capture(), owner = createMagicPromptsEditor(initial.request, initial.current, () => {});
    await owner.load(); owner.setDraft(id, 'unsaved');
    if (kind === 'all') await owner.resetAll(); else await owner.reset(id);
    wire.retire(); owner.replaceLane(null); owner.replaceLane(wire.capture());
    if (newer) owner.setDraft(id, 'unsaved');
    await owner.load();
    expect(owner.value(id)).toBe(newer ? 'unsaved' : nativeMagicDefaults[id]);
    if (kind === 'all' && !newer) expect(owner.snapshot().drafts).toEqual({});
    expect(wire.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });
  it('Magic keeps an unknown submission and both drafts; new-lane load reads without repeating PUT', async () => {
    const id = 'git.commit.generate.visible', other = 'git.commit.generate.instructions';
    let overrides: Record<string, string> = {};
    const wire = transport(async (_path, method, body) => {
      if (method === 'PUT') { overrides = { [id]: (body as { text: string }).text }; throw new Error('Synthetic lost ACK'); }
      expect(method).toBe('GET'); return { version: 1, overrides };
    });
    const initial = wire.capture(), owner = createMagicPromptsEditor(initial.request, initial.current, () => {});
    await owner.load(); owner.setDraft(id, 'retained visible'); owner.setDraft(other, 'retained instructions'); await owner.save(id);
    wire.retire(); owner.replaceLane(null); owner.replaceLane(wire.capture()); await owner.load();
    expect(owner.snapshot().drafts).toEqual({ [id]: 'retained visible', [other]: 'retained instructions' });
    expect(owner.snapshot().overrides).toEqual({ [id]: 'retained visible' });
    expect(wire.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    expect(wire.calls.at(-1)).toMatchObject({ generation: 2, method: 'GET' });
  });

  it('Project resume reconciles acknowledged setup without losing newer commands or their input identities', async () => {
    let file: Record<string, unknown> = { 'setup-worktree': ['initial'] }, written = false, failRead = false;
    const wire = transport(async (path, method, body) => {
      if (path === '/api/fs/home') return { home: '/synthetic-home' };
      if (method === 'POST') { file = JSON.parse((body as { content: string }).content); written = true; failRead = true; return { success: true }; }
      if (failRead) throw new Error('Synthetic failed readback');
      return JSON.stringify(file);
    });
    const initial = wire.capture(), owner = createProjectSettingsEditor(initial.request, initial.current, { id: 'project', path: '/actual/project' }, () => {});
    await owner.load(); const ids = owner.snapshot().commandIDs;
    owner.updateCommand(ids[0], 'submitted'); await owner.save('setup'); expect(written).toBe(true);
    owner.updateCommand(ids[0], 'newer local command');
    wire.retire(); owner.replaceLane(null); failRead = false; owner.replaceLane(wire.capture()); await owner.resume();
    expect(owner.snapshot()).toMatchObject({ commands: ['newer local command'], commandIDs: ids, pending: null });
    expect(owner.snapshot().commandIDs).toBe(ids);
    expect(owner.dirty('setup')).toBe(true); expect(owner.autoSaveAllowed('setup')).toBe(false);
    expect(wire.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('Usage preserves selection, drafts and recovery intent while new authority only reads', async () => {
    let settings: Record<string, unknown> = { usageDisplayMode: 'usage' }, fail = false;
    const wire = transport(async (path, method, body) => {
      if (path.startsWith('/api/quota/magpie')) return { sources: [] };
      expect(path).toBe('/api/config/settings');
      if (method === 'PUT') { settings = { ...settings, ...body as object }; fail = true; return { success: true }; }
      if (fail) throw new Error('Synthetic failed Usage readback'); return settings;
    });
    const initial = wire.capture(), owner = createSettingsUsage({ send: initial.request, current: initial.current, providers: [], selectedProviderId: 'google', defaultsEnabled: true, displayClock: false });
    owner.setActive(true); await owner.refresh(); await owner.setPreference({ usageDisplayMode: 'remaining' });
    expect(owner.state().draft).toEqual({ usageDisplayMode: 'remaining' });
    wire.retire(); owner.replaceLane(null); fail = false; owner.replaceLane(wire.capture()); owner.setActive(true); await owner.refresh();
    expect(owner.state()).toMatchObject({ settings: { usageDisplayMode: 'remaining' }, draft: null, recovery: false, writing: false, refreshing: false, selectedProviderId: 'google' });
    expect(wire.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    expect(wire.calls.filter(call => call.generation === 2).every(call => call.method === 'GET')).toBe(true);
    owner.dispose();
  });

  it('Retention retains a failed preference readback and resumes through GET with no automatic save', async () => {
    const preferences = { autoDeleteEnabled: false, autoDeleteAfterDays: 35, sessionRetentionAction: 'archive' as const };
    let host: Record<string, unknown> = {}, fail = false;
    const wire = transport(async (_path, method, body) => {
      if (method === 'PUT') { host = body as Record<string, unknown>; fail = true; return {}; }
      if (fail) throw new Error('Synthetic Retention read failure'); return host;
    });
    const initial = wire.capture(), storage = new Map<string, string>();
    const owner = createRetentionController({ send: initial.request, current: initial.current, scope: 'synthetic-host', protectedIDs: () => new Set(), storage: { getItem: async key => storage.get(key) ?? null, setItem: async (key, value) => { storage.set(key, value); } } });
    await owner.load(); await owner.save(preferences); expect(owner.snapshot().hostSynced).toBe(false);
    wire.retire(); owner.replaceLane(null); fail = false; owner.replaceLane(wire.capture()); await owner.resume();
    expect(owner.snapshot()).toMatchObject({ preferences, hostSynced: true, busy: false });
    expect(wire.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    expect(wire.calls.at(-1)).toMatchObject({ generation: 2, method: 'GET' });
  });

  it('archive and download unknown operations remain read-only on their replacement lanes', async () => {
    let archived = true;
    const archiveWire = transport(async (_path, method) => {
      if (method === 'PUT') { archived = false; throw new Error('Synthetic lost restore reply'); }
      return { id: 'session', directory: '/actual/project', time: { archived: archived ? 1 : 0 } };
    });
    const first = archiveWire.capture(), restore = createSettingsArchiveRestore(first.request, first.current);
    const session = { id: 'session', directory: '/actual/project' };
    await expect(restore(session)).rejects.toThrow('Synthetic');
    archiveWire.retire(); restore.replaceLane(archiveWire.capture()); await restore(session);
    expect(archiveWire.calls.map(call => call.method)).toEqual(['PUT', 'GET']);
    const id = voiceLocalModels[0].id;
    const downloadWire = transport(async (_path, method) => {
      if (method === 'POST') throw new Error('Synthetic unknown download');
      return { provider: 'local', models: [{ id, installed: false, downloading: false, downloadProgress: null, downloadError: null }], ttsModels: [] };
    });
    const downloadLane = downloadWire.capture(), manager = createVoiceModelManager({ send: downloadLane.request, current: downloadLane.current, changed() {} });
    manager.activate(true); await flush(); await manager.mutate(id, 'POST');
    downloadWire.retire(); manager.replaceLane(downloadWire.capture()); manager.activate(true); await flush(); await manager.mutate(id, 'POST');
    expect(downloadWire.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(downloadWire.calls.filter(call => call.generation === 2).every(call => call.method === 'GET')).toBe(true);
    manager.dispose();
  });

  it('an explicit rejected download with idle status does not strand a receipt or prevent user retry', async () => {
    const id = voiceLocalModels[0].id;
    const wire = transport(async (_path, method) => method === 'POST' ? { ok: false, error: 'Synthetic rejection' } : { provider: 'local', models: [{ id, installed: false, downloading: false, downloadProgress: null, downloadError: null }], ttsModels: [] });
    const lane = wire.capture(), manager = createVoiceModelManager({ send: lane.request, current: lane.current, changed() {} });
    manager.activate(true); await flush(); await manager.mutate(id, 'POST');
    expect(manager.snapshot().operationError?.message).toBe('Synthetic rejection');
    await manager.mutate(id, 'POST');
    expect(wire.calls.filter(call => call.method === 'POST')).toHaveLength(2);
    manager.dispose();
  });
});

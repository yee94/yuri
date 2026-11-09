import { describe, expect, it } from 'vitest';
import { createFeaturePicker } from './features-picker-core';

describe('editor model picker local selection and preferences', () => {
  it('selects locally once, then retries only the unconfirmed recent preference by GET', async () => {
    const selected: unknown[] = [], calls: string[] = []; let settings: Record<string, unknown> = {}, lost = true;
    const picker = createFeaturePicker({ current: () => true, changed: () => {}, select: value => { selected.push(value); }, close: () => {}, request: async (_path, method = 'GET', body) => {
      calls.push(method); if (method === 'PUT') { settings = { ...settings, ...body as object }; if (lost) throw new Error('ACK lost'); }
      return settings;
    } });
    await picker.load(); await picker.choose({ providerID: 'p', modelID: 'm', variant: 'high' });
    expect(selected).toHaveLength(1); expect(picker.error()).not.toBe('');
    lost = false; await picker.retry();
    expect(selected).toHaveLength(1); expect(calls.filter(method => method === 'PUT')).toHaveLength(1);
    expect(picker.error()).toBe('');
  });
  it('favorites use the current variant and unknown preference outcomes cannot toggle twice', async () => {
    const writes: unknown[] = []; let settings: Record<string, unknown> = {};
    const picker = createFeaturePicker({ current: () => true, changed: () => {}, select: () => {}, close: () => {}, request: async (_path, method = 'GET', body) => {
      if (method === 'PUT') { writes.push(body); settings = { ...settings, ...body as object }; throw new Error('lost'); } return settings;
    } });
    await picker.load(); await picker.favorite({ providerID: 'p', modelID: 'm', variant: '' }); await picker.favorite({ providerID: 'p', modelID: 'm' });
    expect(writes).toEqual([{ favoriteModels: [{ providerID: 'p', modelID: 'm', variant: '' }] }]);
    await picker.retry(); expect(writes).toHaveLength(1); expect(picker.pending()).toBe(false);
  });
  it('preserves preferences on failed refresh and fences retired Hosts', async () => {
    let current = true, fail = false;
    const picker = createFeaturePicker({ current: () => current, changed: () => {}, select: () => { throw new Error('stale select'); }, close: () => {}, request: async () => { if (fail) throw new Error('offline'); return { favoriteModels: [{ providerID: 'p', modelID: 'm' }] }; } });
    await picker.load(); const prior = picker.preferences(); fail = true; await picker.load(); expect(picker.preferences()).toBe(prior);
    current = false; await picker.choose({ providerID: 'p', modelID: 'm' });
    expect(picker.error()).toContain('offline');
  });
  it('a failed preference pre-read retries that preference only, without applying draft selection twice', async () => {
    let reads = 0; const writes: unknown[] = [], selected: unknown[] = [];
    const picker = createFeaturePicker({ current: () => true, changed: () => {}, close: () => {}, select: value => selected.push(value), request: async (_path, method = 'GET', body) => { if (method === 'GET' && ++reads === 2) throw new Error('offline before write'); if (method === 'PUT') writes.push(body); return {}; } });
    await picker.load(); await picker.choose({ providerID: 'p', modelID: 'm' });
    expect(selected).toHaveLength(1); expect(writes).toHaveLength(0);
    await picker.retry(); expect(selected).toHaveLength(1); expect(writes).toHaveLength(1); expect(picker.pending()).toBe(false);
  });
});

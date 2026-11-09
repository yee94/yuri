import { expect, it } from 'vitest';
import { featurePickerFixture } from './tests/features-picker-fixture';
import { settle } from './tests/features-fixture';
import { record } from './model';

it.each([50, 100, 105, 200])('closing and reopening at %s%% after a preference pre-read failure retains the original local selection and retry', async padding => {
  let reads = 0; const writes: unknown[] = [];
  const fixture = featurePickerFixture(async (_path, method = 'GET', body) => {
    if (method === 'GET' && ++reads === 2) throw new Error('pre-write read offline');
    if (method === 'PUT') writes.push(body);
    return {};
  }, padding);
  fixture.open(); await settle(); fixture.choose(); await settle();
  expect(fixture.contentStyle()).toEqual({ paddingHorizontal: 8 * Math.sqrt(padding / 100), paddingBottom: 24 * Math.sqrt(padding / 100), gap: 8 * Math.sqrt(padding / 100) });
  expect(fixture.selections).toHaveLength(1); expect(writes).toHaveLength(0);
  fixture.close(); fixture.open(); await settle(); fixture.retry(); await settle();
  expect(fixture.selections).toEqual([{ providerID: 'p', modelID: 'm', variant: 'high' }]);
  expect(writes).toEqual([{ recentModels: [{ providerID: 'p', modelID: 'm', variant: 'high' }] }]);
  fixture.dispose();
});

it('closing and reopening retains the exact unknown favorite patch and reconciles it by GET only', async () => {
  let settings: Record<string, unknown> = {}, reads = 0; const writes: unknown[] = [];
  const fixture = featurePickerFixture(async (_path, method = 'GET', body) => {
    if (method === 'PUT') { writes.push(body); throw new Error('favorite ACK unknown'); }
    reads++; return settings;
  });
  fixture.open(); await settle(); fixture.favorite(); await settle();
  expect(writes).toEqual([{ favoriteModels: [{ providerID: 'p', modelID: 'm', variant: 'high' }] }]);
  expect(fixture.dismissible()).toBe(true);
  fixture.close(); fixture.open(); await settle();
  expect.soft(reads).toBe(2); expect.soft(fixture.favoriteDisabled()).toBe(true);
  settings = { favoriteModels: [{ providerID: 'p', modelID: 'm', variant: 'low' }] };
  fixture.retry(); await settle(); expect.soft(fixture.favoriteDisabled()).toBe(true); expect(writes).toHaveLength(1);
  settings = record(writes[0]); fixture.retry(); await settle();
  expect(fixture.favoriteDisabled()).toBe(false); expect(writes).toHaveLength(1); expect(fixture.selections).toHaveLength(0);
  fixture.dispose();
});

it.each([50, 100, 105, 200])('retiring the captured editor generation at %s%% fences a closed in-flight pre-read even if props are rebound', async padding => {
  let reads = 0, finish: ((value: unknown) => void) | undefined; const writes: unknown[] = [];
  const fixture = featurePickerFixture(async (_path, method = 'GET', body) => {
    if (method === 'PUT') { writes.push(body); return {}; }
    if (++reads === 2) return new Promise(resolve => { finish = resolve; });
    return {};
  }, padding);
  fixture.open(); await settle(); fixture.choose(); await settle();
  fixture.close(); fixture.retire(true); finish?.({}); await settle(); fixture.open(); await settle(); fixture.retry(); await settle();
  expect(fixture.visible()).toBe(false); expect(reads).toBe(2); expect(writes).toHaveLength(0); expect(fixture.selections).toHaveLength(1);
  fixture.dispose();
});

it('a late ACK from a closed presentation does not close the newly reopened sheet or replay selection', async () => {
  let reads = 0, finish: ((value: unknown) => void) | undefined; const writes: unknown[] = [];
  const fixture = featurePickerFixture(async (_path, method = 'GET', body) => {
    if (method === 'PUT') { writes.push(body); return new Promise(resolve => { finish = resolve; }); }
    reads++; return {};
  });
  fixture.open(); await settle(); fixture.choose(); await settle();
  fixture.close(); fixture.open(); await settle();
  expect.soft(reads).toBe(2); expect.soft(fixture.modelDisabled()).toBe(true);
  finish?.({}); await settle();
  expect(fixture.visible()).toBe(true); expect(fixture.modelDisabled()).toBe(false);
  expect(writes).toHaveLength(1); expect(fixture.selections).toHaveLength(1);
  fixture.dispose();
});

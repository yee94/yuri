import { expect, it } from 'vitest';
import { createHost } from './appearance-settings-host';

const expectedHost = { hostID: 'fixture', lease: '00000000-0000-4000-8000-000000000001' };
const identity = (mode: 'light' | 'dark' | 'system') => ({
  themeId: mode === 'dark' ? 'jetbrains-dark' : 'jetbrains-light',
  themeVariant: mode === 'dark' ? 'dark' : 'light', useSystemTheme: mode === 'system',
  lightThemeId: 'jetbrains-light', darkThemeId: 'jetbrains-dark',
});
const audit = (host: ReturnType<typeof createHost>) => host.call('runtime.request', { expectedHost, path: '/fixture/appearance/audit', method: 'GET' });

it.each(['POST', 'PATCH', 'DELETE', 'HEAD', 'get', 'put', undefined])('settings fixture rejects unsupported method %s without changing state or audit', method => {
  const host = createHost(), before = audit(host);
  expect(() => host.call('runtime.request', { expectedHost, path: '/api/config/settings', method })).toThrow();
  expect(audit(host)).toEqual(before);
});

it('settings fixture rejects a GET body and malformed PUT before counting attempts', () => {
  const host = createHost(), before = audit(host);
  for (const body of [{}, identity('light')]) {
    expect(() => host.call('runtime.request', { expectedHost, path: '/api/config/settings', method: 'GET', body })).toThrow();
  }
  const invalid = [
    undefined, {}, { ...identity('light'), extra: true },
    { ...identity('light'), themeId: 'jetbrains-dark' },
    { ...identity('dark'), themeId: 'jetbrains-light' },
    { ...identity('system'), themeVariant: 'dark', themeId: 'jetbrains-dark' },
    { ...identity('light'), themeVariant: 'system' },
    { ...identity('light'), useSystemTheme: 'false' },
    { ...identity('light'), useSystemTheme: null },
    { ...identity('light'), lightThemeId: 'other-light' },
    { ...identity('dark'), darkThemeId: 'other-dark' },
  ];
  for (const body of invalid) {
    expect(() => host.call('runtime.request', { expectedHost, path: '/api/config/settings', method: 'PUT', body })).toThrow();
    expect(audit(host)).toEqual(before);
  }
});

it('fixture advertises its light system scheme and round-trips exact System, Dark and Light identities with one PUT each', () => {
  const host = createHost();
  expect(host.call('appearance.apply', {})).toMatchObject({ systemColorScheme: 'light' });
  let attempts = 0;
  for (const mode of ['system', 'dark', 'light'] as const) {
    const body = identity(mode);
    expect(host.call('runtime.request', { expectedHost, path: '/api/config/settings', method: 'PUT', body })).toMatchObject({ status: 200 });
    expect(host.call('runtime.request', { expectedHost, path: '/api/config/settings', method: 'GET' })).toMatchObject({ status: 200, body });
    expect(audit(host)).toMatchObject({ body: { attempts: ++attempts, reads: attempts, confirmationReads: attempts, ...body } });
  }
});

it('first Light rejection preserves full dark identity; explicit GET never acknowledges or repeats the PUT', () => {
  const host = createHost();
  expect(host.call('runtime.request', { expectedHost, path: '/api/config/settings', method: 'PUT', body: identity('light') })).toMatchObject({ status: 409 });
  for (let reads = 1; reads <= 2; reads++) {
    expect(host.call('runtime.request', { expectedHost, path: '/api/config/settings', method: 'GET' })).toMatchObject({ status: 200, body: identity('dark') });
    expect(audit(host)).toMatchObject({ body: { attempts: 1, reads, confirmationReads: reads, ...identity('dark') } });
  }
});

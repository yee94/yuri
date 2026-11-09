import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { OPEN_IN_APPS } from '../ui/src/lib/openInApps';
import { createDesktopOpenInApps, desktopOpenInAppsCapabilities, desktopOpenInAppsSnapshot, type DesktopOpenInAppsTarget } from './desktop-open-in-apps';
import type { DesktopChatHeaderAction, DesktopChatHeaderIntent } from './desktop-chat-header-core';

const caps = { version: 1, platform: 'macos', discovery: { supported: true, source: 'workspace' },
  selection: { supported: true, persistence: 'process' }, open: { supported: false, reason: 'local_directory_mapping_unavailable' } };
const snapshot = (apps = [{ id: 'finder', label: 'Finder' }, { id: 'vscode', label: 'VS Code' }], selectedID = 'finder', revision = 0) =>
  ({ version: 1, revision, apps, selectedID, scanning: false, stale: false, error: null });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup() {
  const scope = {};
  let target: DesktopOpenInAppsTarget | null = { scope, directory: '/synthetic/actual', expectedHost: { hostID: 'local', lease: 'native-test-lease' } };
  let alive = true;
  const calls: [string, Record<string, unknown>][] = [];
  let response: (name: string, body: Record<string, unknown>) => unknown | Promise<unknown> = name => name.endsWith('capabilities') ? caps : snapshot();
  const copied: string[] = [];
  const owner = createDesktopOpenInApps({ current: () => alive, target: () => target,
    async call(name, body) { calls.push([name, body]); return response(name, body); },
    async copyPath(path, current) { if (!current()) return { status: 'stale' }; copied.push(path); return { status: 'accepted' }; } });
  const intent = (action: DesktopChatHeaderAction, value?: string): DesktopChatHeaderIntent => ({ action, scope, value, current: () => alive });
  return { owner, calls, copied, intent, respond(fn: typeof response) { response = fn; },
    move(value: Partial<DesktopOpenInAppsTarget>) { target = { ...target!, ...value }; }, retire() { alive = false; }, clearTarget() { target = null; } };
}

describe('native OpenInApps producer', () => {
  it('reads real native metadata once per explicit read, never scans during 50 projections/input-like updates', async () => {
    const h = setup();
    const one = h.owner.read(), two = h.owner.read();
    expect(one).toBe(two); expect(await one).toEqual({ status: 'accepted' });
    const projection = h.owner.project();
    for (let i = 0; i < 50; i++) { expect(h.owner.project()).toBe(projection); expect(h.owner.actions['open-app']?.available).toBe(false); }
    expect(h.calls.map(([name]) => name)).toEqual(['desktop.openInApps.capabilities', 'desktop.openInApps.read']);
    expect(h.owner.project()).toMatchObject({ applicable: false, selectedID: 'finder', scanning: false });
    expect(await h.owner.run(h.intent('open-app', 'finder'))).toEqual({ status: 'unsupported' });
    expect(h.calls).toHaveLength(2);
  });
  it('scan is explicit/single-flight, failed refresh preserves prior, empty success clears only catalog', async () => {
    const h = setup(); await h.owner.read();
    const pending = deferred<unknown>(); h.respond(() => pending.promise);
    const one = h.owner.run(h.intent('scan-apps')), two = h.owner.run(h.intent('scan-apps'));
    expect(h.owner.project().scanning).toBe(true);
    await Promise.resolve();
    expect(h.calls.filter(([name]) => name.endsWith('.scan'))).toHaveLength(1);
    pending.reject(new Error('synthetic'));
    expect(await one).toEqual({ status: 'failed' }); expect(await two).toEqual({ status: 'failed' });
    expect(h.owner.project()).toMatchObject({ selectedID: 'finder', stale: true, scanning: false });
    expect(h.owner.snapshot?.apps).toHaveLength(2);
    h.respond(() => snapshot([], 'unavailable-preference'));
    expect(await h.owner.run(h.intent('scan-apps'))).toEqual({ status: 'accepted' });
    expect(h.owner.snapshot?.selectedID).toBe('unavailable-preference');
    expect(h.owner.project()).toMatchObject({ apps: [], selectedID: undefined, stale: false });
  });
  it('Web selection fallback never overwrites an unknown preference; selecting never guesses an open grant', async () => {
    const h = setup(); h.respond(name => name.endsWith('capabilities') ? caps : snapshot(undefined, 'missing-app'));
    await h.owner.read(); expect(h.owner.project().selectedID).toBe('finder');
    expect(h.owner.snapshot?.selectedID).toBe('missing-app');
    expect(await h.owner.run(h.intent('select-app', 'unknown'))).toEqual({ status: 'unsupported' });
    h.respond(() => snapshot(undefined, 'vscode'));
    expect(await h.owner.run(h.intent('select-app', 'vscode'))).toEqual({ status: 'unsupported' });
    expect(h.owner.snapshot?.selectedID).toBe('vscode');
    expect(h.calls.at(-1)).toEqual(['desktop.openInApps.select', { appID: 'vscode' }]);
    expect(h.calls.some(([name]) => name.endsWith('.open'))).toBe(false);
  });
  it.each(['directory', 'host', 'lease', 'scope', 'retire'] as const)('drops late scan after captured %s changes', async kind => {
    const h = setup(); await h.owner.read(); const prior = h.owner.snapshot;
    const pending = deferred<unknown>(); h.respond(() => pending.promise);
    const work = h.owner.run(h.intent('scan-apps'));
    if (kind === 'directory') h.move({ directory: '/synthetic/other' });
    if (kind === 'host') h.move({ expectedHost: { hostID: 'remote', lease: 'native-test-lease' } });
    if (kind === 'lease') h.move({ expectedHost: { hostID: 'local', lease: 'new-native-lease' } });
    if (kind === 'scope') h.move({ scope: {} });
    if (kind === 'retire') h.retire();
    pending.resolve(snapshot([])); expect(await work).toEqual({ status: 'stale' });
    expect(h.owner.snapshot).toBe(prior);
  });
  it('copy uses only captured actual directory, without native application I/O', async () => {
    const h = setup(); expect(await h.owner.run(h.intent('copy-path'))).toEqual({ status: 'accepted' });
    expect(h.copied).toEqual(['/synthetic/actual']); expect(h.calls).toEqual([]);
    h.clearTarget(); expect(await h.owner.run(h.intent('copy-path'))).toEqual({ status: 'stale' });
  });
  it('unknown/future capabilities never upgrade support, and malformed metadata never clears prior', async () => {
    expect(() => desktopOpenInAppsCapabilities({ ...caps, open: { supported: true } })).toThrow();
    expect(() => desktopOpenInAppsCapabilities({ ...caps, platform: 'windows' })).toThrow();
    expect(() => desktopOpenInAppsSnapshot({ ...snapshot(), apps: [{ id: 'finder', label: 'A' }, { id: 'finder', label: 'B' }] })).toThrow();
    const h = setup(); await h.owner.read(); const prior = h.owner.snapshot;
    h.respond(() => ({ success: true, apps: [] }));
    expect(await h.owner.run(h.intent('scan-apps'))).toEqual({ status: 'failed' }); expect(h.owner.snapshot).toBe(prior);
  });
  it('late read/scan replies cannot overwrite a newer native selection revision', async () => {
    const h = setup(); await h.owner.read();
    const pending = deferred<unknown>();
    h.respond(name => name.endsWith('.scan') ? pending.promise : snapshot(undefined, 'vscode', 3));
    const scan = h.owner.run(h.intent('scan-apps')); await Promise.resolve();
    expect(await h.owner.run(h.intent('select-app', 'vscode'))).toEqual({ status: 'unsupported' });
    pending.resolve(snapshot(undefined, 'finder', 2)); await scan;
    expect(h.owner.snapshot?.selectedID).toBe('vscode');
    expect(h.owner.snapshot?.revision).toBe(3);
  });
  it('unknown selection receipt keeps prior metadata and never retries or launches', async () => {
    const h = setup(); await h.owner.read(); const prior = h.owner.snapshot;
    h.respond(() => { throw new Error('synthetic lost reply'); });
    expect(await h.owner.run(h.intent('select-app', 'vscode'))).toEqual({ status: 'unknown' });
    expect(h.owner.snapshot).toBe(prior);
    expect(h.calls.map(([name]) => name)).toEqual(['desktop.openInApps.capabilities', 'desktop.openInApps.read', 'desktop.openInApps.select']);
  });
  it('synchronous transport failure releases read/scan flight so explicit retry remains possible', async () => {
    const h = setup(); h.respond(() => { throw new Error('synthetic'); });
    expect(await h.owner.read()).toEqual({ status: 'unsupported' });
    h.respond(name => name.endsWith('capabilities') ? caps : snapshot());
    expect(await h.owner.read()).toEqual({ status: 'accepted' });
    h.respond(() => { throw new Error('synthetic'); });
    expect(await h.owner.run(h.intent('scan-apps'))).toEqual({ status: 'failed' });
    h.respond(() => snapshot());
    expect(await h.owner.run(h.intent('scan-apps'))).toEqual({ status: 'accepted' });
  });
  it('native candidate ids/order match Web exactly and manifest declares only five narrow methods', () => {
    const native = readFileSync('packages/nsh/desktop-host/src/open_in_apps.rs', 'utf8');
    const table = native.split('pub const CANDIDATES:')[1].split('];')[0];
    const ids = [...table.matchAll(/\(\s*"([a-z0-9-]+)"\s*,/g)].map(match => match[1]);
    expect(ids).toEqual(OPEN_IN_APPS.map(app => app.id));
    const manifest = JSON.parse(readFileSync('packages/nsh/nsh.json', 'utf8'));
    expect(manifest.capabilities.host.filter((name: string) => name.startsWith('desktop.openInApps.')))
      .toEqual(['capabilities', 'read', 'scan', 'select', 'open'].map(name => `desktop.openInApps.${name}`));
    expect(manifest.capabilities.filesystem).toBeUndefined();
  });
});

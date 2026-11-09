import { describe, expect, it } from 'vitest';
import { createDesktopLayoutPersistence, desktopLayoutFrom, desktopWorkspaceGeometry, type DesktopLayout } from './desktop-layout-core';

describe('native desktop layout', () => {
  it('restores bounded geometry without accepting metadata or malformed numbers', () => {
    expect(desktopLayoutFrom({ sidebarWidth: Infinity, panelWidth: 9999, terminalHeight: -1, sidebarOpen: 'false', token: 'not-stored' })).toEqual({
      sidebarWidth: 260, sidebarOpen: true, panelWidth: 1400, panelOpen: false, panelExpanded: false,
      terminalHeight: 120, terminalOpen: false, terminalExpanded: false,
    });
  });
  it('uses the Web 350pt minimum and restores the split without losing its width', () => {
    const layout = desktopLayoutFrom({ panelOpen: true, panelWidth: 600 });
    expect(desktopWorkspaceGeometry(1209, layout)).toMatchObject({ panel: 949, contentVisible: false });
    expect(desktopWorkspaceGeometry(1210, layout)).toMatchObject({ panel: 600, contentVisible: true });
    expect(desktopWorkspaceGeometry(1600, { ...layout, panelExpanded: true })).toMatchObject({ panel: 1340, contentVisible: false });
    expect(desktopWorkspaceGeometry(1600, layout)).toMatchObject({ panel: 600, contentVisible: true });
  });
  it('keeps later user interaction when a storage read completes late', async () => {
    let resolve!: (value: string) => void;
    let adopted: DesktopLayout | undefined;
    const persisted: string[] = [];
    const owner = createDesktopLayoutPersistence({ getItem: () => new Promise<string>(done => { resolve = done; }), setItem: async (_key, value) => { persisted.push(value); } }, value => { adopted = value; }, () => {});
    const restoring = owner.restore();
    await owner.set({ sidebarOpen: false });
    resolve(JSON.stringify({ sidebarOpen: true, panelOpen: true }));
    await restoring;
    expect(adopted?.sidebarOpen).toBe(false);
    expect(JSON.parse(persisted[0]!).panelOpen).toBe(false);
  });
  it('serializes writes and exposes failures without rolling back usable geometry', async () => {
    const adopted: DesktopLayout[] = [], failures: unknown[] = [], persisted: string[] = [];
    let fail = true;
    const owner = createDesktopLayoutPersistence({ getItem: async () => null, setItem: async (_key, value) => { if (fail) throw new Error('disk'); persisted.push(value); } }, value => adopted.push(value), error => failures.push(error));
    await owner.set({ sidebarWidth: 420 });
    expect(adopted.at(-1)?.sidebarWidth).toBe(420);
    expect(failures).toHaveLength(1);
    fail = false;
    await owner.retry();
    await Promise.all([owner.set({ panelWidth: 700 }), owner.set({ panelWidth: 800 })]);
    expect(persisted.map(value => JSON.parse(value).panelWidth)).toEqual([600, 700, 800]);
  });
  it('does not publish a restore or persistence failure after disposal', async () => {
    let resolve!: (value: string) => void;
    const adopted: DesktopLayout[] = [], failures: unknown[] = [];
    const owner = createDesktopLayoutPersistence({ getItem: () => new Promise<string>(done => { resolve = done; }), setItem: async () => {} }, value => adopted.push(value), error => failures.push(error));
    const flight = owner.restore(); owner.dispose(); resolve('invalid JSON'); await flight;
    expect(adopted).toEqual([]); expect(failures).toEqual([]);
  });
  it('close admission waits for layout durability and requires explicit successful recovery after failure', async () => {
    let finish!: () => void, fail = true;
    const owner = createDesktopLayoutPersistence({ getItem: async () => null,
      setItem: async () => { await new Promise<void>(resolve => { finish = resolve; }); if (fail) throw new Error('disk'); },
    }, () => {}, () => {});
    await owner.restore();
    const saving = owner.set({ panelWidth: 900 }); await Promise.resolve();
    expect(owner.canClose()).toBe(false); const closing = owner.flush(); finish(); await saving;
    expect(await closing).toBe(false); expect(owner.canClose()).toBe(false);
    fail = false; const retry = owner.retry(); await Promise.resolve(); finish(); await retry;
    expect(await owner.flush()).toBe(true); owner.dispose(); expect(owner.canClose()).toBe(false);
  });
  it('a layout edit arriving during another flush is synchronously visible to the final close check', async () => {
    const releases: Array<() => void> = [];
    const owner = createDesktopLayoutPersistence({ getItem: async () => null, setItem: () => new Promise<void>(resolve => releases.push(resolve)) }, () => {}, () => {});
    await owner.restore(); const first = owner.set({ sidebarWidth: 300 }); await Promise.resolve();
    const flush = owner.flush(), second = owner.set({ sidebarWidth: 400 });
    releases.shift()!(); await first; expect(await flush).toBe(false); expect(owner.canClose()).toBe(false);
    await Promise.resolve(); releases.shift()!(); await second; expect(await owner.flush()).toBe(true);
  });
});

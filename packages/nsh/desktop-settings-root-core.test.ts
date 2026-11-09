import { describe, expect, it } from 'vitest';
import { createDesktopSettingsRootOwner } from './desktop-settings-root-core';
import type { DesktopSettingsContentNavigationState } from './desktop-settings-content-core';

const protection = (requestLeave: () => Promise<boolean>): DesktopSettingsContentNavigationState => ({ owner: {}, status: 'ready', page: 'projects', blocked: true,
  pending: false, dirty: true, nestedPickerOpen: false, missing: [], current: () => true, requestLeave });

describe('native desktop settings root', () => {
  it('keeps explicit archive destinations through both guarded open and content navigation', async () => {
    const root = createDesktopSettingsRootOwner(() => {}, () => {});
    await root.open({ page: 'archived-sessions', directory: '/workspace-a' });
    root.report(root.snapshot().revision, protection(async () => true));
    expect(await root.open({ page: 'archived-sessions', entity: 'session-b', directory: '/workspace-b' })).toBe(true);
    expect(root.snapshot().routes.at(-1)).toEqual({ page: 'archived-sessions', entity: 'session-b', directory: '/workspace-b' });
    root.commitBack();
    root.commitNavigate({ page: 'archived-sessions', entity: 'session-b', directory: '/workspace-b' });
    expect(root.snapshot().routes.at(-1)).toEqual({ page: 'archived-sessions', entity: 'session-b', directory: '/workspace-b' });
    root.commitNavigate({ page: 'chat' });
    expect(root.snapshot().routes.at(-1)).toEqual({ page: 'chat', directory: '/workspace-b' });
  });
  it('keeps the product route out of settings history and guards every external exit', async () => {
    const root = createDesktopSettingsRootOwner(() => {}, () => {});
    expect(await root.open({ page: 'projects', directory: '/workspace' })).toBe(true);
    expect(await root.close()).toBe(false);
    root.report(root.snapshot().revision, protection(async () => false));
    expect(await root.open({ page: 'chat' })).toBe(false);
    expect(root.snapshot().routes).toEqual([{ page: 'projects', directory: '/workspace' }]);
    root.report(root.snapshot().revision, protection(async () => true));
    expect(await root.open({ page: 'chat' })).toBe(true);
    expect(root.snapshot().routes.at(-1)).toEqual({ page: 'chat', directory: '/workspace' });
    root.report(root.snapshot().revision, protection(async () => true));
    expect(await root.back()).toBe(true);
    expect(root.snapshot().routes.at(-1)?.page).toBe('projects');
  });
  it('serializes pending confirmations and fences stale Host/page completions', async () => {
    let finish!: (value: boolean) => void;
    const root = createDesktopSettingsRootOwner(() => {}, () => {});
    await root.open({ page: 'projects' });
    root.report(root.snapshot().revision, protection(() => new Promise<boolean>(resolve => { finish = resolve; })));
    const closing = root.close();
    expect(await root.open({ page: 'chat' })).toBe(false);
    root.retire();
    await root.open({ page: 'appearance' });
    finish(true);
    expect(await closing).toBe(false);
    expect(root.snapshot().routes).toEqual([{ page: 'appearance' }]);
  });
  it('ignores retired reports from previous content slots and preserves thrown failures', async () => {
    const errors: unknown[] = [];
    const root = createDesktopSettingsRootOwner(() => {}, error => errors.push(error));
    await root.open({ page: 'projects' });
    const revision = root.snapshot().revision;
    const first = protection(async () => true);
    root.report(revision, first);
    root.commitNavigate({ page: 'chat' });
    root.report(revision, { ...first, status: 'retired' });
    root.report(root.snapshot().revision, protection(async () => { throw new Error('confirmation failed'); }));
    expect(await root.close()).toBe(false);
    expect(root.snapshot().routes.at(-1)?.page).toBe('chat');
    expect(root.snapshot().busy).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

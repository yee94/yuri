import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dict as en } from '@/lib/i18n/messages/en';
import { UpdateDialog } from './UpdateDialog';
import type { UpdateInfo } from '@/lib/desktop';

const fixture = vi.hoisted(() => ({
  remote: true,
  plan: { supported: true, update: { version: '2.0.1', rollback: false } } as { supported: boolean; update: { version: string; rollback: boolean } | null },
  snapshotError: null as Error | null,
  applied: true,
  order: [] as string[],
}));
vi.mock('@/lib/i18n', () => ({ getCurrentIntlLocale: () => 'en-US', useI18n: () => ({ t: (key: keyof typeof en) => en[key] ?? key }) }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: () => null }));
vi.mock('@/stores/useUpdateStore', () => ({ useUpdateStore: Object.assign(
  (select: (state: { otaDownloadSkipped: boolean }) => unknown) => select({ otaDownloadSkipped: false }),
  { getState: () => ({ dismiss: vi.fn() }) },
) }));
vi.mock('@/lib/url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/desktop', () => ({ isDesktopShell: () => true, isDesktopLocalOriginActive: () => !fixture.remote }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeGeneration: () => 1, getRuntimeTransportIdentity: () => 'host:remote' }));
vi.mock('@/queries/hostUpdateQueries', () => ({
  ensureHostUpdateSnapshot: async () => { if (fixture.snapshotError) throw fixture.snapshotError; return fixture.plan; },
  startHostUpdate: async () => { fixture.order.push('remote-update'); return {}; },
  refreshHostUpdateSnapshot: async () => (fixture.applied
    ? { currentVersion: '2.0.1', operation: { status: 'succeeded' } }
    : { currentVersion: '2.0.0', operation: { status: 'failed' } }),
}));

let root: Root;
let container: HTMLDivElement;
const onRestart = vi.fn(() => { fixture.order.push('local-restart'); });
const info: UpdateInfo = { available: true, currentVersion: '2.0.0', version: '2.0.1' };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  Object.assign(fixture, { remote: true, plan: { supported: true, update: { version: '2.0.1', rollback: false } }, snapshotError: null, applied: true, order: [] });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render() {
  await act(async () => { root.render(<UpdateDialog open onOpenChange={vi.fn()} info={info} downloading={false} downloaded progress={null} error={null} onDownload={vi.fn()} onRestart={onRestart} />); });
}
async function restart() {
  const button = Array.from(document.body.querySelectorAll('button')).find((node) => node.textContent?.trim() === en['updateDialog.actions.restartToUpdate']);
  await act(async () => { button?.click(); });
}

it('updates the remote Host before restarting the local app when the option is on', async () => {
  await render();
  expect(document.body.textContent).toContain(en['updateDialog.remote.syncLabel']);
  expect(document.body.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
  await restart();
  expect(fixture.order).toEqual(['remote-update', 'local-restart']);
});

it('restarts only the local app when the option is unticked', async () => {
  await render();
  await act(async () => { (document.body.querySelector('[role="checkbox"]') as HTMLElement).click(); });
  await restart();
  expect(fixture.order).toEqual(['local-restart']);
});

it('skips the remote step when the Host has no matching update or no Host updater', async () => {
  fixture.plan = { supported: true, update: null };
  await render(); await restart();
  expect(fixture.order).toEqual(['local-restart']);
  fixture.order = []; fixture.snapshotError = new Error('host_update_unsupported');
  await restart();
  expect(fixture.order).toEqual(['local-restart']);
});

it('keeps the local app running and reports the failure when the remote update does not apply', async () => {
  fixture.applied = false;
  await render(); await restart();
  expect(onRestart).not.toHaveBeenCalled();
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(en['updateDialog.error.remoteUpdateFailed']);
});

it('does not offer the option on a local desktop connection', async () => {
  fixture.remote = false;
  await render();
  expect(document.body.querySelector('[role="checkbox"]')).toBeNull();
  await restart();
  expect(fixture.order).toEqual(['local-restart']);
});

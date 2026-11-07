import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useEvent } from '@reactuses/core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { encodePairingConnectionPayload, type PairingConnectionPayload } from '@/lib/connectionPayload';
import { cn } from '@/lib/utils';
import { MobilePairingLinkForm } from './MobilePairingLinkForm';
import type { UseMobileConnection } from './mobileConnections';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const scan = vi.fn();
let qrSupported = true;
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MobileApp.tsx'), 'utf8');
const scope = {
  React, useEvent, Button, Input, Icon, SettingsGroup, MobilePairingLinkForm, MobileResizableSheet, ScrollableOverlay, cn,
  useI18n: () => ({ t: (key: string) => key }),
  isQrScanSupported: () => qrSupported,
  scanConnectionQr: scan,
  isActiveRuntimeConnection: () => false,
  connectionDisplayUrl: (connection: { candidates: Array<{ url?: string }> }) => connection.candidates[0]?.url ?? '',
  mobileInputKeyboardProps: { autoComplete: 'off', autoCorrect: 'off', spellCheck: false },
};
const compiled = ts.transpileModule(source.slice(source.indexOf('const MobileInstancesSurface:'), source.indexOf('type MobileUsageLimitRow')), {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;
const Surface = new Function(...Object.keys(scope), `${compiled}; return MobileInstancesSurface;`)(...Object.values(scope)) as React.ComponentType<{
  connection: UseMobileConnection;
  onConnect: () => void;
  onActiveConnectionDeleted: () => void;
}>;
const pairing: PairingConnectionPayload = {
  v: 2, pairingId: 'fixture-pairing', secret: 'fixture-one-time-secret',
  candidates: [{ type: 'lan', url: 'https://host.example' }],
};
const link = encodePairingConnectionPayload(pairing);
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let conn: UseMobileConnection;
const render = async () => {
  await act(async () => root.render(<Surface connection={{ ...conn }} onConnect={() => {}} onActiveConnectionDeleted={() => {}} />));
};
const button = (key: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === key)!;
const click = async (element: HTMLElement) => { expect(element).toBeTruthy(); await act(async () => element.click()); };
const submit = async () => { await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); };
const openAdd = async () => { await click(button('mobile.instances.addManual')); };
const paste = async () => { await click(document.querySelector('[aria-label="mobile.connect.link.paste"]')!); };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => true,
  }));
  qrSupported = true;
  scan.mockReset();
  conn = {
    connections: [], isBusy: false, isPasswordBusy: false, error: null, pendingConnection: null,
    connect: vi.fn().mockResolvedValue(undefined), redeemPairingConnection: vi.fn().mockResolvedValue(undefined),
    submitPassword: vi.fn().mockResolvedValue(undefined), cancelPassword: vi.fn(),
    saveConnection: vi.fn().mockResolvedValue(null), renameConnection: vi.fn().mockResolvedValue(null), removeConnection: vi.fn().mockResolvedValue(null),
    subscribeConnected: vi.fn(() => () => {}), setError: vi.fn(),
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); document.getElementById('mobile-overlay-root')?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

test('instance list shows only add actions; address addition opens the welcome-style pairing sheet', async () => {
  await render();
  expect(document.querySelector('input')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(button('mobile.connect.scanQr')).toBeTruthy();
  expect(button('mobile.instances.addManual')).toBeTruthy();
  await openAdd();
  const sheet = document.querySelector('[role="dialog"]')!;
  expect(sheet).not.toBeNull();
  expect(sheet.querySelectorAll('input')).toHaveLength(1);
  expect(sheet.querySelector('input')?.getAttribute('aria-label')).toBe('mobile.connect.link.label');
  expect(sheet.textContent).toContain('mobile.connect.link.help');
  expect(host.querySelector('input')).toBeNull();
  expect(button('mobile.connect.connectButton').disabled).toBe(true);
  expect(sheet.textContent).not.toContain('mobile.connect.link.divider');
  expect(sheet.textContent).not.toContain('mobile.connect.token.hint');
});

test('clipboard paste waits for explicit Connect and uses the welcome redemption path', async () => {
  vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue(link);
  await render(); await openAdd(); await paste();
  expect(conn.redeemPairingConnection).not.toHaveBeenCalled();
  expect(button('mobile.connect.connectButton').disabled).toBe(false);
  await submit();
  expect(conn.redeemPairingConnection).toHaveBeenCalledWith(pairing);
  expect(conn.saveConnection).not.toHaveBeenCalled();
});

test('manual entry stays inside the sheet, and returning or closing preserves the pairing draft', async () => {
  vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue(link);
  await render(); await openAdd(); await paste();
  await click(button('mobile.connect.manual.toggle'));
  expect(document.querySelector('[role="dialog"]')?.querySelectorAll('input')).toHaveLength(3);
  expect(document.querySelector('[aria-label="mobile.connect.link.label"]')).toBeNull();
  expect(host.querySelector('input')).toBeNull();
  expect(conn.setError).toHaveBeenLastCalledWith(null);
  await click(button('mobile.connect.link.useLink'));
  expect(document.querySelector<HTMLInputElement>('input')?.value).toBe(link);
  await click(document.querySelector('[aria-label="mobile.surface.closeAria"]')!);
  expect(document.querySelector('input')).toBeNull();
  await openAdd();
  expect(document.querySelector<HTMLInputElement>('input')?.value).toBe(link);
});

test('clipboard denial and invalid links stay actionable without connecting', async () => {
  vi.spyOn(navigator.clipboard, 'readText').mockRejectedValue(new Error('denied'));
  await render(); await openAdd(); await paste();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('mobile.connect.link.pasteFallback');
  expect(document.querySelector<HTMLInputElement>('input')?.disabled).toBe(false);
  await submit();
  expect(conn.setError).toHaveBeenCalledWith('mobile.connect.link.invalid');
  conn.error = 'mobile.connect.link.invalid'; await render();
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(conn.redeemPairingConnection).not.toHaveBeenCalled();
});

test('busy pairing disables clipboard, scan, manual entry and repeated submissions', async () => {
  vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue(link);
  await render(); await openAdd(); await paste();
  conn.isBusy = true; await render();
  expect(button('mobile.connect.scanQr').disabled).toBe(true);
  expect(button('mobile.instances.addManual').disabled).toBe(true);
  expect(button('mobile.connect.manual.toggle').disabled).toBe(true);
  expect(document.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('[aria-label="mobile.connect.link.paste"]')?.disabled).toBe(true);
  await click(document.querySelector('[aria-label="mobile.surface.closeAria"]')!);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await submit();
  expect(conn.redeemPairingConnection).not.toHaveBeenCalled();
});

test('scanning retains pairing redemption and legacy address review', async () => {
  scan.mockResolvedValueOnce({ status: 'pairing', pairing });
  await render(); await click(button('mobile.connect.scanQr'));
  expect(conn.redeemPairingConnection).toHaveBeenCalledWith(pairing);
  scan.mockResolvedValueOnce({ status: 'ok', url: 'https://legacy.example', label: 'Legacy' });
  await click(button('mobile.connect.scanQr'));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe('https://legacy.example');
  expect(conn.saveConnection).not.toHaveBeenCalled();
  await submit();
  expect(conn.saveConnection).toHaveBeenCalledWith({ id: undefined, url: 'https://legacy.example', label: 'Legacy', clientToken: '' });
});

test('editing a saved relay-only instance preserves its identity without offering another pairing form', async () => {
  conn.connections = [{ id: 'saved-relay', label: 'Saved device', lastUsedAt: 1, candidates: [{ kind: 'relay', relay: { serverId: 'fixture-server', relayUrl: 'wss://relay.example', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'fixture-x', y: 'fixture-y' } } }] }];
  await render(); await click(host.querySelector('[aria-label="mobile.instances.edit"]')!);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector('input[type="url"]')).toBeNull();
  expect(host.querySelector('[aria-label="mobile.connect.link.label"]')).toBeNull();
  await submit();
  expect(conn.saveConnection).toHaveBeenCalledWith({ id: 'saved-relay', label: 'Saved device', url: '', clientToken: '' });
});

test('pairing and manual entry remain available without native QR support', async () => {
  qrSupported = false; await render();
  expect(button('mobile.connect.scanQr')).toBeUndefined();
  expect(document.querySelector('input')).toBeNull();
  await openAdd();
  expect(document.querySelector('[aria-label="mobile.connect.link.label"]')).not.toBeNull();
  await click(button('mobile.connect.manual.toggle'));
  expect(document.querySelector('[role="dialog"]')?.querySelectorAll('input')).toHaveLength(3);
});

test('successful connection closes the add sheet and clears its one-time link draft', async () => {
  vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue(link);
  await render(); await openAdd(); await paste();
  const connected = vi.mocked(conn.subscribeConnected).mock.calls[0][0];
  await act(async () => connected());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await openAdd();
  expect(document.querySelector<HTMLInputElement>('input')?.value).toBe('');
});

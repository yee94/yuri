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
const savedDirect = {
  id: 'saved-direct', label: 'Saved device', lastUsedAt: 1,
  candidates: [{ kind: 'direct' as const, url: 'http://10.0.0.2:64780' }],
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let conn: UseMobileConnection;
const render = async () => {
  await act(async () => root.render(<Surface connection={{ ...conn }} onConnect={() => {}} onActiveConnectionDeleted={() => {}} />));
};
const button = (key: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === key)!;
const click = async (element: HTMLElement) => { expect(element).toBeTruthy(); await act(async () => element.click()); };
const submit = async () => { await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); };
const openAdd = async () => { await click(button('mobile.connect.link.useLink')); };
const paste = async () => { await click(document.querySelector('[aria-label="mobile.connect.link.paste"]')!); };
const typeInto = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

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

test('the add section mirrors the welcome screen: scan or connection link, never a raw address form', async () => {
  await render();
  expect(document.querySelector('input')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(button('mobile.connect.scanQr')).toBeTruthy();
  expect(button('mobile.connect.link.useLink')).toBeTruthy();
  expect(button('mobile.instances.addManual')).toBeUndefined();
  await openAdd();
  const sheet = document.querySelector('[role="dialog"]')!;
  expect(sheet).not.toBeNull();
  expect(sheet.querySelectorAll('input')).toHaveLength(1);
  expect(sheet.querySelector('input')?.getAttribute('aria-label')).toBe('mobile.connect.link.label');
  expect(sheet.textContent).toContain('mobile.connect.link.help');
  expect(sheet.textContent).not.toContain('mobile.connect.manual.toggle');
  expect(sheet.textContent).not.toContain('mobile.connect.token.hint');
  expect(host.querySelector('input')).toBeNull();
  expect(button('mobile.connect.connectButton').disabled).toBe(true);
});

test('a rejected pairing shows recovery actions instead of a password field', async () => {
  conn.pendingConnection = { ...savedDirect, reason: 'pairing' };
  await render();
  expect(host.textContent).toContain('mobile.connect.pairing.expired');
  expect(host.textContent).toContain('mobile.connect.pairing.reconnectHint');
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(button('mobile.connect.scanQr')).toBeTruthy();
  await click(button('mobile.connect.link.useLink'));
  expect(conn.cancelPassword).toHaveBeenCalledTimes(1);
});

test('a rejected saved device opens its existing delete confirmation', async () => {
  conn.connections = [savedDirect];
  conn.pendingConnection = { ...savedDirect, reason: 'pairing' };
  vi.mocked(conn.removeConnection).mockResolvedValue(savedDirect);
  await render();
  await click(document.querySelector<HTMLElement>('[aria-label="mobile.instances.deleteAria"]')!);
  expect(conn.cancelPassword).toHaveBeenCalledTimes(1);
  expect(conn.removeConnection).not.toHaveBeenCalled();
  conn.pendingConnection = null;
  await render();
  await click(document.querySelector<HTMLElement>('[aria-label="mobile.instances.confirmDeleteAria"]')!);
  expect(conn.removeConnection).toHaveBeenCalledWith(savedDirect.id);
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

test('closing the sheet keeps the pairing draft for the next attempt', async () => {
  vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue(link);
  await render(); await openAdd(); await paste();
  expect(conn.setError).toHaveBeenLastCalledWith(null);
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

test('busy pairing disables clipboard, scan, the link entry and repeated submissions', async () => {
  vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue(link);
  await render(); await openAdd(); await paste();
  conn.isBusy = true; await render();
  expect(button('mobile.connect.scanQr').disabled).toBe(true);
  expect(button('mobile.connect.link.useLink').disabled).toBe(true);
  expect(document.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('[aria-label="mobile.connect.link.paste"]')?.disabled).toBe(true);
  await click(document.querySelector('[aria-label="mobile.surface.closeAria"]')!);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await submit();
  expect(conn.redeemPairingConnection).not.toHaveBeenCalled();
});

test('scanning redeems pairing codes and connects legacy address codes directly', async () => {
  scan.mockResolvedValueOnce({ status: 'pairing', pairing });
  await render(); await click(button('mobile.connect.scanQr'));
  expect(conn.redeemPairingConnection).toHaveBeenCalledWith(pairing);
  scan.mockResolvedValueOnce({ status: 'ok', url: 'https://legacy.example', label: 'Legacy', clientToken: 'legacy-token' });
  await click(button('mobile.connect.scanQr'));
  expect(conn.connect).toHaveBeenCalledWith({ url: 'https://legacy.example', label: 'Legacy', clientToken: 'legacy-token' });
  expect(conn.saveConnection).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('scan failures report next to the add actions', async () => {
  scan.mockResolvedValueOnce({ status: 'invalid' });
  await render(); await click(button('mobile.connect.scanQr'));
  expect(conn.setError).toHaveBeenCalledWith('mobile.connect.scan.invalid');
  conn.error = 'mobile.connect.scan.invalid'; await render();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('mobile.connect.scan.invalid');
});

test('editing opens a sheet that only renames, without exposing transport fields or tokens', async () => {
  conn.connections = [savedDirect];
  await render(); await click(host.querySelector('[aria-label="mobile.instances.edit"]')!);
  const sheet = document.querySelector('[role="dialog"]')!;
  expect(sheet).not.toBeNull();
  expect(sheet.textContent).toContain('mobile.instances.label.label');
  expect(sheet.textContent).not.toContain('mobile.instances.editTitle');
  expect(sheet.querySelector('input[type="url"]')).toBeNull();
  expect(sheet.querySelector('[aria-label="mobile.connect.link.label"]')).toBeNull();
  const fields = sheet.querySelectorAll('input');
  expect(fields).toHaveLength(1);
  expect(fields[0].value).toBe('Saved device');
  await typeInto(fields[0], 'Renamed device');
  await submit();
  expect(conn.renameConnection).toHaveBeenCalledWith('saved-direct', 'Renamed device');
  expect(conn.saveConnection).not.toHaveBeenCalled();
});

test('renaming requires a non-empty name', async () => {
  conn.connections = [savedDirect];
  await render(); await click(host.querySelector('[aria-label="mobile.instances.edit"]')!);
  const input = document.querySelector('[role="dialog"] input') as HTMLInputElement;
  await typeInto(input, '   ');
  expect(button('mobile.instances.saveEdit').disabled).toBe(true);
  await submit();
  expect(conn.renameConnection).not.toHaveBeenCalled();
});

test('closing the edit sheet abandons the draft', async () => {
  conn.connections = [savedDirect];
  await render(); await click(host.querySelector('[aria-label="mobile.instances.edit"]')!);
  const input = document.querySelector('[role="dialog"] input') as HTMLInputElement;
  await typeInto(input, 'Draft name');
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click(host.querySelector('[aria-label="mobile.instances.edit"]')!);
  expect((document.querySelector('[role="dialog"] input') as HTMLInputElement).value).toBe('Saved device');
});

test('a failed connection is reported under the instance that failed', async () => {
  conn.connections = [savedDirect];
  await render();
  await click(host.querySelector('[aria-label="desktopHostSwitcher.actions.switchToAria"]')!);
  expect(conn.connect).toHaveBeenCalled();
  conn.error = 'mobile.connect.error.unreachable'; await render();
  const alerts = host.querySelectorAll('[role="alert"]');
  expect(alerts).toHaveLength(1);
  expect(alerts[0].textContent).toBe('mobile.connect.error.unreachable');
});

test('pairing entry remains available without native QR support', async () => {
  qrSupported = false; await render();
  expect(button('mobile.connect.scanQr')).toBeUndefined();
  expect(button('mobile.connect.link.useLink')).toBeTruthy();
  expect(document.querySelector('input')).toBeNull();
  await openAdd();
  expect(document.querySelector('[aria-label="mobile.connect.link.label"]')).not.toBeNull();
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

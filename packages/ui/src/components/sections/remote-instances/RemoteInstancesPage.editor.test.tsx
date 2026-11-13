import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useEvent } from '@reactuses/core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopSshInstance } from '@/lib/desktopSsh';
import { SettingsActionHeader } from '../shared/SettingsActionHeader';
import { SettingsGroup, SettingsRow } from '../shared/SettingsGroup';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'RemoteInstancesPage.tsx'), 'utf8');
const fieldKey = (name: string) => `settings.remoteInstances.page.field.${name}`;
const fixture = (mode: 'managed' | 'external' = 'managed'): DesktopSshInstance => ({
  id: 'fixture', nickname: ' Test server ', sshCommand: ' ssh user@example.com ', connectionTimeoutSec: 120,
  remoteYuri: { mode, installMethod: 'npm', keepRunning: false, relayHost: true, uploadBundleOverSsh: false, preferredPort: 4200 },
  localForward: { bindHost: '0.0.0.0', preferredLocalPort: 4500 },
  auth: {},
  portForwards: [{ id: 'legacy-forward', enabled: true, type: 'local', localPort: 8080, remotePort: 80 }],
});

afterEach(() => vi.restoreAllMocks());

async function renderEditor(instance = fixture(), removeInstance = vi.fn().mockResolvedValue(undefined), isNewInstance = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let hosts = [{ id: 'fixture' }, { id: 'other-relay' }];
  let defaultHostId = 'fixture';
  const setSelectedId = vi.fn();
  const upsertInstance = vi.fn().mockResolvedValue(undefined);
  const connectWithPortRecovery = vi.fn().mockResolvedValue(undefined);
  const toast = { success: vi.fn(), error: vi.fn() };
  const scope: Record<string, unknown> = {
    React, useEvent, SettingsActionHeader, SettingsGroup, SettingsRow, removeInstance, setSelectedId, upsertInstance, toast, connectWithPortRecovery,
    t: (key: string) => key, cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
    setDirectHosts: (update: (current: typeof hosts) => typeof hosts) => { hosts = update(hosts); },
    setDirectDefaultHostId: (update: (current: string) => string) => { defaultHostId = update(defaultHostId); },
    selectedInstance: instance, isNewInstance, isSaving: false, hasChanges: true, statusPhase: 'idle', status: null, reconnectAppearsStuck: false,
    canDisconnect: false, isPrimaryActionPending: false, isRetryPending: false, canRetry: false, isConnecting: false, isReconnecting: false,
    primaryButtonLabel: 'connect', retryButtonLabel: 'retry', error: null,
    phaseDotClass: () => '', phaseLabelKey: () => 'idle',
    handleRetryAction: vi.fn(), handleOpenLogs: vi.fn(), handleOpenCurrentInstance: vi.fn(),
    Button: ({ children, variant: _variant, size: _size, ...props }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => <button {...props}>{children}</button>,
    Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
    NumberInput: ({ value, onValueChange, onClear: _onClear, emptyLabel: _emptyLabel, ...props }: React.ComponentProps<'input'> & { onValueChange: (value: number) => void; onClear: () => void; emptyLabel: string }) =>
      <input {...props} value={value} type="number" onChange={(event) => onValueChange(Number(event.target.value))} />,
    Icon: () => null,
  };
  for (const name of ['Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription']) {
    scope[name] = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  }
  const normalize = source.slice(source.indexOf('const normalizeForSave'), source.indexOf('const SshConnectionButton'));
  const handlers = source.slice(source.indexOf('  const updateDraft ='), source.indexOf('  const createImportedInstance ='));
  const connectionHandler = source.slice(source.indexOf('  const handlePrimaryConnectionAction ='), source.indexOf('  const handleRetryAction ='));
  const editorStart = source.indexOf('  const instanceTitle = draft.');
  const editor = source.slice(editorStart, source.indexOf('\n      <SyncConfigDialog', editorStart));
  const compiled = ts.transpileModule(`${normalize}
    function Surface({ instance }) {
      const [draft, setDraft] = React.useState(instance);
      const [isRemoving, setIsRemoving] = React.useState(false);
      const [isPrimaryActionPending, setIsPrimaryActionPending] = React.useState(false);
      const removingRef = React.useRef(false);
      ${handlers}
      ${connectionHandler}
      ${editor}
      </DialogContent></Dialog>);
    }`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const Surface = new Function(...Object.keys(scope), `${compiled}; return Surface;`)(...Object.values(scope));
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<Surface instance={instance} />));
  return {
    host, toast, setSelectedId, upsertInstance, connectWithPortRecovery, hosts: () => hosts, defaultHostId: () => defaultHostId,
    deleteButton: () => host.querySelector<HTMLButtonElement>('button[aria-label="settings.common.actions.delete"]')!,
    saveButton: () => [...host.querySelectorAll('button')].find((node) => node.textContent === 'settings.common.actions.saveChanges')!,
    dispose: async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); },
  };
}

it('managed SSH shows only command, name and SSH authentication in shared Settings rows', async () => {
  const editor = await renderEditor();
  try {
    expect([...editor.host.querySelectorAll('input')].map((input) => input.getAttribute('aria-label'))).toEqual([
      fieldKey('sshCommand'), fieldKey('nickname'), fieldKey('sshPasswordOptional'),
    ]);
    expect(editor.host.querySelectorAll('.yuri-settings-group-card').length).toBe(1);
    expect(editor.host.querySelectorAll('.yuri-settings-split-row').length).toBe(3);
    const header = editor.host.querySelector('[data-settings-action-header]')!;
    expect(header.classList.contains('pr-8')).toBe(false);
    expect(header.textContent).toContain('settings.remoteInstances.page.actions.logs');
    expect(header.textContent).toContain('connect');
    expect([...editor.host.querySelectorAll('button')].every((button) => header.contains(button))).toBe(true);
    expect(editor.host.textContent).not.toMatch(/portForwards|connectionTimeout|installMethod|keepServerRunning|preferredLocalPort|sync.runs|section.actions/);
    expect(editor.host.textContent).not.toContain('retry');
  } finally { await editor.dispose(); }
});

it('new SSH uses the full editor and saves once before selecting the created connection', async () => {
  const editor = await renderEditor(fixture(), undefined, true);
  try {
    expect(editor.host.querySelector(`input[aria-label="${fieldKey('sshPasswordOptional')}"]`)).not.toBeNull();
    expect(editor.deleteButton()).toBeNull();
    expect(editor.host.textContent).not.toContain('settings.remoteInstances.page.actions.logs');
    expect(editor.upsertInstance).not.toHaveBeenCalled();
    const create = [...editor.host.querySelectorAll('button')].find((node) => node.textContent === 'settings.common.actions.create')!;
    await act(async () => create.click());
    expect(editor.upsertInstance).toHaveBeenCalledOnce();
    expect(editor.setSelectedId).toHaveBeenCalledExactlyOnceWith('fixture');
  } finally { await editor.dispose(); }
});

it('existing external connections retain their necessary remote port and server authentication', async () => {
  const editor = await renderEditor(fixture('external'));
  try {
    expect(editor.host.querySelector(`input[aria-label="${fieldKey('preferredRemotePort')}"]`)).not.toBeNull();
    expect(editor.host.querySelector(`input[aria-label="${fieldKey('uiPasswordOptional')}"]`)).not.toBeNull();
  } finally { await editor.dispose(); }
});

it('Connect saves the new editor before connecting and does not connect when saving fails', async () => {
  const editor = await renderEditor(fixture(), undefined, true);
  try {
    const connect = [...editor.host.querySelectorAll('button')].find((node) => node.textContent === 'connect')!;
    editor.upsertInstance.mockRejectedValueOnce(new Error('save failed'));
    await act(async () => connect.click());
    expect(editor.connectWithPortRecovery).not.toHaveBeenCalled();
    expect(editor.setSelectedId).not.toHaveBeenCalled();
    expect(editor.toast.error).toHaveBeenCalledOnce();
    await act(async () => connect.click());
    expect(editor.connectWithPortRecovery).toHaveBeenCalledExactlyOnceWith(editor.upsertInstance.mock.calls[1][0]);
    expect(editor.upsertInstance.mock.invocationCallOrder[1]).toBeLessThan(editor.connectWithPortRecovery.mock.invocationCallOrder[0]);
  } finally { await editor.dispose(); }
});

it('saving visible fields preserves existing advanced settings without another bind-host confirmation', async () => {
  const instance = fixture();
  const confirm = vi.fn();
  vi.stubGlobal('confirm', confirm);
  const editor = await renderEditor(instance);
  try {
    await act(async () => editor.saveButton().click());
    expect(editor.upsertInstance).toHaveBeenCalledWith({ ...instance, sshCommand: 'ssh user@example.com', nickname: 'Test server' });
    const saved = editor.upsertInstance.mock.calls[0][0];
    for (const key of ['remoteYuri', 'localForward', 'portForwards', 'auth'] as const) expect(saved[key]).toBe(instance[key]);
    expect(confirm).not.toHaveBeenCalled();
  } finally { await editor.dispose(); }
});

it('one delete click removes the SSH entry and its mirror, without confirmation or repeated requests', async () => {
  let finish!: () => void;
  const remove = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const confirm = vi.fn();
  vi.stubGlobal('confirm', confirm);
  const editor = await renderEditor(fixture(), remove);
  try {
    await act(async () => { editor.deleteButton().click(); editor.deleteButton().click(); });
    expect(remove).toHaveBeenCalledExactlyOnceWith('fixture');
    expect(confirm).not.toHaveBeenCalled();
    expect(editor.deleteButton().disabled).toBe(true);
    expect(editor.saveButton().disabled).toBe(true);
    expect([...editor.host.querySelectorAll('input')].every((input) => input.disabled)).toBe(true);
    expect(editor.setSelectedId).not.toHaveBeenCalled();
    expect(editor.hosts()).toEqual([{ id: 'fixture' }, { id: 'other-relay' }]);
    await act(async () => finish());
    expect(editor.hosts()).toEqual([{ id: 'other-relay' }]);
    expect(editor.defaultHostId()).toBe('local');
    expect(editor.setSelectedId).toHaveBeenCalledExactlyOnceWith(null);
  } finally { await editor.dispose(); }
});

it('failed deletion keeps the editor and associated connection available for retry', async () => {
  const remove = vi.fn().mockRejectedValueOnce(new Error('fixture failure')).mockResolvedValue(undefined);
  const editor = await renderEditor(fixture(), remove);
  try {
    await act(async () => editor.deleteButton().click());
    expect(editor.toast.error).toHaveBeenCalledOnce();
    expect(editor.setSelectedId).not.toHaveBeenCalled();
    expect(editor.hosts()).toEqual([{ id: 'fixture' }, { id: 'other-relay' }]);
    expect(editor.defaultHostId()).toBe('fixture');
    expect(editor.deleteButton().disabled).toBe(false);
    await act(async () => editor.deleteButton().click());
    expect(remove).toHaveBeenCalledTimes(2);
    expect(editor.setSelectedId).toHaveBeenCalledWith(null);
  } finally { await editor.dispose(); }
});

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

it('SSH row shows busy during bootstrap and blocks repeated submissions before status arrives', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'RemoteInstancesPage.tsx'), 'utf8');
  const rowStart = source.indexOf('instances.map((instance) => {', source.indexOf('return (', source.indexOf('export const RemoteInstancesPage')));
  const rows = source.slice(rowStart, source.indexOf('\n                })}', rowStart) + '\n                })'.length);
  const componentStart = source.indexOf('const SshConnectionButton');
  const component = componentStart < 0 ? '' : source.slice(componentStart, source.indexOf('export const RemoteInstancesPage', componentStart));
  const statusesById = { fixture: { phase: 'updating' } };
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const connect = vi.fn(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
  const scope: Record<string, unknown> = {
    React, statusesById, connect, disconnect: vi.fn().mockResolvedValue(undefined),
    instances: [{ id: 'fixture' }], directHosts: [], directRuntimeEpoch: 0, hostSwitchPending: false,
    isDesktopHostActive: () => false, switchToSshInstance: vi.fn(), openSyncDialog: vi.fn(), setSelectedId: vi.fn(),
    t: (key: string) => key, useI18n: () => ({ t: (key: string) => key }),
    phaseDotClass: () => '', phaseLabelKey: (phase: string) => phase,
    toast: { error: vi.fn() }, resolveManagedSshBootstrapErrorCode: vi.fn(),
    sshBootstrapErrorGuidanceKey: () => '', formatSshBootstrapErrorDescription: () => '',
    Button: ({ children, onClick, disabled, ...props }: React.ComponentProps<'button'>) => <button disabled={disabled} onClick={onClick} aria-busy={props['aria-busy']}>{children}</button>,
    Icon: ({ className }: { className: string }) => <i className={className} />,
  };
  for (const name of ['Tooltip', 'TooltipTrigger', 'TooltipContent']) scope[name] = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  const phases = source.slice(source.indexOf('const CONNECTING_PHASES'), source.indexOf('const phaseDotClass'));
  const compiled = ts.transpileModule(`${phases}\n${component}\nfunction Surface(){return <>${'{' + rows + '}'}</>}`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const Surface = new Function(...Object.keys(scope), `${compiled}; return Surface;`)(...Object.values(scope));
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = async (phase: string) => {
    statusesById.fixture.phase = phase;
    await act(async () => root.render(<Surface />));
  };
  const button = () => host.querySelector('button')!;
  try {
    for (const phase of ['updating', 'installing', 'master_connecting', 'server_starting', 'degraded']) {
      await render(phase);
      expect(button().disabled).toBe(true);
      expect(button().querySelector('.animate-spin')).not.toBeNull();
      await act(async () => button().click());
      expect(connect).not.toHaveBeenCalled();
    }
    await render('idle');
    await act(async () => { button().click(); button().click(); });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    expect(button().textContent).toContain('connecting');
    await act(async () => fail(new Error('fixture failure')));
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(connect).toHaveBeenCalledTimes(2);
    await render('ready');
    expect(button().disabled).toBe(true);
    await act(async () => finish());
    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain('disconnect');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

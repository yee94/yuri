import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DirectoryExplorerDialog } from './DirectoryExplorerDialog';
import { queryClient } from '@/lib/queryRuntime';
vi.mock('@/queries/remoteProjectQueries', () => ({
  useRemoteHostCatalog: () => ({
    data: fixture.remoteSupported && fixture.catalogKnown ? { supported: true, hubId: 'hub', hosts: fixture.hosts } : undefined,
    error: fixture.catalogError, isPending: fixture.catalogPending, refetch: fixture.refetchCatalog,
  }),
  supportsRemoteProjects: () => fixture.remoteSupported,
  getHostRuntimeRegistry: () => fixture.registry,
}));
vi.mock('./RemoteDirectoryExplorerDialog', () => ({
  RemoteDirectoryExplorerDialog: ({ hostId, machinePicker }: { hostId: string; machinePicker: React.ReactNode }) => <section data-remote-directory={hostId}>{machinePicker}</section>,
}));

const fixture = vi.hoisted(() => {
  const connectHost = vi.fn();
  return {
  mobile: false,
  remoteSupported: false,
  catalogKnown: true,
  catalogPending: false,
  catalogError: null as Error | null,
  refetchCatalog: vi.fn(),
  connectHost,
  registry: { hubId: 'hub', connectHost, assertCurrent: vi.fn(), getHost: vi.fn() },
  setSettingsPage: vi.fn(),
  setSettingsDialogOpen: vi.fn(),
  setSettingsRemoteInstancesSelectedId: vi.fn(),
  hosts: [] as Array<{ id: string; name: string; state: string; available?: boolean }>,
  home: '/workspace',
  projects: [{ id: 'existing', path: '/workspace/Existing' }],
  identity: { id: 'default-identity', name: 'Default identity', authType: 'ssh', sshKey: 'fixture-key' },
  list: vi.fn(),
  clone: vi.fn(),
  create: vi.fn(),
  add: vi.fn(),
  openDraft: vi.fn(),
  openMobileDraft: vi.fn(),
  setDraftTarget: vi.fn(),
  requestAccess: vi.fn(),
  startAccessing: vi.fn(),
  toastError: vi.fn(),
  loadProfiles: vi.fn(),
  loadGlobal: vi.fn(),
  loadDefault: vi.fn(),
  };
});

vi.mock('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: (selector: (state: { homeDirectory: string }) => unknown) => selector({ homeDirectory: fixture.home }),
}));
vi.mock('@/stores/useProjectsStore', () => ({
  useProjectsStore: (selector: (state: { projects: typeof fixture.projects; addProject: typeof fixture.add }) => unknown) => selector({ projects: fixture.projects, addProject: fixture.add }),
}));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({
  setSettingsPage: fixture.setSettingsPage,
  setSettingsDialogOpen: fixture.setSettingsDialogOpen,
  setSettingsRemoteInstancesSelectedId: fixture.setSettingsRemoteInstancesSelectedId,
}) } }));
vi.mock('@/stores/useGitIdentitiesStore', () => ({
  useGitIdentitiesStore: (selector: (state: {
    profiles: Array<typeof fixture.identity>; globalIdentity: null; defaultGitIdentityId: string;
    loadProfiles: typeof fixture.loadProfiles; loadGlobalIdentity: typeof fixture.loadGlobal; loadDefaultGitIdentityId: typeof fixture.loadDefault;
  }) => unknown) => selector({
    profiles: [fixture.identity], globalIdentity: null, defaultGitIdentityId: fixture.identity.id,
    loadProfiles: fixture.loadProfiles, loadGlobalIdentity: fixture.loadGlobal, loadDefaultGitIdentityId: fixture.loadDefault,
  }),
}));
vi.mock('@/sync/session-ui-store', () => ({
  useSessionUIStore: { getState: () => ({
    newSessionDraft: { open: true }, openNewSessionDraft: fixture.openDraft, setNewSessionDraftTarget: fixture.setDraftTarget,
  }) },
}));
vi.mock('@/mobile/useMobileNavigationStore', () => ({
  useMobileNavigationStore: { getState: () => ({ openDraft: fixture.openMobileDraft }) },
}));
vi.mock('@/hooks/useFileSystemAccess', () => ({
  useFileSystemAccess: () => ({ isDesktop: !fixture.mobile, requestAccess: fixture.requestAccess, startAccessing: fixture.startAccessing }),
}));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: fixture.mobile }) }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => new Response(JSON.stringify({ home: fixture.home })) }));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: {
  listLocalDirectory: fixture.list, cloneRepository: fixture.clone, createDirectory: fixture.create,
  getFilesystemHome: async () => fixture.home,
} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui', () => ({ toast: { error: fixture.toastError } }));
vi.mock('@/components/views/git/GitHeader', () => ({ IdentityDropdown: () => <button type="button" aria-label="fixture-identity">Identity</button> }));
vi.mock('@/components/icon/Icon', () => ({ Icon: ({ name, className }: { name: string; className?: string }) => <span data-icon={name} className={className} /> }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <>{children}</> : null,
  DialogContent: ({ className, children, presentation }: { className?: string; children: React.ReactNode; presentation?: string }) => <section className={`flex flex-col ${className}`} data-presentation={presentation} data-testid="directory-dialog">{children}</section>,
  DialogHeader: (props: React.HTMLAttributes<HTMLDivElement>) => <header {...props} />,
  DialogTitle: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h2 {...props} />,
  DialogFooter: (props: React.HTMLAttributes<HTMLDivElement>) => <footer {...props} />,
}));
vi.mock('@/components/ui/MobileResizableSheet', () => ({
  MobileResizableSheet: ({ open, children, title, trailing, className }: {
    open: boolean; children: React.ReactNode; title: React.ReactNode; trailing: React.ReactNode; className?: string;
  }) => open ? <section className={className} data-testid="directory-mobile-sheet">
    <header className="flex min-h-10 items-center gap-2 px-4 pb-2"><div className="min-w-0 flex-1">{title}</div>{trailing}</header>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-page-scroll-lock="true">{children}</div>
  </section> : null,
}));

describe.each([false, true])('DirectoryExplorerDialog interactions (mobile=%s)', (mobile) => {
  let root: Root;
  let container: HTMLDivElement;
  let open: boolean;
  let setOpen!: React.Dispatch<React.SetStateAction<boolean>>;

  const Host = () => {
    const [value, setValue] = React.useState(true);
    open = value;
    setOpen = setValue;
    return <DirectoryExplorerDialog open={value} onOpenChange={setValue} />;
  };
  const mount = async () => { await act(async () => { root.render(<Host />); }); };
  const flushMutation = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); };
  const button = (key: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === key)!;
  const pathInput = () => container.querySelector<HTMLInputElement>('input[aria-label="directoryExplorerDialog.pathInput.placeholder"]')!;
  const fill = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    fixture.mobile = mobile;
    fixture.remoteSupported = false;
    fixture.catalogKnown = true;
    fixture.catalogPending = false;
    fixture.catalogError = null;
    fixture.connectHost.mockReset().mockResolvedValue(undefined);
    fixture.registry.assertCurrent.mockReset();
    fixture.registry.getHost.mockImplementation((id: string) => fixture.hosts.find(host => host.id === id));
    fixture.hosts = [];
    fixture.list.mockImplementation(async (path: string) => path === '/workspace/' ? [
      { name: 'Code', path: '/workspace/Code', isDirectory: true },
      { name: 'Existing', path: '/workspace/Existing', isDirectory: true },
      { name: 'A very long directory name for checking truncation without shifting the add action', path: '/workspace/long', isDirectory: true },
      { name: '.hidden', path: '/workspace/.hidden', isDirectory: true },
      { name: 'file.txt', path: '/workspace/file.txt', isDirectory: false },
    ] : []);
    fixture.add.mockImplementation((path: string) => ({ id: 'added', path }));
    fixture.clone.mockResolvedValue({ path: '/workspace/cloned' });
    fixture.create.mockResolvedValue(undefined);
    fixture.requestAccess.mockResolvedValue({ success: true, path: '/selected' });
    fixture.startAccessing.mockResolvedValue({ success: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    queryClient.clear();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('keeps one surface with compact controls and no nested list card or help copy', async () => {
    await mount();
    expect(fixture.list).toHaveBeenCalledWith('/workspace/');
    expect(container.querySelectorAll('[data-directory-row]')).toHaveLength(3);
    expect(container.textContent).not.toContain('directoryExplorerDialog.description');
    expect(container.querySelectorAll('.yuri-directory-shortcuts [data-slot="kbd"][data-variant="hint"]')).toHaveLength(mobile ? 0 : 3);
    expect(container.textContent).not.toContain('directoryExplorerDialog.browse.directories');
    expect(container.querySelector('.yuri-directory-results')?.className).not.toMatch(/shadow|border|bg-/);
    expect(container.querySelector('.yuri-directory-list')).not.toBeNull();
    if (!mobile) expect(container.querySelector('.yuri-directory-dialog')?.getAttribute('data-presentation')).toBe('picker');
    if (process.env.YURI_TEST_EVIDENCE_DIR) {
      mkdirSync(process.env.YURI_TEST_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.YURI_TEST_EVIDENCE_DIR, `directory-${mobile ? 'mobile' : 'desktop'}.html`), container.innerHTML);
    }
  });

  test('uses the design machine step before directory IO and reuses local browsing when returning', async () => {
    fixture.remoteSupported = true;
    fixture.hosts = [
      { id: 'remote', name: 'Remote machine', state: 'idle' },
      { id: 'locked', name: 'Locked machine', state: 'unauthorized' },
    ];
    await mount();
    expect(pathInput()).toBeNull();
    expect(fixture.list).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.textContent).toContain('remoteProjects.local');
    const remote = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Remote machine'))!;
    const locked = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Locked machine'))!;
    expect(locked.disabled).toBe(true);
    await act(async () => remote.click());
    await act(async () => button('remoteProjects.next').click());
    expect(container.querySelector('[data-remote-directory]')?.getAttribute('data-remote-directory')).toBe('remote');
    expect(fixture.list).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="header.actions.backAria"]')!.click());
    await act(async () => button('remoteProjects.local').click());
    await act(async () => button('remoteProjects.next').click());
    expect(pathInput()).not.toBeNull();
    expect(fixture.list).toHaveBeenCalledWith('/workspace/');
    expect(container.querySelector('[data-remote-directory]')).toBeNull();
  });

  test('without remote hosts keeps the existing local directory entry without extra steps or unsupported copy', async () => {
    fixture.remoteSupported = true;
    await mount();
    expect(pathInput()).not.toBeNull();
    expect(button('remoteProjects.next')).toBeUndefined();
    expect(container.textContent).not.toContain('remoteProjects.unsupported');
    expect(fixture.list).toHaveBeenCalledWith('/workspace/');
    expect(button('settings.remoteInstances.sidebar.actions.addSshInstance')).toBeUndefined();
    expect(container.textContent).not.toContain('remoteProjects.machine');
  });

  test('machine keyboard navigation skips disabled rows and Enter continues without repeat or IME submissions', async () => {
    fixture.remoteSupported = true;
    fixture.hosts = [
      { id: 'locked', name: 'Locked machine', state: 'unauthorized' },
      { id: 'remote', name: 'Remote machine', state: 'connected' },
    ];
    await mount();
    const local = button('remoteProjects.local');
    const remote = [...container.querySelectorAll<HTMLButtonElement>('.yuri-directory-entry')].find(node => node.textContent?.includes('Remote machine'))!;
    await act(async () => local.focus());
    await act(async () => local.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(remote);
    expect(remote.getAttribute('aria-pressed')).toBe('true');
    await act(async () => remote.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(local);
    expect(local.getAttribute('aria-pressed')).toBe('true');
    await act(async () => local.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    for (const extra of [{ repeat: true }, { isComposing: true }]) {
      await act(async () => remote.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...extra })));
    }
    expect(fixture.connectHost).not.toHaveBeenCalled();
    let connected!: () => void;
    fixture.connectHost.mockImplementation(() => new Promise<void>(resolve => { connected = resolve; }));
    await act(async () => remote.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    await flushMutation();
    await act(async () => remote.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(fixture.connectHost).toHaveBeenCalledExactlyOnceWith('remote', { verify: true });
    await act(async () => connected());
    expect(container.querySelector('[data-remote-directory]')?.getAttribute('data-remote-directory')).toBe('remote');
  });

  test.each(['idle', 'connecting', 'connected', 'degraded', 'offline'])('waits for the complete remote connection before entering directory selection (cached state=%s)', async (state) => {
    fixture.remoteSupported = true;
    fixture.hosts = [{ id: 'remote', name: 'Remote machine', state }];
    let connected!: () => void;
    fixture.connectHost.mockImplementation(() => new Promise<void>((resolve) => { connected = resolve; }));
    await mount();
    const remote = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Remote machine'))!;
    await act(async () => remote.click());
    await act(async () => {
      const next = button('remoteProjects.next');
      next.click();
      next.click();
    });
    await flushMutation();
    expect(container.querySelector('[data-remote-directory]')).toBeNull();
    expect(fixture.connectHost).toHaveBeenCalledExactlyOnceWith('remote', { verify: true });
    expect(button('remoteProjects.state.connecting').disabled).toBe(true);
    expect(button('remoteProjects.state.connecting').getAttribute('aria-busy')).toBe('true');
    expect(fixture.list).not.toHaveBeenCalled();
    await act(async () => connected());
    expect(container.querySelector('[data-remote-directory]')?.getAttribute('data-remote-directory')).toBe('remote');
  });

  test('connection failure stays on machines, exposes the error and permits an explicit retry', async () => {
    fixture.remoteSupported = true;
    fixture.hosts = [{ id: 'remote', name: 'Remote machine', state: 'offline' }];
    fixture.connectHost.mockRejectedValueOnce(new Error('remote_ssh_authentication_failed'));
    await mount();
    const slots = container.querySelectorAll('.yuri-directory-status-slot').length;
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Remote machine'))!.click());
    await act(async () => button('remoteProjects.next').click());
    await flushMutation();
    expect(container.querySelector('[data-remote-directory]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('remote_ssh_authentication_failed');
    const indicator = container.querySelector<HTMLButtonElement>('button[aria-label="remote_ssh_authentication_failed"]')!;
    expect(indicator.closest('.yuri-directory-row')?.textContent).toContain('Remote machine');
    expect(indicator.querySelector('[data-icon="error-warning"]')).not.toBeNull();
    expect(container.querySelectorAll('.yuri-directory-footer button')).toHaveLength(2);
    expect(container.querySelectorAll('.yuri-directory-status-slot')).toHaveLength(slots);
    expect(fixture.list).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    await act(async () => indicator.focus());
    await flushMutation();
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain('remote_ssh_authentication_failed');
    expect(document.querySelector('[data-slot="tooltip-content"]')?.parentElement?.className).toContain('z-[70]');
    expect(container.textContent).not.toContain('remote_ssh_authentication_failed');
    const retry = container.querySelector<HTMLButtonElement>('.yuri-directory-machine-actions button:last-child')!;
    expect(retry.textContent).toBe('remoteProjects.retry');
    expect(retry.disabled).toBe(false);
    await act(async () => retry.click());
    expect(fixture.connectHost).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-remote-directory]')?.getAttribute('data-remote-directory')).toBe('remote');
  });

  test('switching to local while connecting never lets a late remote result change the directory owner', async () => {
    fixture.remoteSupported = true;
    fixture.hosts = [{ id: 'remote', name: 'Remote machine', state: 'idle' }];
    let connected!: () => void;
    fixture.connectHost.mockImplementationOnce(() => new Promise<void>((resolve) => { connected = resolve; }));
    await mount();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Remote machine'))!.click());
    await act(async () => button('remoteProjects.next').click());
    await act(async () => button('remoteProjects.local').click());
    await act(async () => button('remoteProjects.next').click());
    expect(pathInput()).not.toBeNull();
    await act(async () => connected());
    expect(container.querySelector('[data-remote-directory]')).toBeNull();
    expect(pathInput()).not.toBeNull();
    expect(fixture.connectHost).toHaveBeenCalledOnce();
  });

  test('leaving and reselecting the same remote cannot revive the original connection intent', async () => {
    fixture.remoteSupported = true;
    fixture.hosts = [{ id: 'remote', name: 'Remote machine', state: 'idle' }];
    let connected!: () => void;
    fixture.connectHost.mockImplementationOnce(() => new Promise<void>((resolve) => { connected = resolve; }));
    await mount();
    const remote = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Remote machine'))!;
    await act(async () => remote().click());
    await act(async () => button('remoteProjects.next').click());
    await act(async () => button('remoteProjects.local').click());
    await act(async () => remote().click());
    await act(async () => connected());
    expect(container.querySelector('[data-remote-directory]')).toBeNull();
    await act(async () => button('remoteProjects.next').click());
    expect(fixture.connectHost).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-remote-directory]')?.getAttribute('data-remote-directory')).toBe('remote');
  });

  test('opening SSH settings cancels navigation intent even if the picker reopens before connection finishes', async () => {
    fixture.remoteSupported = true;
    fixture.hosts = [{ id: 'remote', name: 'Remote machine', state: 'idle' }];
    let connected!: () => void;
    fixture.connectHost.mockImplementationOnce(() => new Promise<void>((resolve) => { connected = resolve; }));
    await mount();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Remote machine'))!.click());
    await act(async () => button('remoteProjects.next').click());
    await act(async () => button('settings.remoteInstances.sidebar.actions.addSshInstance').click());
    expect(open).toBe(false);
    await act(async () => setOpen(true));
    await act(async () => connected());
    expect(container.querySelector('[data-remote-directory]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.textContent).toContain('remoteProjects.local');
    expect(fixture.list).not.toHaveBeenCalled();
  });

  test('unmounted picker discards late connection completion', async () => {
    fixture.remoteSupported = true;
    fixture.hosts = [{ id: 'remote', name: 'Remote machine', state: 'idle' }];
    let connected!: () => void;
    fixture.connectHost.mockImplementationOnce(() => new Promise<void>((resolve) => { connected = resolve; }));
    await mount();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Remote machine'))!.click());
    await act(async () => button('remoteProjects.next').click());
    await act(async () => root.render(null));
    await act(async () => connected());
    expect(container.querySelector('[data-remote-directory]')).toBeNull();
    expect(fixture.list).not.toHaveBeenCalled();
  });

  test('an inactive Hub rejects late connection completion without entering directories', async () => {
    fixture.remoteSupported = true;
    fixture.hosts = [{ id: 'remote', name: 'Remote machine', state: 'idle' }];
    let connected!: () => void;
    fixture.connectHost.mockImplementationOnce(() => new Promise<void>((resolve) => { connected = resolve; }));
    await mount();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Remote machine'))!.click());
    await act(async () => button('remoteProjects.next').click());
    fixture.registry.assertCurrent.mockImplementation(() => { throw new Error('Inactive Hub registry'); });
    await act(async () => connected());
    await flushMutation();
    expect(container.querySelector('[data-remote-directory]')).toBeNull();
    expect(container.querySelector('button[aria-label="Inactive Hub registry"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(fixture.list).not.toHaveBeenCalled();
  });

  test('cold discovery never presents an empty machine step and resolves directly to local browsing', async () => {
    fixture.remoteSupported = true;
    fixture.catalogKnown = false;
    fixture.catalogPending = true;
    await mount();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('common.loading');
    expect(button('remoteProjects.next')).toBeUndefined();
    expect(container.textContent).not.toContain('remoteProjects.machine');
    expect(container.textContent).not.toContain('remoteProjects.local');
    expect(fixture.list).not.toHaveBeenCalled();
    fixture.catalogKnown = true;
    fixture.catalogPending = false;
    await mount();
    expect(pathInput()).not.toBeNull();
    expect(button('remoteProjects.next')).toBeUndefined();
    await act(async () => button('directoryExplorerDialog.actions.addProject').click());
    expect(fixture.add).toHaveBeenCalledWith('/workspace');
    expect(open).toBe(false);
  });

  test('cold discovery with a saved remote enters the machine step without local directory IO', async () => {
    fixture.remoteSupported = true;
    fixture.catalogKnown = false;
    fixture.catalogPending = true;
    await mount();
    fixture.hosts = [{ id: 'saved', name: 'Saved workstation', state: 'offline' }];
    fixture.catalogKnown = true;
    fixture.catalogPending = false;
    await mount();
    expect(button('remoteProjects.next')).toBeDefined();
    expect(container.textContent).toContain('Saved workstation');
    expect(pathInput()).toBeNull();
    expect(fixture.list).not.toHaveBeenCalled();
  });

  test('unavailable references do not count as another configured machine', async () => {
    fixture.remoteSupported = true;
    fixture.hosts = [{ id: 'removed', name: 'Removed workstation', state: 'offline', available: false }];
    await mount();
    expect(pathInput()).not.toBeNull();
    expect(button('remoteProjects.next')).toBeUndefined();
    expect(container.textContent).not.toContain('Removed workstation');
  });

  test('failed discovery preserves ordinary local browsing and exposes the failure without a machine step', async () => {
    fixture.remoteSupported = true;
    fixture.catalogKnown = false;
    fixture.catalogError = new Error('Machine catalog unavailable');
    await mount();
    expect(pathInput()).not.toBeNull();
    expect(container.querySelector('header button[aria-label="Machine catalog unavailable"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('Machine catalog unavailable');
    expect(button('remoteProjects.next')).toBeUndefined();
    expect(fixture.list).toHaveBeenCalledWith('/workspace/');
  });

  test('a saved offline machine is selectable and the bottom SSH action opens the shared new-connection editor', async () => {
    fixture.remoteSupported = true;
    fixture.hosts = [{ id: 'saved', name: 'Saved workstation', state: 'offline' }];
    await mount();
    const remote = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Saved workstation'))!;
    expect(remote.disabled).toBe(false);
    expect(container.querySelectorAll('.yuri-directory-entry')).toHaveLength(2);
    const addSsh = button('settings.remoteInstances.sidebar.actions.addSshInstance');
    expect(addSsh.closest('.yuri-directory-footer')).not.toBeNull();
    expect(addSsh.closest('.yuri-directory-list')).toBeNull();
    await act(async () => addSsh.click());
    expect(open).toBe(false);
    expect(fixture.setSettingsRemoteInstancesSelectedId).toHaveBeenCalledWith('new');
    expect(fixture.setSettingsPage).toHaveBeenCalledWith('remote-instances');
    expect(fixture.setSettingsDialogOpen).toHaveBeenCalledWith(true);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.add).not.toHaveBeenCalled();
  });

  test('show-hidden is a pressed toggle and only exposes directories', async () => {
    await mount();
    const toggle = button('directoryExplorerDialog.toggle.showHidden');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('.hidden');
    expect(container.textContent).not.toContain('file.txt');
    expect(fixture.list).toHaveBeenCalledTimes(1);
  });

  test('long directory lists keep the footer outside the scrolling region in both modes', async () => {
    fixture.list.mockResolvedValue(Array.from({ length: 30 }, (_, i) => ({
      name: i === 1 ? 'A very long directory name for checking truncation without shifting the add action' : `Directory ${String(i + 1).padStart(2, '0')}`,
      path: `/workspace/directory-${i}`, isDirectory: true,
    })));
    await mount();
    expect(container.querySelectorAll('[data-directory-row]')).toHaveLength(30);
    expect(container.querySelector('.yuri-directory-list .yuri-directory-footer')).toBeNull();
    const frame = container.querySelector('.yuri-directory-results')!;
    expect(frame.classList.contains('overflow-clip')).toBe(true);
    expect(frame.classList.contains('overflow-hidden')).toBe(false);
    expect(container.querySelector('.yuri-directory-list')?.classList.contains('overflow-y-auto')).toBe(true);
    if (process.env.YURI_TEST_EVIDENCE_DIR) writeFileSync(join(process.env.YURI_TEST_EVIDENCE_DIR, `directory-${mobile ? 'mobile' : 'desktop'}-long.html`), container.innerHTML);
    await act(async () => { button('directoryExplorerDialog.actions.cloneRepository').click(); });
    expect(container.querySelectorAll('[data-directory-row]')).toHaveLength(30);
    expect(container.querySelectorAll('.yuri-directory-field')).toHaveLength(2);
    if (process.env.YURI_TEST_EVIDENCE_DIR) writeFileSync(join(process.env.YURI_TEST_EVIDENCE_DIR, `directory-${mobile ? 'mobile' : 'desktop'}-clone.html`), container.innerHTML);
  });

  test('path filtering, Enter navigation and parent navigation remain available', async () => {
    await mount();
    await fill(pathInput(), '~/Co');
    expect(container.querySelectorAll('[data-directory-row]')).toHaveLength(1);
    await act(async () => { pathInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(pathInput().value).toBe('~/Code/');
    expect(fixture.list).toHaveBeenLastCalledWith('/workspace/Code/');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-directory-row="up"] .yuri-directory-entry')!.click(); });
    expect(pathInput().value).toBe('~/');
  });

  test('arrow-key hints match the existing highlighted-row navigation', async () => {
    await mount();
    await act(async () => { pathInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(container.querySelector('[data-directory-row][data-selected="true"]')?.textContent).toBe('Code');
    await act(async () => { pathInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    expect(container.querySelector('[data-directory-row][data-selected="true"]')?.textContent).toContain('A very long directory');
  });

  if (!mobile) test.each(['MacIntel', 'Win32'])('shortcut badge uses the matching platform modifier (%s)', async (platform) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    await mount();
    const keys = container.querySelectorAll('.yuri-directory-shortcuts [data-slot="kbd"]');
    expect(keys[0].getAttribute('aria-label')).toBe('↑ ↓');
    expect(keys[1].querySelector('[data-icon="corner-down-left"]')).not.toBeNull();
    expect(keys[2].getAttribute('aria-label')).toBe(platform === 'MacIntel' ? '⌘ Enter' : 'Ctrl Enter');
    expect(Boolean(keys[2].querySelector('[data-icon="command"]'))).toBe(platform === 'MacIntel');
    await act(async () => { pathInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: platform === 'MacIntel', ctrlKey: platform !== 'MacIntel', bubbles: true })); });
    expect(fixture.add).toHaveBeenCalledWith('/workspace');
  });

  test('quick add never enters the folder or dismisses the dialog', async () => {
    await mount();
    const row = [...container.querySelectorAll('[data-directory-row]')].find(node => node.textContent?.startsWith('Code'))!;
    await act(async () => { row.querySelector<HTMLButtonElement>('button[aria-label="directoryExplorerDialog.browse.quickAdd"]')!.click(); });
    expect(fixture.add).toHaveBeenCalledWith('/workspace/Code');
    expect(fixture.setDraftTarget).toHaveBeenCalledWith({ projectId: 'added', directoryOverride: '/workspace/Code' }, { force: true });
    expect(pathInput().value).toBe('~/');
    expect(open).toBe(true);
  });

  test('primary-modifier Enter adds the current directory and opens the owning draft surface', async () => {
    await mount();
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    await act(async () => { pathInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: isMac, ctrlKey: !isMac, bubbles: true })); });
    expect(fixture.add).toHaveBeenCalledWith('/workspace');
    expect(mobile ? fixture.openMobileDraft : fixture.openDraft).toHaveBeenCalledWith({
      selectedProjectId: 'added', directoryOverride: '/workspace', preserveDirectoryOverride: true,
    });
    expect(open).toBe(false);
  });

  test('already-added directories cannot be submitted again', async () => {
    await mount();
    await fill(pathInput(), '~/Existing/');
    expect(button('directoryExplorerDialog.actions.alreadyAdded').disabled).toBe(true);
    expect(fixture.add).not.toHaveBeenCalled();
  });

  test('creates a new target directory before adding it', async () => {
    await mount();
    await fill(pathInput(), '~/new-folder');
    await act(async () => { button('directoryExplorerDialog.actions.createAndAdd').click(); });
    expect(fixture.create).toHaveBeenCalledWith('/workspace/new-folder');
    expect(fixture.add).toHaveBeenCalledWith('/workspace/new-folder');
    expect(open).toBe(false);
  });

  test('clone mode keeps its URL and identity input, then adds the returned path', async () => {
    await mount();
    await act(async () => { button('directoryExplorerDialog.actions.cloneRepository').click(); });
    expect(button('directoryExplorerDialog.actions.cloneAndAdd').disabled).toBe(true);
    const remote = container.querySelector<HTMLInputElement>('input[aria-label="directoryExplorerDialog.clone.remoteUrlPlaceholder"]')!;
    await fill(remote, 'https://example.com/team/repo.git');
    await act(async () => { button('directoryExplorerDialog.actions.cloneAndAdd').click(); });
    expect(fixture.clone).toHaveBeenCalledWith({ remoteUrl: 'https://example.com/team/repo.git', destinationPath: '/workspace', gitIdentityId: 'default-identity' });
    expect(fixture.add).toHaveBeenCalledWith('/workspace/cloned');
    expect(open).toBe(false);
  });

  test('clone failure leaves the form open and reports the error', async () => {
    fixture.clone.mockRejectedValueOnce(new Error('fixture clone failure'));
    await mount();
    await act(async () => { button('directoryExplorerDialog.actions.cloneRepository').click(); });
    await fill(container.querySelector<HTMLInputElement>('input[aria-label="directoryExplorerDialog.clone.remoteUrlPlaceholder"]')!, 'https://example.com/team/repo.git');
    await act(async () => { button('directoryExplorerDialog.actions.cloneAndAdd').click(); });
    expect(open).toBe(true);
    expect(fixture.add).not.toHaveBeenCalled();
    expect(fixture.toastError).toHaveBeenCalledWith('directoryExplorerDialog.toast.failedToSelectDirectory', { description: 'fixture clone failure' });
  });

  if (!mobile) test('native folder selection still grants access before adding', async () => {
    await mount();
    await act(async () => { button('directoryExplorerDialog.actions.openInFinder').click(); });
    expect(fixture.requestAccess).toHaveBeenCalledWith('/workspace');
    expect(fixture.startAccessing).toHaveBeenCalledWith('/selected');
    expect(fixture.add).toHaveBeenCalledWith('/selected');
    expect(open).toBe(false);
  });
});

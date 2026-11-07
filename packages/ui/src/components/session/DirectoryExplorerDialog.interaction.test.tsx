import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DirectoryExplorerDialog } from './DirectoryExplorerDialog';

const fixture = vi.hoisted(() => ({
  mobile: false,
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
}));

vi.mock('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: (selector: (state: { homeDirectory: string }) => unknown) => selector({ homeDirectory: fixture.home }),
}));
vi.mock('@/stores/useProjectsStore', () => ({
  useProjectsStore: (selector: (state: { projects: typeof fixture.projects; addProject: typeof fixture.add }) => unknown) => selector({ projects: fixture.projects, addProject: fixture.add }),
}));
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

  const Host = () => {
    const [value, setValue] = React.useState(true);
    open = value;
    return <DirectoryExplorerDialog open={value} onOpenChange={setValue} />;
  };
  const mount = async () => { await act(async () => { root.render(<Host />); }); };
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

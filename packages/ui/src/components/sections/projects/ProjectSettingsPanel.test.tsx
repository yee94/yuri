import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ProjectIdentityFields } from './ProjectIdentityFields';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
import { ProjectSettingsSubsection } from './ProjectSettingsSubsection';
import { useProjectIdentityForm } from './useProjectIdentityForm';
import { useProjectIdentityAutoSave } from './useProjectIdentityAutoSave';
import { WorktreeSectionContent } from '../yuri/WorktreeSectionContent';
import { buildSettingsSearchResults } from '@/lib/settings/search';

const fixture = vi.hoisted(() => ({
  save: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  discover: vi.fn(),
  project: { id: 'project-test', path: '/workspace/project', label: 'Project', icon: null, color: null },
  list: vi.fn(async () => [{ path: '/workspace/branch', branch: 'feature', label: 'Feature' }]),
}));

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'dark' }, colors: { surface: { foreground: '#dedede' } } } }),
}));
vi.mock('@/components/sections/agents/ModelSelector', () => ({
  ModelSelector: ({ onChange }: { onChange: (provider: string, model: string) => void }) => (
    <button onClick={() => onChange('provider', 'model')}>Select model</button>
  ),
}));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/stores/useProjectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown) => selector({
    projects: [fixture.project], getActiveProject: () => fixture.project,
    uploadProjectIcon: fixture.upload, removeProjectIcon: fixture.remove, discoverProjectIcon: fixture.discover,
  }),
}));
vi.mock('@/sync/session-ui-store', () => ({
  useSessionUIStore: (selector: (state: unknown) => unknown) => selector({ getWorktreeMetadata: () => null }),
}));
vi.mock('@/sync/sync-context', () => ({ useSessions: () => [] }));
vi.mock('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: (selector: (state: unknown) => unknown) => selector({ homeDirectory: '/home/user' }),
}));
vi.mock('@/stores/useGlobalSessionsStore', () => ({ useGlobalSessionsStore: { getState: () => ({ activeSessions: [], archivedSessions: [] }) } }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false, isTablet: false }) }));
vi.mock('@/lib/gitApi', () => ({ checkIsGitRepository: async () => true }));
vi.mock('@/lib/worktrees/worktreeManager', () => ({ listProjectWorktrees: fixture.list }));

function IdentityEditor() {
  const form = useProjectIdentityForm(fixture.project);
  useProjectIdentityAutoSave(form, fixture.save);
  return <ProjectIdentityFields form={form} />;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.save.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('project settings presentation', () => {
  test.each([false, true])('omits project actions and setup on the shared settings panel (dialog: %s)', async (compact) => {
    await act(async () => root.render(<ProjectSettingsPanel project={fixture.project} onIdentitySave={fixture.save} compact={compact} />));
    expect(host.querySelector('[data-settings-item="projects.name"]')).not.toBeNull();
    expect(host.querySelector('[data-settings-item="projects.worktree"]')).not.toBeNull();
    expect(host.textContent).not.toContain('settings.projects.actions');
    expect(host.textContent).not.toContain('settings.yuri.worktrees.setup');
  });

  test('groups identity fields and preserves selection auto-save without the explanatory paragraph', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<IdentityEditor />));
    expect(host.querySelectorAll('.yuri-settings-group-card')).toHaveLength(1);
    expect(host.querySelectorAll('[data-settings-item]')).toHaveLength(4);
    expect(host.textContent).not.toContain('defaultModelDescription');
    const colors = host.querySelector('[data-settings-item="projects.accent-color"]')!;
    const icons = host.querySelector('[data-settings-item="projects.icon"]')!;
    for (const row of [colors, icons]) {
      expect(row.querySelector('[data-slot="settings-row-footer"] > div')?.classList.contains('pt-2')).toBe(true);
    }
    await act(async () => colors.querySelector<HTMLButtonElement>('button[aria-label="Purple"]')!.click());
    await act(async () => icons.querySelector<HTMLButtonElement>('button[aria-label="Rocket"]')!.click());
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(fixture.save).toHaveBeenLastCalledWith(expect.objectContaining({ color: 'keyword', icon: 'rocket', label: 'Project' }));
    expect(icons.querySelector('button[aria-label="Rocket"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  test('collapses the dialog list without discarding its contents and aligns its trailing icon slot', async () => {
    await act(async () => root.render(
      <ProjectSettingsSubsection title="Worktrees" collapsible count={2}>
        <input defaultValue="Preserved" />
      </ProjectSettingsSubsection>,
    ));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.querySelector('.size-9')).not.toBeNull();
    const input = host.querySelector('input')!;
    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await act(async () => trigger.click());
    expect(host.querySelector('input')).toBe(input);
    expect(input.value).toBe('Preserved');
  });

  test.each([false, true])('keeps existing worktrees but exposes no setup controls (dialog: %s)', async (collapsible) => {
    await act(async () => root.render(<WorktreeSectionContent projectRef={fixture.project} collapsible={collapsible} />));
    expect(host.textContent).toContain('Feature');
    expect(host.textContent).not.toContain('settings.yuri.worktrees.setup');
    expect(host.querySelector('input')).toBeNull();
    expect(host.querySelector('[data-settings-item="projects.worktree"]')).not.toBeNull();
    expect(host.querySelector('[aria-label*="deleteWorktreeAria"]')).not.toBeNull();
  });

  test('does not advertise removed setup controls in Settings search', () => {
    const projectItems = buildSettingsSearchResults({
      query: 'projects',
      runtimeCtx: { isWeb: true, isDesktop: false, isDesktopLocalOrigin: false, isVSCode: false, isMobile: false, isMac: false, isWindows: false },
      visiblePageSlugs: ['projects'],
      t: (key) => key,
      getPageTitle: (slug) => slug,
    });
    expect(projectItems.some((item) => item.id === 'projects.default-model')).toBe(true);
    expect(projectItems.some((item) => item.id.includes('setup') || item.id === 'projects.actions')).toBe(false);
  });
});

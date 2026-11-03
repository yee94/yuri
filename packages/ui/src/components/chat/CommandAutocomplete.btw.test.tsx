import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({ commands: [] as Array<{ name: string; isBuiltIn: boolean }>, skills: [], messages: [] }));
vi.mock('@/queries/commandQueries', () => ({ useCommandsQuery: () => ({ data: fixtures.commands, isFetching: false }) }));
vi.mock('@/queries/installedSkillsQueries', () => ({ useInstalledSkillsQuery: () => ({ data: fixtures.skills }) }));
vi.mock('@/sync/sync-context', () => ({ useSessionMessages: () => fixtures.messages }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: (selector: (state: unknown) => unknown) => selector({ currentSessionId: null, newSessionDraft: null, getDirectoryForSession: () => '/repo' }) }));
vi.mock('@/lib/i18n', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/i18n')>();
  const { dict } = await import('@/lib/i18n/messages/en');
  const t = (key: keyof typeof dict) => dict[key];
  return { ...original, useI18n: () => ({ t, locale: 'en' }) };
});
import { CommandAutocomplete, type CommandAutocompleteHandle } from './CommandAutocomplete';
import { useUIStore } from '@/stores/useUIStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  fixtures.commands = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

test.each([false, true])('native goal has exactly one entry and inserts without local auto-submit (mobile=%s)', async (isMobile) => {
  fixtures.commands = [{ name: 'goal', isBuiltIn: true }];
  useUIStore.setState({ isMobile });
  const ref = React.createRef<CommandAutocompleteHandle>();
  const select = vi.fn();
  await act(async () => root.render(<CommandAutocomplete ref={ref} searchQuery="goal" onCommandSelect={select} onClose={() => {}}
    commandContext={{ sessionID: null, hasMessages: false, hasNewDraft: true }} />));
  const rows = Array.from(document.querySelectorAll('.cursor-pointer'));
  expect(rows.filter((row) => row.textContent?.startsWith('/goal'))).toHaveLength(1);
  await act(async () => ref.current!.handleKeyDown('Enter'));
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ name: 'goal', source: 'opencode' }), false);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; });

test.each([false, true])('btw discovery and Enter/tap open the side conversation directly (mobile=%s)', async (isMobile) => {
  useUIStore.setState({ isMobile });
  const ref = React.createRef<CommandAutocompleteHandle>();
  const select = vi.fn();
  await act(async () => root.render(<CommandAutocomplete ref={ref} searchQuery="btw" directory="/repo" onCommandSelect={select} onClose={() => {}}
    commandContext={{ sessionID: 'session-a', hasMessages: true, hasNewDraft: false }} />));
  expect(document.body.textContent).toContain('/btw');
  await act(async () => ref.current!.handleKeyDown('Enter'));
  expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'btw', source: 'yuri' }), true);
  await act(async () => ref.current!.acceptIndex(0, true));
  expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'btw' }), true);
});

test('btw discovery requires an existing session', async () => {
  await act(async () => root.render(<CommandAutocomplete searchQuery="btw" onCommandSelect={() => {}} onClose={() => {}}
    commandContext={{ sessionID: null, hasMessages: false, hasNewDraft: true }} />));
  expect(document.body.textContent).not.toContain('/btw');
});

test.each(['touch', 'Enter', 'native'] as const)('/new submits exactly once from mobile %s selection', async (selection) => {
  useUIStore.setState({ isMobile: true });
  const ref = React.createRef<CommandAutocompleteHandle>();
  const select = vi.fn();
  await act(async () => root.render(<CommandAutocomplete ref={ref} searchQuery="new" directory="/repo" onCommandSelect={select} onClose={() => {}}
    commandContext={{ sessionID: 'session-a', hasMessages: true, hasNewDraft: false }} />));
  expect(document.body.textContent).toContain('/new');
  await act(async () => {
    if (selection === 'Enter') ref.current!.handleKeyDown('Enter');
    else if (selection === 'native') ref.current!.acceptIndex(0, true);
    else {
      const row = document.querySelector<HTMLElement>('.cursor-pointer')!;
      row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 20, clientY: 20 }));
      row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: 20, clientY: 20 }));
      row.click();
    }
  });
  expect(select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'new', source: 'yuri' }), true);
});

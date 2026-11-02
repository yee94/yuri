import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { Input } from './input';
import { Button } from './button';
import { ShortcutKbd } from './kbd';
import { HelpDialog } from './HelpDialog';

const fixture = vi.hoisted(() => ({ setHelpOpen: vi.fn(), overrides: {} as Record<string, string>, mobile: false }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: fixture.mobile }) }));
vi.mock('@/lib/i18n', async () => {
  const { dict } = await import('@/lib/i18n/messages/en');
  return { useI18n: () => ({ t: (key: keyof typeof dict) => dict[key] ?? key }) };
});
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: { isHelpDialogOpen: boolean; setHelpDialogOpen: typeof fixture.setHelpOpen; shortcutOverrides: Record<string, string> }) => unknown) => selector({
    isHelpDialogOpen: true, setHelpDialogOpen: fixture.setHelpOpen, shortcutOverrides: fixture.overrides,
  }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.setHelpOpen.mockClear();
  fixture.overrides = {};
  fixture.mobile = false;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const saveEvidence = (name: string) => {
  if (!process.env.YURI_TEST_EVIDENCE_DIR) return;
  mkdirSync(process.env.YURI_TEST_EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(process.env.YURI_TEST_EVIDENCE_DIR, name), document.body.innerHTML);
};

describe('desktop picker presentation', () => {
  test.each(['default', 'picker'] as const)('keeps the real portal, accessible title and close behavior (%s)', async (presentation) => {
    const onOpenChange = vi.fn();
    await act(async () => root.render(<Dialog open onOpenChange={onOpenChange}>
      <DialogContent presentation={presentation} initialFocus={false}>
        <DialogHeader><DialogTitle>Picker test</DialogTitle></DialogHeader>
        <Button>Action</Button>
      </DialogContent>
    </Dialog>));
    const popup = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    expect(popup.getAttribute('data-presentation')).toBe(presentation);
    expect(popup.classList.contains('yuri-composer-autocomplete-surface')).toBe(presentation === 'picker');
    expect(document.getElementById(popup.getAttribute('aria-labelledby')!)?.textContent).toBe('Picker test');
    expect(popup.parentElement?.className).toContain(presentation === 'picker' ? 'block p-0' : 'items-center p-4');
    expect(document.querySelector('[data-slot="dialog-overlay"]')?.className.includes('bg-transparent')).toBe(presentation === 'picker');
    const close = popup.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]');
    if (presentation === 'default') {
      expect(close).not.toBeNull();
      await act(async () => close!.click());
    } else {
      expect(close).toBeNull();
      await act(async () => popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    }
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  test('picker backdrop remains a dismissal target without a close button', async () => {
    const onOpenChange = vi.fn();
    await act(async () => root.render(<Dialog open onOpenChange={onOpenChange}>
      <DialogContent presentation="picker" initialFocus={false}><DialogTitle>Picker test</DialogTitle></DialogContent>
    </Dialog>));
    const backdrop = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!;
    await act(async () => {
      backdrop.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', button: 0, bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      backdrop.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse', button: 0, bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
      backdrop.click();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  test('explicit close-button opt-in and opt-out remain available', async () => {
    for (const visible of [true, false]) {
      await act(async () => root.render(<Dialog open>
        <DialogContent presentation="picker" showCloseButton={visible} initialFocus={false}><DialogTitle>Picker test</DialogTitle></DialogContent>
      </Dialog>));
      expect(Boolean(document.querySelector('[data-slot="dialog-close"]'))).toBe(visible);
    }
  });

  test('list selection and footer actions remain independent in the real picker portal', async () => {
    const selected = vi.fn();
    const confirmed = vi.fn();
    await act(async () => root.render(<Dialog open>
      <DialogContent presentation="picker" initialFocus={false}>
        <DialogHeader className="yuri-picker-header"><DialogTitle className="yuri-picker-title">Select a conversation</DialogTitle></DialogHeader>
        <div className="yuri-picker-search"><Input aria-label="Search conversations" placeholder="Search conversations…" /></div>
        <div className="yuri-picker-list">
          {Array.from({ length: 32 }, (_, index) => <button key={index} type="button" className="yuri-picker-row flex w-full text-left" onClick={() => selected(index)}>
            <span className="min-w-0 flex-1">
              <span className="yuri-picker-label block truncate">{index === 0 ? 'A long conversation title that must truncate without moving the actions or making the picker wider than the viewport' : `Conversation ${index + 1}`}</span>
              <span className="yuri-picker-meta block truncate text-muted-foreground">Example project · updated recently</span>
            </span>
          </button>)}
        </div>
        <DialogFooter className="yuri-picker-footer">
          <Button onClick={confirmed}>Select</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>));
    await act(async () => document.querySelector<HTMLButtonElement>('.yuri-picker-row')!.click());
    expect(selected).toHaveBeenCalledWith(0);
    expect(confirmed).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLButtonElement>('.yuri-picker-footer button')!.click());
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.yuri-picker-list .yuri-picker-footer')).toBeNull();
    saveEvidence('picker-list.html');
  });

  test('actual HelpDialog uses the shared surface and hint badges while preserving remapped keys', async () => {
    fixture.overrides = { open_command_palette: 'ctrl+shift+k' };
    await act(async () => root.render(<HelpDialog />));
    const popup = document.querySelector('[data-slot="dialog-content"]')!;
    expect(popup.getAttribute('data-presentation')).toBe('picker');
    expect(popup.querySelectorAll('kbd[data-variant="hint"]').length).toBeGreaterThan(20);
    expect(popup.querySelector('kbd[data-variant="default"]')).toBeNull();
    expect(popup.querySelector('[data-slot="dialog-close"]')).toBeNull();
    const first = popup.querySelector('.yuri-help-shortcut-row')!;
    expect(first.querySelector('kbd[aria-label="K"]')).not.toBeNull();
    expect(popup.textContent).not.toContain('Pro tips');
    saveEvidence('picker-help.html');
  });

  test('hint chords render icon keys and neutral badges without changing the default keycap contract', async () => {
    await act(async () => root.render(<>
      <ShortcutKbd shortcut="⌘ + Enter + ArrowDown" variant="hint" />
      <ShortcutKbd shortcut="Ctrl + K" />
    </>));
    const hints = host.querySelectorAll('kbd[data-variant="hint"]');
    expect(hints).toHaveLength(3);
    expect(hints[0].querySelector('svg')).not.toBeNull();
    expect(hints[1].getAttribute('aria-label')).toBe('Enter');
    expect(host.querySelectorAll('kbd[data-variant="default"]')).toHaveLength(2);
    expect(host.querySelector('kbd[data-variant="default"]')?.textContent).toBe('Ctrl');
  });

  test('mobile help keeps its default dialog geometry instead of desktop picker positioning', async () => {
    fixture.mobile = true;
    await act(async () => root.render(<HelpDialog />));
    const popup = document.querySelector('[data-slot="dialog-content"]')!;
    expect(popup.getAttribute('data-presentation')).toBe('default');
    expect(popup.classList.contains('yuri-picker-dialog')).toBe(false);
    expect(popup.className).toContain('max-h-[calc(100dvh-2rem)]');
    expect(popup.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
  });
});

describe('desktop picker audit coverage', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  test.each([
    '../session/DirectoryExplorerDialog.tsx', '../chat/TimelineDialog.tsx',
    '../session/GitHubIssuePickerDialog.tsx', '../session/GitHubPrPickerDialog.tsx',
    '../session/GitHubIntegrationDialog.tsx', '../views/git/StashesDialog.tsx',
    '../sections/yuri/ArchivedSessionsDialog.tsx', './HelpDialog.tsx',
  ])('opts into the shared presentation: %s', (path) => {
    expect(readFileSync(join(here, path), 'utf8')).toMatch(/presentation=(?:"picker"|\{isMobile \? 'default' : 'picker'\})/);
  });
  test('global search opts in only for the desktop dialog, leaving mobile page geometry explicit', () => {
    expect(readFileSync(join(here, 'CommandPalette.tsx'), 'utf8')).toContain("presentation={isMobile ? 'default' : 'picker'}");
  });
});

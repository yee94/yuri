import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
} from './dropdown-menu';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from './context-menu';
import { Select, SelectTrigger, SelectContent, SelectItem } from './select';
import { changedFilesPopoverClassName, changedFilesPopoverStyle } from '../chat/changedFilesPopover';
import { ChangedFilesList } from '../chat/ChangedFilesList';

const fixture = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: fixture.mobile }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./MobileResizableSheet', () => ({ MobileResizableSheet: ({ children }: React.PropsWithChildren) => <div data-testid="mobile-sheet">{children}</div> }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: { isMobile: boolean }) => unknown) => select({ isMobile: fixture.mobile }) }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.mobile = false;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const expectGlass = (popup: HTMLElement | null) => {
  expect(popup).not.toBeNull();
  expect(popup!.classList.contains('yuri-mobile-overlay-surface')).toBe(true);
  expect(popup!.classList.contains('yuri-popup-surface')).toBe(true);
  expect(popup!.style.backgroundColor).toBe('');
  expect(popup!.className).not.toContain('shadow-[');
};
const evidence = (name: string) => {
  if (!process.env.YURI_TEST_EVIDENCE_DIR) return;
  mkdirSync(process.env.YURI_TEST_EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(process.env.YURI_TEST_EVIDENCE_DIR, `popup-${name}.html`), document.body.innerHTML);
};

test('menu and nested menu share popup glass without changing item selection', async () => {
  const selected = vi.fn();
  await act(async () => root.render(<DropdownMenu open>
    <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
    <DropdownMenuContent>
      <DropdownMenuItem onSelect={selected}>Open file</DropdownMenuItem>
      <DropdownMenuSub open>
        <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
        <DropdownMenuSubContent><DropdownMenuItem>Nested action</DropdownMenuItem></DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuContent>
  </DropdownMenu>));
  expectGlass(document.querySelector('[data-slot="dropdown-menu-content"]'));
  expectGlass(document.querySelector('[data-slot="dropdown-menu-sub-content"]'));
  evidence('menu');
  await act(async () => document.querySelector<HTMLElement>('[data-slot="dropdown-menu-item"]')!.click());
  expect(selected).toHaveBeenCalledTimes(1);
});

test('context menu uses the same material and preserves actions', async () => {
  const selected = vi.fn();
  await act(async () => root.render(<ContextMenu open>
    <ContextMenuTrigger>Context target</ContextMenuTrigger>
    <ContextMenuContent><ContextMenuItem onClick={selected}>Copy path</ContextMenuItem></ContextMenuContent>
  </ContextMenu>));
  expectGlass(document.querySelector('[data-slot="dropdown-menu-content"]'));
  await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click());
  expect(selected).toHaveBeenCalledTimes(1);
});

test('desktop select shares glass and retains value changes and scroll wrapper', async () => {
  const selected = vi.fn();
  await act(async () => root.render(<Select open onValueChange={selected}>
    <SelectTrigger aria-label="Choose a branch">Branch</SelectTrigger>
    <SelectContent>
      <SelectItem value="main">main</SelectItem><SelectItem value="feature">feature</SelectItem>
    </SelectContent>
  </Select>));
  const popup = document.querySelector<HTMLElement>('[data-slot="select-content"]');
  expectGlass(popup);
  expect(popup!.querySelector('[data-slot="select-item"]')).not.toBeNull();
  evidence('select');
  await act(async () => {
    const item = popup!.querySelector<HTMLElement>('[data-slot="select-item"]')!;
    item.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    item.click();
  });
  expect(selected).toHaveBeenCalledWith('main', expect.anything());
});

test('explicit menu caller styles remain authoritative', async () => {
  await act(async () => root.render(<DropdownMenu open>
    <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
    <DropdownMenuContent style={{ backgroundColor: 'var(--surface-muted)' }}><DropdownMenuItem>Action</DropdownMenuItem></DropdownMenuContent>
  </DropdownMenu>));
  expect(document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]')!.style.backgroundColor).toBe('var(--surface-muted)');
});

test('mobile Select leaves material with the sheet rather than its inner popup', async () => {
  fixture.mobile = true;
  await act(async () => root.render(<Select open>
    <SelectTrigger aria-label="Choose a branch">Branch</SelectTrigger>
    <SelectContent><SelectItem value="main">main</SelectItem></SelectContent>
  </Select>));
  const popup = document.querySelector<HTMLElement>('[data-slot="select-content"]')!;
  expect(popup.closest('[data-testid="mobile-sheet"]')).not.toBeNull();
  expect(popup.classList.contains('yuri-popup-surface')).toBe(false);
  expect(popup.className).toContain('bg-transparent');
  expect(popup.className).toContain('shadow-none');
});

test('changed-file geometry stays independent of the shared material', async () => {
  const opened = vi.fn();
  await act(async () => root.render(<section className={changedFilesPopoverClassName} style={changedFilesPopoverStyle}>
    <ChangedFilesList currentDirectory="/workspace" onOpenFile={opened} files={Array.from({ length: 30 }, (_, index) => ({ path: `/workspace/src/components/example-${index}.tsx`, tool: 'edit', partId: `part-${index}`, messageID: 'message', additions: 12, deletions: 3 }))} />
  </section>));
  expectGlass(host.querySelector('section'));
  expect(changedFilesPopoverStyle.maxWidth).toBe('min(28rem, calc(100cqw - 4ch))');
  evidence('changes');
  await act(async () => host.querySelector('button')!.click());
  expect(opened).toHaveBeenCalledWith(expect.objectContaining({ path: '/workspace/src/components/example-0.tsx' }));
});

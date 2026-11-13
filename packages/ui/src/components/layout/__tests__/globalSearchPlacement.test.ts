import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const titlebarSource = readFileSync(join(__dirname, '..', 'TitlebarLeftControls.tsx'), 'utf-8');
const headerSource = readFileSync(join(__dirname, '..', 'Header.tsx'), 'utf-8');
const windowsWindowControlsSource = readFileSync(join(__dirname, '..', '..', 'desktop', 'WindowsWindowControls.tsx'), 'utf-8');
const sessionSidebarSource = readFileSync(join(__dirname, '..', '..', 'session', 'SessionSidebar.tsx'), 'utf-8');

describe('Electron global search placement', () => {
  test('renders global search beside a configured desktop brand outside the scroll region', () => {
    const brandHeaderIndex = sessionSidebarSource.indexOf('const desktopBrandHeader =');
    expect(brandHeaderIndex).toBeGreaterThan(-1);

    const brandHeaderSource = sessionSidebarSource.slice(brandHeaderIndex, brandHeaderIndex + 1_200);
    const brandIndex = brandHeaderSource.indexOf('<SidebarBrandMark className="min-w-0 flex-1" />');
    const searchIndex = brandHeaderSource.indexOf('<GlobalSearchButton className="ml-auto shrink-0" />');

    expect(brandHeaderSource).toContain('isDesktopShellRuntime && hasSidebarBrand && !isVSCode && !hasSessionSearchQuery');
    expect(brandHeaderSource).toContain('shrink-0');
    expect(brandHeaderSource).toContain('<div className="flex items-center justify-between">');
    expect(brandIndex).toBeGreaterThan(-1);
    expect(searchIndex).toBeGreaterThan(brandIndex);
    expect(searchIndex - brandIndex).toBeLessThan(200);

    // Fixed brand header is rendered above the scrollable projects list.
    const desktopBrandRenderIndex = sessionSidebarSource.indexOf('{desktopBrandHeader}');
    const projectsListIndex = sessionSidebarSource.indexOf('<SidebarProjectsList');
    expect(desktopBrandRenderIndex).toBeGreaterThan(-1);
    expect(projectsListIndex).toBeGreaterThan(desktopBrandRenderIndex);

    // Desktop nav rows share that fixed region; they are not inside the scroll body.
    const pinIndex = sessionSidebarSource.indexOf('const pinSidebarActionButtons =');
    expect(sessionSidebarSource.slice(pinIndex, pinIndex + 160)).toContain('isDesktop && !mobileVariant');
    expect(sessionSidebarSource.slice(pinIndex, pinIndex + 160)).not.toContain('isDesktopShellRuntime');
    const pinnedNavIndex = sessionSidebarSource.indexOf('{pinSidebarActionButtons ? (');
    expect(pinnedNavIndex).toBeGreaterThan(desktopBrandRenderIndex);
    expect(projectsListIndex).toBeGreaterThan(pinnedNavIndex);
    expect(sessionSidebarSource.slice(pinnedNavIndex, pinnedNavIndex + 160)).toContain('shrink-0');

    // Empty brand config must not reserve a desktop brand/search row in scroll content.
    // Pinned desktop nav is also excluded from the scroll body; mobile still carries the brand mark there.
    const topContentIndex = sessionSidebarSource.indexOf('const topContent =');
    const topContentSource = sessionSidebarSource.slice(topContentIndex, topContentIndex + 1_200);
    expect(topContentSource).not.toContain('<GlobalSearchButton');
    expect(topContentSource).toContain('!pinSidebarActionButtons');
    expect(topContentSource).toContain('mobileVariant && hasSidebarBrand');
  });

  test('keeps the titlebar trigger for collapsed Electron sidebars and logo-less open sidebars', () => {
    expect(titlebarSource).toContain(
      'const showGlobalSearchInTitlebar = !isDesktopShellRuntime || !isSidebarOpen || !hasSidebarBrand;',
    );
    expect(titlebarSource).toContain(
      '{showGlobalSearchInTitlebar ? <GlobalSearchButton /> : null}',
    );
  });

  test('fullscreen keeps the brand and navigation fixed without duplicating the titlebar brand or search', () => {
    const brandCondition = sessionSidebarSource.match(/const desktopBrandHeader =\s*([\s\S]*?)\? \(/)![1];
    const navCondition = sessionSidebarSource.match(/const pinSidebarActionButtons = (.*);/)![1];
    const showActionsCondition = sessionSidebarSource.match(/const showSidebarActionButtons = (.*);/)![1];
    const searchCondition = titlebarSource.match(/const showGlobalSearchInTitlebar = (.*);/)![1];
    const webHeaderCondition = titlebarSource.match(/const usesWebSidebarHeader = ([\s\S]*?);/)![1];
    const evaluate = (expression: string, state: Record<string, unknown>) =>
      new Function(...Object.keys(state), `const showSidebarActionButtons = ${showActionsCondition}; return (${expression});`)(...Object.values(state));

    for (const fullscreen of [false, true, false]) {
      const state = {
        isDesktopShellRuntime: true, isDesktopWindowFullscreen: fullscreen,
        hasSidebarBrand: true, isVSCode: false, hasSessionSearchQuery: false,
        isDesktop: true, mobileVariant: false, isSidebarOpen: true,
        isVSCodeRuntime: () => false, isWebRuntime: () => false,
      };
      expect(evaluate(brandCondition, state)).toBe(true);
      expect(evaluate(navCondition, state)).toBe(true);
      expect(evaluate(searchCondition, state)).toBe(false);
      expect(evaluate(webHeaderCondition, state)).toBe(false);
      expect(evaluate(searchCondition, { ...state, isSidebarOpen: false })).toBe(true);
      expect(evaluate(searchCondition, { ...state, hasSidebarBrand: false })).toBe(true);
      expect(evaluate(navCondition, { ...state, mobileVariant: true })).toBe(false);
      expect(evaluate(navCondition, { ...state, hasSessionSearchQuery: true })).toBe(false);
    }
  });
});

describe('Windows titlebar surfaces', () => {
  test('uses an opaque theme surface only for Windows chrome', () => {
    expect(headerSource).toContain("usesSolidWindowsChrome = isDesktopApp && getElectronPlatform() === 'win32'");
    expect(headerSource).toContain("usesSolidWindowsChrome && 'bg-[var(--surface-background)] backdrop-blur-none'");
    expect(windowsWindowControlsSource).toContain("usesSolidWindowsChrome = getElectronPlatform() === 'win32'");
    expect(windowsWindowControlsSource.match(/usesSolidWindowsChrome && 'bg-\[var\(--surface-background\)\] backdrop-blur-none'/g)).toHaveLength(2);
  });
});

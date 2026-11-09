import { afterEach, describe, expect, test } from 'vitest';
import { withBaseTextFloor } from './baseTextColors';
import { CSSVariableGenerator } from './cssGenerator';
import { getThemeById, themes } from './themes';
import { registerRuntimeAPIs } from '../../contexts/runtimeAPIRegistry';
import { SEMANTIC_TYPOGRAPHY, VSCODE_TYPOGRAPHY } from '../typography';

afterEach(() => {
  document.getElementById('opencode-theme-variables')?.remove();
  document.documentElement.classList.remove('dark', 'light');
  document.documentElement.removeAttribute('data-theme');
});

describe('primary-text brightness floor', () => {
  test('resolves VS Code typography from current runtime authority on every generation', () => {
    const previous = Object.getOwnPropertyDescriptor(window, '__YURI_RUNTIME_APIS__');
    registerRuntimeAPIs(null);
    const generator = new CSSVariableGenerator();
    try {
      for (const isVSCode of [false, true, false]) {
        Object.defineProperty(window, '__YURI_RUNTIME_APIS__', { configurable: true, value: { runtime: { isVSCode } } });
        const typography = isVSCode ? VSCODE_TYPOGRAPHY : SEMANTIC_TYPOGRAPHY;
        expect(generator.generate(getThemeById('cursor-dark')!)).toContain(`--text-markdown: ${typography.markdown};`);
      }
    } finally {
      if (previous) Object.defineProperty(window, '__YURI_RUNTIME_APIS__', previous);
      else Reflect.deleteProperty(window, '__YURI_RUNTIME_APIS__');
    }
  });

  test.each([
    ['flexoki-light', '#212121'],
    ['jetbrains-light', '#212121'],
    ['dracula-light', '#212121'],
    ['solarized-dark', '#DEDEDE'],
    ['onedarkpro-dark', '#DEDEDE'],
    ['catppuccin-dark', '#DEDEDE'],
    ['vitesse-dark-dark', '#DEDEDE'],
  ])('lifts darker base text in %s, including explicit component overrides', (id, foreground) => {
    const theme = getThemeById(id)!;
    const before = JSON.stringify(theme);
    const resolved = withBaseTextFloor(theme);
    const css = new CSSVariableGenerator().generate(theme);

    expect(resolved.colors.surface.foreground).toBe(foreground);
    expect(resolved.colors.surface.elevatedForeground).toBe(foreground);
    for (const token of ['foreground', 'card-foreground', 'popover-foreground']) {
      expect(css).toContain(`--${token}: ${foreground} !important;`);
    }
    for (const token of ['surface-foreground', 'surface-elevated-foreground', 'chat-user-message', 'chat-assistant-message']) {
      expect(css).toContain(`--${token}: ${foreground};`);
    }
    expect(resolved.colors.chat?.userMessage).toBe(foreground);
    expect(resolved.colors.chat?.assistantMessage).toBe(foreground);
    expect(resolved.colors.tools?.title).toBe(foreground);
    expect(JSON.stringify(theme)).toBe(before);
  });

  test.each(['carbonfox-light', 'cursor-dark', 'carbonfox-dark', 'vesper-dark', 'gruvbox-light'])(
    'preserves brighter primary text and stable references for %s', (id) => {
      const theme = getThemeById(id)!;
      expect(withBaseTextFloor(theme)).toBe(theme);
    },
  );

  test('keeps semantic and secondary colors for every registered theme and is idempotent', () => {
    for (const theme of themes) {
      const resolved = withBaseTextFloor(theme);
      expect(withBaseTextFloor(resolved), theme.metadata.id).toBe(resolved);
      for (const key of ['primary', 'interactive', 'syntax', 'status', 'pr'] as const) {
        expect(resolved.colors[key], `${theme.metadata.id}: ${key}`).toBe(theme.colors[key]);
      }
      expect(resolved.colors.surface.mutedForeground).toBe(theme.colors.surface.mutedForeground);
      for (const key of ['background', 'muted', 'elevated', 'overlay', 'subtle'] as const) {
        expect(resolved.colors.surface[key]).toBe(theme.colors.surface[key]);
      }
      for (const key of ['link', 'inlineCode', 'blockquote']) {
        expect(resolved.colors.markdown?.[key]).toBe(theme.colors.markdown?.[key]);
      }
      expect(resolved.colors.chat?.timestamp).toBe(theme.colors.chat?.timestamp);
      expect(resolved.colors.tools?.description).toBe(theme.colors.tools?.description);
    }
  });

  test('meets the primary-text floor across the entire built-in catalog', () => {
    const brightness = (hex: string) => [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
      const value = Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
      return sum + weight * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    }, 0);
    for (const theme of themes) {
      const resolved = withBaseTextFloor(theme);
      const minimum = brightness(theme.metadata.variant === 'dark' ? '#DEDEDE' : '#212121');
      const colors = [
        resolved.colors.surface.foreground, resolved.colors.surface.elevatedForeground,
        resolved.colors.chat?.userMessage, resolved.colors.chat?.assistantMessage, resolved.colors.tools?.title,
      ];
      for (const color of colors) {
        if (color) expect(brightness(color) + 1e-9, `${theme.metadata.id}: ${color}`).toBeGreaterThanOrEqual(minimum);
      }
    }
  });

  test('lifts neutral headings but retains colored accent headings', () => {
    const neutral = withBaseTextFloor(getThemeById('mono-plus-dark')!);
    expect(neutral.colors.markdown?.heading1).toBe('#FFFFFF');
    expect(neutral.colors.markdown?.heading4).toBe('#DEDEDE');
    const accent = withBaseTextFloor(getThemeById('yuri-light')!);
    expect(accent.colors.markdown?.heading1).toBe('#8c5520');
    expect(accent.colors.markdown?.heading4).toBe('#212121');
  });

  test('handles custom/embedded hex colors and alpha on the actual surface', () => {
    const theme = structuredClone(getThemeById('cursor-dark')!);
    theme.metadata.id = 'custom-theme';
    theme.colors.surface.foreground = '#fff8';
    theme.colors.surface.elevatedForeground = '#fff';
    theme.colors.chat = { userMessage: '#000', userMessageBackground: '#fff', assistantMessage: '#ffffff80' };
    const resolved = withBaseTextFloor(theme);
    expect(resolved.colors.surface.foreground).toBe('#DEDEDE');
    expect(resolved.colors.surface.elevatedForeground).toBe('#fff');
    expect(resolved.colors.chat?.userMessage).toBe('#DEDEDE');
    expect(resolved.colors.chat?.assistantMessage).toBe('#DEDEDE');
    expect(theme.colors.surface.foreground).toBe('#fff8');
  });

  test('does not reinterpret unsupported custom CSS colors', () => {
    const theme = structuredClone(getThemeById('cursor-dark')!);
    theme.colors.surface.foreground = 'var(--custom-text)';
    expect(withBaseTextFloor(theme).colors.surface.foreground).toBe('var(--custom-text)');
  });

  test('applies the floor again when switching themes and variants', () => {
    const generator = new CSSVariableGenerator();
    for (const [id, color] of [
      ['solarized-dark', '#DEDEDE'], ['jetbrains-light', '#212121'], ['carbonfox-dark', '#F2F4F8'],
    ]) {
      generator.apply(getThemeById(id)!);
      expect(document.querySelectorAll('#opencode-theme-variables')).toHaveLength(1);
      expect(document.getElementById('opencode-theme-variables')?.textContent)
        .toContain(`--foreground: ${color} !important;`);
      expect(document.documentElement.classList.contains(id.endsWith('light') ? 'light' : 'dark')).toBe(true);
    }
  });
});

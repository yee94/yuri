import { describe, expect, test } from 'vitest';
import { isValidTheme } from '@/contexts/theme-validation';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { buildTextMateThemeFromAppTheme } from '@/lib/shiki/textMateThemeFromAppTheme';
import { getDefaultTheme, getThemeById, themes } from '@/lib/theme/themes';

/** Matches YuriVisualSettings formatThemeLabel: variant pickers strip the suffix. */
const selectorLabel = (name: string, variant: 'light' | 'dark'): string => {
  const suffix = variant === 'dark' ? ' Dark' : ' Light';
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
};

const registered = [
  {
    id: 'cursor-dark',
    variant: 'dark' as const,
    label: 'Cursor',
    primary: '#4c9df3',
    background: '#1a1a1a',
  },
  {
    id: 'cursor-light',
    variant: 'light' as const,
    label: 'Cursor',
    primary: '#2567A8',
    background: '#FCFCFC',
  },
  {
    id: 'osaka-jade-refined',
    variant: 'dark' as const,
    label: 'Osaka Jade Refined',
    primary: '#2DD5B7',
    background: '#111c18',
  },
  {
    id: 'osaka-jade-refined-light',
    variant: 'light' as const,
    label: 'Osaka Jade Refined',
    primary: '#206B5C',
    background: '#F6F5E9',
  },
];

describe('built-in Cursor and Osaka Jade palettes', () => {
  test('defaults to Cursor at night and Carbonfox by day', () => {
    expect(getDefaultTheme(true).metadata.id).toBe('cursor-dark');
    expect(getDefaultTheme(true).colors.surface.background).toBe('#1a1a1a');
    expect(getDefaultTheme(false).metadata.id).toBe('carbonfox-light');
  });

  test('registers both variants so the selector can apply their colors', () => {
    const generator = new CSSVariableGenerator();

    for (const expected of registered) {
      const theme = getThemeById(expected.id);
      expect(theme, expected.id).toBeDefined();
      expect(theme?.metadata.variant).toBe(expected.variant);
      expect(selectorLabel(theme?.metadata.name ?? '', expected.variant)).toBe(expected.label);
      expect(isValidTheme(theme)).toBe(true);
      expect(theme?.colors.primary.base).toBe(expected.primary);
      expect(theme?.colors.surface.background).toBe(expected.background);

      const css = generator.generate(theme!);
      expect(css).toContain(`--primary-base: ${expected.primary};`);
      expect(css).toContain(`--background: ${expected.background} !important;`);
      expect(css).not.toContain('undefined');

      const highlight = buildTextMateThemeFromAppTheme(theme!);
      expect(highlight.type).toBe(expected.variant);
      expect(highlight.colors).toBeDefined();
      expect(highlight.colors?.['editor.background']).toBe(expected.background);
      expect(highlight.colors?.['button.background']).toBe(expected.primary);
    }
  });

  test('keeps Cursor Dark primary text opaque light gray without flattening secondary or semantic colors', () => {
    const theme = getDefaultTheme(true);
    const css = new CSSVariableGenerator().generate(theme);

    for (const token of ['foreground', 'card-foreground', 'popover-foreground']) {
      expect(css).toContain(`--${token}: #DEDEDE !important;`);
    }

    for (const token of [
      'surface-foreground', 'surface-elevated-foreground',
      'chat-user-message', 'chat-assistant-message',
      'markdown-heading4', 'markdown-bold', 'markdown-blockquote',
    ]) {
      expect(css).toContain(`--${token}: #DEDEDE;`);
    }

    expect(css).toContain('--muted-foreground: #848484 !important;');
    expect(css).toContain('--secondary-foreground: #848484 !important;');
    expect(css).toContain('--sidebar-accent-foreground: #DEDEDE !important;');
    for (const token of ['surface-muted-foreground', 'chat-timestamp', 'chat-typing', 'markdown-strikethrough']) {
      expect(css).toContain(`--${token}: #848484;`);
    }
    expect(css).toContain('--tools-title: color-mix(in srgb, #DEDEDE 50%, #848484);');
    expect(css).toContain('--tools-description: #848484cc;');
    expect(css).toContain('--markdown-heading1: #4c9df3;');
    expect(css).toContain('--markdown-heading2: #4c9df3e6;');
    expect(css).toContain('--markdown-heading3: #4c9df3cc;');
    expect(css).toContain('--markdown-italic: #DEDEDEe6;');
    expect(theme.colors.markdown?.link).toBe('#4c9df3');
    expect(theme.colors.markdown?.inlineCode).toBe('#88C0D0');
    expect(theme.colors.syntax.base.foreground).toBe('#D8DEE9');
    expect(theme.colors.status.error).toBe('#BF616A');
    expect(getDefaultTheme(false).colors.surface.foreground).not.toBe('#FFFFFF');
  });

  test('uses dark gray for Carbonfox Light primary text without changing secondary or semantic colors', () => {
    const theme = getDefaultTheme(false);
    const css = new CSSVariableGenerator().generate(theme);

    expect(isValidTheme(theme)).toBe(true);
    for (const token of ['foreground', 'card-foreground', 'popover-foreground', 'sidebar-accent-foreground']) {
      expect(css).toContain(`--${token}: #212121 !important;`);
    }
    for (const token of [
      'surface-foreground', 'surface-elevated-foreground',
      'chat-user-message', 'chat-assistant-message',
      'markdown-heading1', 'markdown-heading2', 'markdown-heading3', 'markdown-heading4', 'markdown-bold',
    ]) {
      expect(css).toContain(`--${token}: #212121;`);
    }
    expect(css).toContain('--tools-title: color-mix(in srgb, #212121 50%, #868585);');
    expect(css).toContain('--muted-foreground: #868585 !important;');
    expect(theme.colors.markdown?.blockquote).toBe('#525252');
    expect(theme.colors.markdown?.link).toBe('#0072C3');
    expect(theme.colors.markdown?.inlineCode).toBe('#198038');
    expect(theme.colors.chat?.timestamp).toBe('#525252');
    expect(theme.colors.tools?.description).toBe('#525252');
    expect(theme.colors.syntax.base.foreground).toBe('#161616');
    expect(theme.colors.status.error).toBe('#DA1E28');
  });

  test('keeps previously registered themes and does not enable other commented palettes', () => {
    const ids = new Set(themes.map((theme) => theme.metadata.id));

    for (const id of [
      'carbonfox-light',
      'vitesse-dark-dark',
      'flexoki-dark',
      'flexoki-light',
      'dracula-dark',
      'yuri-dark',
      'yuri-light',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }

    for (const id of ['github-dark', 'github-light', 'amoled-dark', 'vercel-dark', 'zenburn-dark', 'rosepine-dark']) {
      expect(ids.has(id), id).toBe(false);
    }
  });
});

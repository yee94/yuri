import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kbd, ShortcutKbd } from './kbd';

describe('Kbd', () => {
  test('hint uses the compact neutral sidebar recipe instead of selection styling', () => {
    const key = Kbd({ variant: 'hint', children: '⌘1' });
    expect(key.props['data-variant']).toBe('hint');
    for (const token of ['h-3.5', 'min-w-0', 'rounded-full', 'border-0', 'px-1.5', 'font-sans', 'text-[10px]', 'text-muted-foreground/65', 'dark:shadow-none']) {
      expect(key.props.className.split(' ')).toContain(token);
    }
    expect(key.props.className).toContain('var(--surface-foreground)_6%');
    expect(key.props.className).not.toContain('bg-interactive-selection');
    expect(key.props.className).not.toContain('font-mono');
  });

  test('ordinary keycaps and chord rendering keep their existing defaults', () => {
    const key = Kbd({ children: 'Enter' });
    expect(key.props['data-variant']).toBe('default');
    expect(key.props.className.split(' ')).toContain('h-5');
    expect(key.props.className.split(' ')).toContain('font-mono');
    expect(key.props.className).toContain('bg-[var(--surface-muted)]');
    expect(ShortcutKbd({ shortcut: '⌘+N' })?.props['data-slot']).toBe('shortcut-kbd');
  });

  test('sidebar and all global-search shortcut consumers use the same variant', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sidebar = readFileSync(path.join(here, '../session/sidebar/SessionNodeItem.tsx'), 'utf8');
    const palette = readFileSync(path.join(here, 'CommandPalette.tsx'), 'utf8');
    expect(sidebar).toMatch(/<Kbd\s+data-sidebar-shortcut-number=\{number\}\s+variant="hint"/);
    const paletteKeycaps = palette.match(/<Kbd\b[^>]*>/g) ?? [];
    expect(paletteKeycaps.length).toBeGreaterThan(0);
    for (const keycap of paletteKeycaps) expect(keycap).toContain('variant="hint"');
    expect(palette).not.toMatch(/<Kbd[^>]*bg-interactive-selection/);
  });
});

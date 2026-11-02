import * as React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';

/**
 * Single keyboard keycap. Use for shortcut hints and chord previews.
 * Keep content short (one modifier or one key); wrap sequences with ShortcutKbd.
 */
export function Kbd({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'kbd'> & { variant?: 'default' | 'hint' }) {
  return (
    <kbd
      data-slot="kbd"
      data-variant={variant}
      className={cn(
        'pointer-events-none inline-flex h-5 min-w-5 shrink-0 select-none items-center justify-center',
        'rounded-md border border-[var(--interactive-border)] bg-[var(--surface-muted)]',
        'px-1.5 font-mono typography-micro font-medium leading-none normal-case',
        'text-[var(--surface-muted-foreground)] whitespace-nowrap',
        'shadow-[inset_0_-1px_0_0_rgba(0,0,0,0.12)]',
        'dark:shadow-[inset_0_-1px_0_0_rgba(255,255,255,0.08)]',
        variant === 'hint' && 'h-3.5 min-w-0 shrink-0 rounded-full border-0 bg-[color-mix(in_srgb,var(--surface-foreground)_6%,transparent)] px-1.5 font-sans text-[10px] font-medium tracking-tight text-muted-foreground/65 shadow-none dark:shadow-none',
        className,
      )}
      {...props}
    />
  );
}

type ShortcutKbdProps = {
  /** Display string from formatShortcutForDisplay, e.g. "⌃ + X" or "Ctrl + Shift + M". */
  shortcut: string;
  className?: string;
  /** Optional keycap tone for the pending/active chord state. */
  tone?: 'default' | 'selection';
  variant?: 'default' | 'hint';
};

const shortcutIcons: Record<string, IconName> = {
  '⌘': 'command', cmd: 'command', command: 'command', meta: 'command',
  '↵': 'corner-down-left', enter: 'corner-down-left', return: 'corner-down-left',
  '↑': 'arrow-up', arrowup: 'arrow-up',
  '↓': 'arrow-down', arrowdown: 'arrow-down',
  '←': 'arrow-left', arrowleft: 'arrow-left',
  '→': 'arrow-right', arrowright: 'arrow-right',
  '⇧': 'arrow-up', shift: 'arrow-up',
};

/**
 * Renders a shortcut as a horizontal row of keycaps joined by "+".
 * Splits on "+" so multi-key combos never wrap into a single tall kbd.
 */
export function ShortcutKbd({ shortcut, className, tone = 'default', variant = 'default' }: ShortcutKbdProps) {
  const tokens = shortcut
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return null;
  }

  return (
    <span
      data-slot="shortcut-kbd"
      className={cn('inline-flex items-center gap-1 whitespace-nowrap normal-case', className)}
    >
      {tokens.map((token, index) => (
        <React.Fragment key={`${token}-${index}`}>
          {index > 0 ? (
            <span className={variant === 'hint'
              ? 'text-[10px] font-normal text-muted-foreground/65'
              : 'typography-micro font-semibold text-[var(--surface-muted-foreground)]'}>
              +
            </span>
          ) : null}
          <Kbd
            variant={variant}
            aria-label={token}
            className={cn(
              tone === 'selection' &&
                'border-[var(--interactive-selection)] bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]',
            )}
          >
            {variant === 'hint' && shortcutIcons[token.toLowerCase()]
              ? <Icon name={shortcutIcons[token.toLowerCase()]} className="size-2.5" />
              : /^[a-z]$/i.test(token) ? token.toUpperCase() : token}
          </Kbd>
        </React.Fragment>
      ))}
    </span>
  );
}

import { colorScheme, token } from 'nsh';

/** Web `mobile.css` geometry tokens for the phone surfaces. */
export const radius = {
  surface: 24, // --yuri-mobile-surface-radius: 1.5rem
  inset: 16, // --yuri-mobile-inset-radius: 1rem
  control: 20, // --yuri-mobile-control-radius: 1.25rem
  action: 12,
};

export const space = {
  pageGap: 20, // --yuri-mobile-page-gap: 1.25rem
  pageInset: 18, // --yuri-mobile-page-inline-inset: 1.125rem
  projectGroupGap: 10, // .yuri-mobile-project-shell: 0.625rem
  sessionRow: 40, // .yuri-mobile-project-shell --yuri-mobile-session-row-height: 2.5rem
  projectHeader: 74, // .yuri-mobile-project-shell --yuri-mobile-project-header-height: 4.625rem
  projectIcon: 38, // 2.375rem
};

/** Status colors from Yuri's `yuri-2` theme (the Web `--status-*` vars). */
const status = {
  light: {
    info: '#a753ae',
    warning: '#ffdc17',
    success: '#12c905',
    error: '#fc533a',
  },
  dark: {
    info: '#edb2f1',
    warning: '#fcd53a',
    success: '#12c905',
    error: '#fc533a',
  },
};

export const colors = {
  background: () => token('background'),
  foreground: () => token('foreground'),
  card: () => token('card'),
  muted: () => token('muted'),
  mutedForeground: () => token('muted-foreground'),
  border: () => token('border'),
  accent: () => token('accent'),
  destructive: () => token('destructive'),
  success: () => token('success'),
  ring: () => token('ring'),
  status,
};

export const statusColor = (name: keyof typeof status.light): string =>
  status[colorScheme() === 'dark' ? 'dark' : 'light'][name];

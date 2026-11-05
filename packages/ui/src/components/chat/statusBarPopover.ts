import type { CSSProperties } from 'react';

export const statusBarPopoverSurfaceClassName =
    'yuri-mobile-overlay-surface yuri-popup-surface';

export const statusBarPopoverClassName =
    `w-[min(30rem,calc(100cqw-1rem))] min-w-[280px] max-w-full overflow-hidden rounded-xl ${statusBarPopoverSurfaceClassName}`;

export const statusBarPopoverStyle: CSSProperties = {
    maxWidth: 'min(28rem, calc(100cqw - 4ch))',
    color: 'var(--surface-elevated-foreground)',
};

export const statusBarComposerPopoverStyle: CSSProperties = {
    ...statusBarPopoverStyle,
    width: '100%',
    minWidth: 0,
    maxWidth: '100%',
};

export const statusBarPopoverHeaderClassName =
    'flex items-center justify-between gap-3 border-b-[length:var(--yuri-popup-divider-width)] border-[var(--yuri-popup-divider)] px-3 py-2.5';

export const statusBarPopoverHeaderTitleClassName =
    'text-xs font-medium leading-4 text-foreground md:text-[0.8125rem] md:leading-5';

export const statusBarPopoverHeaderMetaClassName =
    'text-xs tabular-nums leading-4 text-muted-foreground md:text-[0.8125rem] md:leading-5';

export const todoListClassName =
    'm-0 list-none p-0';

export const statusBarPopoverListClassName =
    `${todoListClassName} divide-y-[length:var(--yuri-popup-divider-width)] divide-[var(--yuri-popup-divider)] max-h-[min(22rem,50vh)] overflow-y-auto`;

export const todoToolListClassName = `${todoListClassName} divide-y divide-[var(--surface-subtle)] w-full`;

/** Todo 工具滚动卡片配置：直角边框且无内边距 */
export const todoToolScrollOptions = {
    className: 'p-0 rounded-none',
    maxHeightClass: 'max-h-[46vh]',
    disableHorizontal: true,
} as const;

export const statusBarPopoverRowClassName =
    'px-2.5 py-1.5 text-xs leading-4 md:py-2 md:text-[0.8125rem] md:leading-5';

export const statusBarTriggerClassName =
    'flex min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground md:gap-1.5 md:text-[0.8125rem] md:leading-5';

export const statusBarTriggerLabelClassName =
    'min-w-0 truncate text-xs leading-4 text-foreground md:text-[0.8125rem] md:leading-5';

export const statusBarTriggerMetaClassName =
    'inline-flex shrink-0 items-center gap-1 text-xs leading-4 tabular-nums text-muted-foreground md:text-[0.8125rem] md:leading-5';

export const statusBarTriggerIconClassName =
    'h-3 w-3 shrink-0 md:h-3.5 md:w-3.5';

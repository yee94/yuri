import React from 'react';
import { cn } from '@/lib/utils';
import { SIDEBAR_ROW_ACTIVE_CLASS, SIDEBAR_ROW_HOVER_CLASS, getSidebarRowPaddingLeft } from './utils';

/** Shared row geometry; data subscriptions, menus and mutations belong to the caller. */
export function SessionRowLayout({ active, selected, className, ...props }: React.ComponentProps<'div'> & { active?: boolean; selected?: boolean }) {
  return <div {...props} data-session-selected={selected || undefined} className={cn('group relative my-0.5 flex cursor-pointer items-center rounded-lg py-1.5 pr-2',
    active || selected ? SIDEBAR_ROW_ACTIVE_CLASS : SIDEBAR_ROW_HOVER_CLASS, className)} />;
}

export function SessionRowContent({ depth = 0, children }: { depth?: number; children: React.ReactNode }) {
  return <div className="flex min-w-0 flex-1 items-center" style={{ paddingLeft: getSidebarRowPaddingLeft(depth) }}>{children}</div>;
}

export function SessionRowTitle({ className, ...props }: React.ComponentProps<'button'>) {
  return <button type="button" data-session-title {...props} className={cn(
    'relative flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none has-[[data-sidebar-shortcut-number]]:!pr-0', className)} />;
}

export function SessionRowActions({ visible = false, className, children }: { visible?: boolean; className?: string; children: React.ReactNode }) {
  return <div className={cn('absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 transition-none group-has-[[data-sidebar-shortcut-number]]:hidden',
    visible ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto', className)}>{children}</div>;
}

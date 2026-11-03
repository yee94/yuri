import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** Shared inset material for preview and global plugin workspaces. */
export function WorkspaceSurface({ children, className, ...props }: ComponentProps<'section'>) {
  return <section {...props} data-workspace-surface className={cn('relative isolate flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-background shadow-sm [--background:oklch(from_var(--surface-background)_min(1,calc(l_+_0.015))_c_h)] dark:[--background:color-mix(in_srgb,var(--surface-foreground)_4%,var(--surface-background))]', className)}>
    {children}
    <span aria-hidden="true" data-workspace-surface-ring className="pointer-events-none absolute inset-0 z-50 rounded-[inherit] ring-1 ring-inset ring-[var(--interactive-border)]" />
  </section>;
}

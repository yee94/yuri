import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';

type SidebarSectionHeaderProps = {
  title: string;
  /** Optional right-side chrome (e.g. display-mode equalizer on Recent). */
  accessory?: React.ReactNode;
  /** First section in the scroll body — less top margin than subsequent ones. */
  isFirst?: boolean;
  /** When set, the title is a collapse control (Codex still looks like a static label). */
  onToggle?: () => void;
  expanded?: boolean;
  className?: string;
  /** Replaces the text label (e.g. the Tasks / Projects view switch). */
  titleSlot?: React.ReactNode;
};

/**
 * Codex-style sidebar section label: muted micro title, generous top gap,
 * tight gap to the items below. Not a loud interactive row.
 */
export function SidebarSectionHeader({
  title,
  accessory,
  isFirst = false,
  onToggle,
  expanded,
  className,
  titleSlot,
}: SidebarSectionHeaderProps) {
  const titleClassName = 'typography-micro font-normal tracking-wide text-muted-foreground/80';

  return (
    <div
      className={cn(
        'group/section flex w-full items-center gap-1 px-2',
        // The view switch is a 28px control, not a micro label: tighter top gap,
        // a little more room before the first row.
        titleSlot ? (isFirst ? 'pt-1 pb-1.5' : 'pt-3 pb-1.5') : isFirst ? 'pt-1 pb-1' : 'pt-4 pb-1',
        className,
      )}
    >
      {titleSlot ? (
        <div className="flex min-w-0 flex-1 items-center">{titleSlot}</div>
      ) : onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          className="group/toggle flex min-w-0 flex-1 items-center gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          aria-expanded={expanded}
        >
          <span className={titleClassName}>{title}</span>
          <Icon
            name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
            className="size-3 shrink-0 opacity-0 transition-opacity group-hover/toggle:opacity-100 group-focus-visible/toggle:opacity-100"
          />
        </button>
      ) : (
        <span className={cn('flex min-w-0 flex-1 items-center gap-1', titleClassName)}>
          {title}
        </span>
      )}
      {accessory ? (
        // -mr-2：equalizer 图标在 24px 命中区内居中，负 margin 把字形右缘拉齐下方 "1h"/"3h"
        <div className="ml-auto -mr-2 flex shrink-0 items-center">
          {accessory}
        </div>
      ) : null}
    </div>
  );
}

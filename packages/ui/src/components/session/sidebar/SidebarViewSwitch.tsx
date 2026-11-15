import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SidebarView } from './taskView';

type Props = {
  value: SidebarView;
  onChange: (view: SidebarView) => void;
};

type Segment = { id: SidebarView; icon: IconName; labelKey: 'sessions.sidebar.view.tasks' | 'sessions.sidebar.projectsTitle' };

const SEGMENTS: readonly Segment[] = [
  { id: 'tasks', icon: 'list-check-2', labelKey: 'sessions.sidebar.view.tasks' },
  { id: 'projects', icon: 'folder-tree', labelKey: 'sessions.sidebar.projectsTitle' },
];

/**
 * Two-segment switch that replaces the "Projects" section label. Only the
 * selected segment shows its text; the other collapses to its icon. The label
 * opens through a 0fr→1fr grid track (no per-frame JS, no measuring), and only
 * these two buttons ever transition.
 */
export const SidebarViewSwitch = React.memo(function SidebarViewSwitch({
  value,
  onChange,
}: Props): React.ReactNode {
  const { t } = useI18n();
  return (
    <div
      role="radiogroup"
      aria-label={t('sessions.sidebar.view.aria')}
      // -ml-2 cancels the section header's px-2 so the pill's left edge sits on the
      // row chips' left edge; with px-1.5 segments the first icon's center then
      // lands on the icon column of the nav rows above (New chat / Plans / Assistant).
      className="-ml-2 inline-flex h-7 items-center rounded-full bg-[color-mix(in_srgb,var(--surface-foreground)_7%,transparent)] p-0.5"
    >
      {SEGMENTS.map((segment) => {
        const selected = value === segment.id;
        const label = t(segment.labelKey);
        return (
          <button
            key={segment.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={() => onChange(segment.id)}
            className={cn(
              'relative flex h-6 items-center rounded-full text-[12px] font-medium leading-none',
              'pl-1.5 transition-[background-color,color,box-shadow,padding] duration-200 ease-out motion-reduce:transition-none',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              selected
                ? 'bg-background pr-2.5 text-foreground shadow-sm'
                : 'pr-1.5 text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon name={segment.icon} className="size-4 shrink-0" />
            <span
              aria-hidden={!selected}
              className={cn(
                'grid transition-[grid-template-columns,margin,opacity] duration-200 ease-out motion-reduce:transition-none',
                selected ? 'ml-1.5 grid-cols-[1fr] opacity-100' : 'ml-0 grid-cols-[0fr] opacity-0',
              )}
            >
              <span className="min-w-0 overflow-hidden whitespace-nowrap">{label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
});

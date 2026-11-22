import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SidebarView } from '@/components/session/sidebar/taskView';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ViewOption = { id: SidebarView; icon: IconName; labelKey: I18nKey };

const VIEW_OPTIONS: readonly ViewOption[] = [
  { id: 'tasks', icon: 'list-check-2', labelKey: 'sessions.sidebar.view.tasks' },
  { id: 'projects', icon: 'folder-tree', labelKey: 'mobile.sessions.section.projects' },
];

type Props = {
  value: SidebarView;
  onChange: (view: SidebarView) => void;
};

/** Page title that doubles as the Tasks / Projects view picker; typography is inherited from the header. */
export function MobileHomeViewMenu({ value, onChange }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const current = VIEW_OPTIONS.find((option) => option.id === value) ?? VIEW_OPTIONS[1];
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-mobile-press-feedback="soft"
          className="inline-flex max-w-full items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
          aria-label={t('mobile.home.view.aria')}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="truncate">{t(current.labelKey)}</span>
          <Icon
            name="arrow-down-s"
            className={cn(
              'size-[0.6em] shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="flex min-w-44 flex-col gap-1">
        {VIEW_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.id}
            className={cn('min-h-11', option.id === value && 'bg-interactive-selection text-interactive-selection-foreground')}
            onSelect={() => onChange(option.id)}
          >
            <Icon name={option.icon} className="size-4" />
            <span className="min-w-0 flex-1 truncate">{t(option.labelKey)}</span>
            {option.id === value ? <Icon name="check" className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

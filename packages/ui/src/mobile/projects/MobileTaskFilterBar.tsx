import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import type { MobileTaskStatus } from './useMobileTaskViewModel';

type StatusOption = { id: MobileTaskStatus; icon: IconName; labelKey: I18nKey };

const STATUS_OPTIONS: readonly StatusOption[] = [
  { id: 'active', icon: 'list-check-2', labelKey: 'mobile.tasks.status.active' },
  { id: 'waiting', icon: 'question', labelKey: 'mobile.tasks.status.waiting' },
  { id: 'archived', icon: 'inbox-archive', labelKey: 'sessions.sidebar.task.shelf.settled' },
];

const FILTER_ITEM_CLASS = 'inline-flex h-9 min-w-0 items-center gap-1.5 typography-small outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]';

type Props = {
  status: MobileTaskStatus;
  onStatusChange: (status: MobileTaskStatus) => void;
  unreadOnly: boolean;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
};

/** Status picker plus an Unread filter; the list below stays one shared card style across statuses. */
export function MobileTaskFilterBar({ status, onStatusChange, unreadOnly, onUnreadOnlyChange }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const current = STATUS_OPTIONS.find((option) => option.id === status) ?? STATUS_OPTIONS[0];
  return (
    <div className="yuri-mobile-task-filter flex items-center" role="toolbar" aria-label={t('mobile.tasks.status.aria')}>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-mobile-press-feedback="soft"
            className={cn(FILTER_ITEM_CLASS, 'text-foreground')}
            aria-label={t('mobile.tasks.status.aria')}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            <Icon name={current.icon} className="size-4" />
            <span className="truncate">{t(current.labelKey)}</span>
            <Icon
              name="arrow-down-s"
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
                open && 'rotate-180',
              )}
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="bottom" className="min-w-44">
          {STATUS_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.id}
              className={cn('min-h-11', option.id === status && 'bg-interactive-selection text-interactive-selection-foreground')}
              onSelect={() => onStatusChange(option.id)}
            >
              <Icon name={option.icon} className="size-4" />
              <span className="min-w-0 flex-1 truncate">{t(option.labelKey)}</span>
              {option.id === status ? <Icon name="check" className="size-4" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span aria-hidden="true" className="mx-3 h-3.5 w-px bg-[color-mix(in_srgb,var(--surface-foreground)_14%,transparent)]" />
      <button
        type="button"
        data-mobile-press-feedback="soft"
        className={cn(FILTER_ITEM_CLASS, unreadOnly ? 'font-medium text-foreground' : 'text-muted-foreground')}
        aria-pressed={unreadOnly}
        onClick={() => onUnreadOnlyChange(!unreadOnly)}
      >
        <Icon name={unreadOnly ? 'mail-open' : 'mail'} className="size-4" />
        {t('sessions.sidebar.session.swipe.markUnread')}
      </button>
    </div>
  );
}

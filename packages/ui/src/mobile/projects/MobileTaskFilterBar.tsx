import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import type { MobileTaskStatus } from './useMobileTaskViewModel';

type StatusOption = { id: MobileTaskStatus; icon: IconName; labelKey: I18nKey };

const STATUS_OPTIONS: readonly StatusOption[] = [
  { id: 'active', icon: 'list-check-2', labelKey: 'mobile.tasks.status.active' },
  { id: 'unread', icon: 'mail', labelKey: 'sessions.sidebar.session.swipe.markUnread' },
  { id: 'archived', icon: 'inbox-archive', labelKey: 'sessions.sidebar.task.shelf.settled' },
];

type Props = {
  status: MobileTaskStatus;
  onStatusChange: (status: MobileTaskStatus) => void;
};

/** Three equal-width plain-text tabs; the list below stays one shared card style across statuses. */
export function MobileTaskFilterBar({ status, onStatusChange }: Props) {
  const { t } = useI18n();
  return (
    <div className="yuri-mobile-task-filter grid grid-cols-3 items-center" role="tablist" aria-label={t('mobile.tasks.status.aria')}>
      {STATUS_OPTIONS.map((option, index) => {
        const selected = option.id === status;
        return (
          <React.Fragment key={option.id}>
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              data-mobile-press-feedback="soft"
              className={cn(
                'relative inline-flex h-8 min-w-0 items-center justify-center gap-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                selected ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
              onClick={() => onStatusChange(option.id)}
            >
              <Icon name={option.icon} className="size-3.5 shrink-0" />
              <span className="truncate">{t(option.labelKey)}</span>
              {index > 0 ? (
                <span aria-hidden="true" className="absolute left-0 top-1/2 h-3 w-px -translate-y-1/2 bg-[color-mix(in_srgb,var(--surface-foreground)_14%,transparent)]" />
              ) : null}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

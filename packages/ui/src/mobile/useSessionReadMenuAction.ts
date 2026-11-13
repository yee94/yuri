import { useEvent } from '@reactuses/core';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { markSessionUnread, markSessionViewed, useNotificationStore, useSessionUnseenCount } from '@/sync/notification-store';

export function useSessionReadMenuAction(
  session: { id: string; parentID?: string | null; directory?: string | null } | null | undefined,
  directory?: string | null,
) {
  const { t } = useI18n();
  const unread = useSessionUnseenCount(session?.id ?? '') > 0;
  const onToggleRead = useEvent(() => {
    if (!session || session.parentID) return;
    if (useNotificationStore.getState().sessionUnseenCount(session.id) > 0) {
      markSessionViewed(session.id);
    } else {
      void markSessionUnread(session.id, directory ?? session.directory ?? undefined)
        .catch(() => toast.error(t('sessions.sidebar.session.menu.markUnreadFailed')));
    }
  });
  return { unread, onToggleRead: session && !session.parentID ? onToggleRead : undefined };
}

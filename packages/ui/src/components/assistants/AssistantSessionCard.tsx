import React from 'react'
import { useEvent } from '@reactuses/core'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import {
  readSessionChangeSummary,
  readSessionModelLabel,
} from '@/lib/sessionChangeSummary'
import { cn } from '@/lib/utils'
import { findSessionById } from '@/router/sessionLookup'
import type { AssistantContactSessionCardPart } from '@/queries/assistantQueries'
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useMobileAppActions } from '@/apps/mobileAppContext'
import { isIPadApp } from '@/lib/platform'
import { useGlobalSessionStatus } from '@/sync/sync-context'
import { openSessionWithFeedback } from '@/sync/openSessionWithFeedback'
import { useGitBranchesQuery } from '@/queries/gitBranchQueries'
import { ContactCardModelLine } from './ContactCardModelLine'
import { CONTACT_SESSION_CARD_COVER_CLASS, CONTACT_CARD_HEADER_CLASS, CONTACT_CARD_TITLE_CLASS, activateContactCardOnKeyDown } from './contactCardChrome'

type AssistantSessionCardProps = {
  card: AssistantContactSessionCardPart
}

const displayStatus = (liveType: string | undefined, persisted: string | null | undefined) => {
  if (persisted === 'cancelled') return persisted
  if (liveType === 'busy' || liveType === 'retry') return liveType
  if (persisted === 'error' || persisted === 'question' || persisted === 'complete') return persisted
  if (liveType === 'idle') return 'complete'
  if (persisted === 'busy' || persisted === 'retry' || persisted === 'idle') return persisted
  return persisted || 'busy'
}

const statusKey = (status: string | null | undefined) => {
  if (status === 'cancelled') return 'assistants.contact.card.session.status.cancelled' as const
  if (status === 'busy') return 'assistants.contact.card.session.status.busy' as const
  if (status === 'retry') return 'assistants.contact.card.session.status.retry' as const
  if (status === 'idle') return 'assistants.contact.card.session.status.idle' as const
  if (status === 'complete') return 'assistants.contact.card.session.status.complete' as const
  if (status === 'error') return 'assistants.contact.card.session.status.error' as const
  if (status === 'question') return 'assistants.contact.card.session.status.question' as const
  return null
}

const statusTextClass = (status: string | null | undefined) => {
  if (status === 'busy') return 'text-[var(--status-info)]'
  if (status === 'retry' || status === 'question') return 'text-[var(--status-warning)]'
  if (status === 'error') return 'text-[var(--status-error)]'
  if (status === 'idle' || status === 'complete') return 'text-[var(--status-success)]'
  return 'text-muted-foreground'
}

const directoryName = (directory: string) => {
  const parts = directory.split(/[/\\]/u).filter(Boolean)
  return parts.at(-1) || directory
}

/**
 * Assistant-emitted session receipt: live status, title, project and branch,
 * with optional model/changes in a height-stable footer. The card opens the session.
 */
export const AssistantSessionCard: React.FC<AssistantSessionCardProps> = ({ card }) => {
  const { t } = useI18n()
  const mobileActions = useMobileAppActions()
  const isPhoneShell = Boolean(mobileActions && !isIPadApp())
  const liveSession = useGlobalSessionsStore((state) => (
    state.activeSessions.find((item) => item.id === card.sessionID)
    ?? state.archivedSessions.find((item) => item.id === card.sessionID)
    ?? null
  ))
  const liveStatus = useGlobalSessionStatus(card.sessionID)
  const liveTitle = typeof liveSession?.title === 'string' && liveSession.title.trim()
    ? liveSession.title.trim()
    : null
  const title = liveTitle || card.title || t('assistants.contact.card.session.untitled')
  const status = displayStatus(liveStatus?.type, card.status)
  const statusLabelKey = statusKey(status)
  const directory = (typeof liveSession?.directory === 'string' && liveSession.directory.trim())
    ? liveSession.directory.trim()
    : card.directory
  const project = directoryName(directory)
  const branches = useGitBranchesQuery(directory)
  const branch = branches.data?.current?.trim() || null
  const model = readSessionModelLabel(liveSession)
  const changes = status === 'complete' || status === 'idle' ? readSessionChangeSummary(liveSession) : null
  const openSession = useEvent(() => {
    const live = findSessionById(card.sessionID)
    const nextDirectory = live?.directory || card.directory
    openSessionWithFeedback(card.sessionID, nextDirectory, {
      phoneShell: isPhoneShell,
      switchToChat: true,
    })
    if (!isPhoneShell) {
      useUIStore.getState().setActiveMainTab('chat')
    }
  })
  const onActivateKeyDown = useEvent((event: React.KeyboardEvent<HTMLElement>) => {
    activateContactCardOnKeyDown(event, openSession)
  })

  return (
    <article
      className={CONTACT_SESSION_CARD_COVER_CLASS}
      role="button"
      tabIndex={0}
      aria-label={t('assistants.contact.card.session.aria', { title })}
      data-assistant-contact-card="session"
      onClick={openSession}
      onKeyDown={onActivateKeyDown}
    >
      <div className={CONTACT_CARD_HEADER_CLASS}>
        <span className="flex min-w-0 items-center gap-2 text-[0.8em] leading-4 text-muted-foreground">
          <Icon name="chat-thread" weight="medium" className="size-4 shrink-0" />
          <span className="truncate">{t('assistants.contact.card.session.label')}</span>
        </span>
        {statusLabelKey ? (
          <span data-assistant-session-status="" className={cn('ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[0.75em] leading-4', statusTextClass(status))}>
            <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
            {t(statusLabelKey)}
          </span>
        ) : null}
      </div>
      <h3 className={CONTACT_CARD_TITLE_CLASS} title={title}>{title}</h3>
      <div data-contact-session-details="" className="row-start-3 row-end-5 flex min-w-0 flex-col gap-1.5 py-1">
        <div data-contact-session-project="" className="flex h-4 min-w-0 flex-none items-center gap-2 text-[0.8em] leading-4">
          <p className={cn('flex min-w-0 items-center gap-1.5 text-foreground', branch && 'max-w-[45%] shrink-0')} title={directory}>
            <Icon name="folder" weight="medium" className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 truncate">{project}</span>
          </p>
          {branch ? <p data-contact-session-branch="" className="flex min-w-0 items-center gap-1 text-muted-foreground" title={branch}><Icon name="git-branch" weight="medium" className="size-3 shrink-0" /><span className="min-w-0 truncate">{branch}</span></p> : null}
        </div>
        {changes ? (
          <p data-contact-session-changes="" className="flex h-4 min-w-0 flex-none items-center gap-1.5 overflow-hidden whitespace-nowrap text-[0.8em] leading-4 text-muted-foreground tabular-nums">
            <Icon name="code" weight="medium" className="size-3.5 shrink-0" />
            {changes.additions !== undefined ? (
              <span className="text-[var(--status-success)]">+{changes.additions}</span>
            ) : null}
            {changes.deletions !== undefined ? (
              <span className="text-[var(--status-error)]">−{changes.deletions}</span>
            ) : null}
            {changes.files !== undefined ? (
              <span className="text-muted-foreground">
                {changes.files === 1
                  ? t('assistants.contact.card.session.changes.filesSingle', { count: changes.files })
                  : t('assistants.contact.card.session.changes.filesPlural', { count: changes.files })}
              </span>
            ) : null}
          </p>
        ) : null}
        <div data-contact-session-bottom="" className="mt-auto flex h-4 min-w-0 flex-none items-center gap-2">
          {model ? <ContactCardModelLine value={model} /> : null}
          <Icon name="arrow-right-s" weight="medium" className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </div>
      </div>
    </article>
  )
}

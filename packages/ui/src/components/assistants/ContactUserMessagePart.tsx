import React from 'react'
import { Popover } from '@base-ui/react/popover'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import type { ContactOptimisticTurn } from './contactOptimisticTurns'

type SendErrorProps = {
  turn: ContactOptimisticTurn
  retryDisabled: boolean
  onRetry: (messageID: string) => void
}

const ContactSendError = React.memo(({ turn, retryDisabled, onRetry }: SendErrorProps) => {
  const { t } = useI18n()
  return (
    <Popover.Root>
      <Popover.Trigger
        type="button"
        aria-label={t('assistants.contact.sendError.viewDetails')}
        data-assistant-contact-send-error=""
        className="absolute right-full top-1/2 mr-1.5 flex size-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 shadow-none outline-none focus-visible:opacity-70"
      >
        <Icon name="exclamation-fill" className="size-[18px] text-[var(--status-error)]" data-assistant-contact-error-dot="" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="left" align="center" sideOffset={6} collisionPadding={12} collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'end' }} className="z-50">
          <Popover.Popup className="yuri-mobile-overlay-surface w-72 max-w-[calc(100vw-2rem)] rounded-xl p-4 text-foreground outline-none" data-assistant-contact-send-error-popup="">
            <Popover.Title className="typography-ui-label font-medium">{t('assistants.contact.sendError.title')}</Popover.Title>
            <Popover.Description role="alert" className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap typography-meta leading-relaxed [overflow-wrap:anywhere]">
              {turn.error || t('assistants.contact.sendFailed')}
            </Popover.Description>
            <div className="mt-4 flex justify-end">
              <Button type="button" size="xs" disabled={retryDisabled} onClick={() => onRetry(turn.messageID)}>
                <Icon name="refresh" className="size-3" />
                {t('chat.history.retry')}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
})

export function ContactUserMessagePart({ children, failedTurn, retryDisabled, onRetry }: {
  children: React.ReactNode
  failedTurn?: ContactOptimisticTurn
  retryDisabled: boolean
  onRetry: (messageID: string) => void
}) {
  return (
    <div className="relative min-w-0 max-w-full" data-assistant-contact-user-part="">
      {children}
      {failedTurn?.status === 'failed' ? <ContactSendError turn={failedTurn} retryDisabled={retryDisabled} onRetry={onRetry} /> : null}
    </div>
  )
}

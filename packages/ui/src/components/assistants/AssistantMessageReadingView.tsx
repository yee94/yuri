import React from 'react'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { useI18n } from '@/lib/i18n'
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery'

const MarkdownRenderer = lazyWithChunkRecovery(() => import('@/components/chat/MarkdownRenderer').then((module) => ({ default: module.MarkdownRenderer })))

type AssistantMessageReadingViewProps = {
  open: boolean
  text: string
  onOpenChange: (open: boolean) => void
}

/**
 * Edge-to-edge reading view for one bot message, like WeChat's large-text view:
 * no header, no chrome, no safe-area insets, only theme background and big type.
 * A tap (without selecting text) or Escape returns to the transcript.
 */
export const AssistantMessageReadingView: React.FC<AssistantMessageReadingViewProps> = ({ open, text, onOpenChange }) => {
  const { t } = useI18n()
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Popup
          data-assistant-contact-reading=""
          aria-label={t('assistants.contact.reading.close')}
          className="fixed inset-0 z-[10000] overflow-x-hidden overflow-y-auto bg-background text-foreground outline-none [-webkit-overflow-scrolling:touch]"
          style={{ overscrollBehavior: 'contain', '--text-markdown': '1.5rem', '--markdown-body-line-height': '1.8' } as React.CSSProperties}
          onClick={(event) => {
            // Reading is not a link target; a plain tap leaves, a selection stays.
            if (event.target instanceof Element && event.target.closest('a[href],button')) return
            if (event.currentTarget.ownerDocument.getSelection()?.toString().trim()) return
            onOpenChange(false)
          }}
        >
          <div className="mx-auto flex min-h-full w-full max-w-[40rem] flex-col justify-center px-7 py-10 text-[1.5rem] leading-[1.8] [overflow-wrap:anywhere]">
            <React.Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
              <MarkdownRenderer
                content={text}
                messageId="assistant-contact-reading"
                isAnimated={false}
                isStreaming={false}
                variant="assistant"
                enableFileReferences={false}
                className="w-full min-w-0 [overflow-wrap:anywhere]"
              />
            </React.Suspense>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

import React from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery'

const MarkdownRenderer = lazyWithChunkRecovery(() => import('@/components/chat/MarkdownRenderer').then((module) => ({ default: module.MarkdownRenderer })))

/** Bubbles keep their own DOM; the reading view renders the same Markdown for one message only. */
const MarkdownReader: React.FC<{ content: string }> = ({ content }) => (
  <MarkdownRenderer
    content={content}
    messageId="assistant-contact-reading"
    isAnimated={false}
    isStreaming={false}
    variant="assistant"
    enableFileReferences={false}
    className="w-full min-w-0 [overflow-wrap:anywhere]"
  />
)

type AssistantMessageReadingViewProps = {
  open: boolean
  text: string
  onOpenChange: (open: boolean) => void
}

/**
 * WeChat-style fullscreen reading view for one bot message: large type on the
 * plain background. The close button and Escape return to the transcript;
 * drag or scroll still let the reader move through long replies.
 */
export const AssistantMessageReadingView: React.FC<AssistantMessageReadingViewProps> = ({ open, text, onOpenChange }) => {
  const { t } = useI18n()
  const reducedMotion = useReducedMotion()
  const closeLabel = t('assistants.contact.reading.close')
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Popup
          data-assistant-contact-reading=""
          className="fixed inset-0 z-[60] flex min-h-0 flex-col bg-background text-foreground outline-none"
        >
          <div className="flex shrink-0 justify-end px-[max(1rem,var(--yuri-safe-area-right,0px))] pt-[calc(var(--yuri-safe-area-top,0px)+0.75rem)] pb-2">
            <BaseDialog.Close
              aria-label={closeLabel}
              className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:outline-none"
            >
              <Icon name="close" className="size-5" />
            </BaseDialog.Close>
          </div>
          <div
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-[max(1.5rem,var(--yuri-safe-area-left,0px))] pb-[calc(var(--yuri-safe-area-bottom,0px)+2rem)]"
            style={{ overscrollBehavior: 'contain' }}
          >
            <motion.div
              initial={reducedMotion ? false : { opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: reducedMotion ? 0 : 0.2, ease: 'easeOut' }}
              className={cn('mx-auto w-full max-w-[36rem] text-[1.25rem] leading-[1.85] [overflow-wrap:anywhere]', 'typography-markdown')}
              data-assistant-contact-text=""
            >
              <React.Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
                <MarkdownReader content={text} />
              </React.Suspense>
            </motion.div>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

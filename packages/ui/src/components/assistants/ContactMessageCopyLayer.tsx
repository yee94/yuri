import React from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useEvent } from '@reactuses/core'
import { copyTextToClipboard } from '@/lib/clipboard'
import { useI18n } from '@/lib/i18n'

export type ContactCopyTarget = { bubble: HTMLElement; text: string; top: number; left: number }

/**
 * Long press highlights the whole bubble and offers one Copy button. iOS only shows
 * its own callout for a gesture-made selection, so the bubble stays non-selectable
 * and this layer replaces it. Any outside touch, scroll or Escape dismisses it.
 */
export const ContactMessageCopyLayer: React.FC<{ target: ContactCopyTarget | null; onClose: () => void }> = ({ target, onClose }) => {
  const { t } = useI18n()
  const bubble = target?.bubble ?? null
  React.useEffect(() => {
    if (!bubble) return
    bubble.setAttribute('data-assistant-contact-selected', '')
    return () => bubble.removeAttribute('data-assistant-contact-selected')
  }, [bubble])
  const dismiss = useEvent(() => onClose())
  React.useEffect(() => {
    if (!bubble) return
    const doc = bubble.ownerDocument
    const onDown = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-assistant-contact-copy]')) return
      dismiss()
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss() }
    doc.addEventListener('pointerdown', onDown, true)
    doc.addEventListener('scroll', dismiss, true)
    doc.addEventListener('keydown', onKey)
    return () => {
      doc.removeEventListener('pointerdown', onDown, true)
      doc.removeEventListener('scroll', dismiss, true)
      doc.removeEventListener('keydown', onKey)
    }
  }, [bubble, dismiss])
  const copy = useEvent(async () => {
    if (!target) return
    const result = await copyTextToClipboard(target.text)
    if (result.ok) toast.success(t('assistants.contact.message.copied'))
    onClose()
  })
  if (!target) return null
  return createPortal(
    <button
      type="button"
      data-assistant-contact-copy=""
      onClick={() => { void copy() }}
      style={{ top: Math.max(8, target.top - 48), left: target.left }}
      className="fixed z-[9999] -translate-x-1/2 rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background shadow-lg"
    >
      {t('assistants.contact.message.copy')}
    </button>,
    bubble!.ownerDocument.body,
  )
}

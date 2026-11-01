import React from 'react'
import { AssistantMessageReadingView } from './AssistantMessageReadingView'

/**
 * The reading view keeps its own state and DOM, outside the transcript rows, so
 * opening it never re-renders bubbles or touches their text selection.
 */
export const ContactMessageReadingLayer: React.FC<{
  reading: { key: string; text: string } | null
  onClose: () => void
}> = ({ reading, onClose }) => (
  <AssistantMessageReadingView open={reading !== null} text={reading?.text ?? ''} onOpenChange={(open) => { if (!open) onClose() }} />
)

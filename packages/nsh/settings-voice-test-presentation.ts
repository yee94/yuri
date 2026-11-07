import type { TextViewDocument } from 'nsh/base';

/** Recognition results are literal, selectable content, never Markdown/HTML/link instructions. */
export function voiceTestTranscriptDocument(text: string): TextViewDocument {
  return { blocks: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

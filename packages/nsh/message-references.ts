import type { TextViewDocument } from 'nsh/base';
import { buildMessageReferenceParts } from '../ui/src/lib/messages/references/detect';
import { buildCitationHintsFromParts } from '../ui/src/lib/messages/references/citations';
import type { MessageReferenceDecoration, MessageReferenceDetectContext } from '../ui/src/lib/messages/references/types';
import type { Part } from '../ui/src/lib/opencode/v2-types';

export const nativeReferenceNode = 'yuri-reference';

/** Same durable tags, citations and confirmed mentions as the Web message renderer. */
export function nativeMessageReferenceContext(parts: readonly Part[], text: string): MessageReferenceDetectContext {
  const hints = buildCitationHintsFromParts(parts, text);
  return { citationIcons: hints.icons, citationDisplayNames: hints.displayNames, allowPathHeuristics: true };
}

/** Decorate prose after Markdown parsing; code, URLs and image sources remain literal. */
export function decorateNativeMessageDocument(document: TextViewDocument, context: MessageReferenceDetectContext): TextViewDocument {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.flatMap(item => {
      if (item?.type === 'text' && typeof item.text === 'string') {
        const parts = buildMessageReferenceParts(item.text, context);
        if (parts) return parts.map(part => part.type === 'text' ? { type: 'text', text: part.text } : {
          type: 'custom', name: nativeReferenceNode, text: part.span.raw, data: part.decoration,
        });
      }
      return [visit(item)];
    });
    if (!value || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    if (['code', 'codeBlock', 'image', 'link', 'math', 'custom'].includes(String(node.type))) return value;
    return Object.fromEntries(Object.entries(node).map(([key, field]) => [key, Array.isArray(field) ? visit(field) : field]));
  };
  return visit(document) as TextViewDocument;
}

export function nativeReferenceLabel(decoration: MessageReferenceDecoration): string {
  return decoration.kind === 'skill' || decoration.kind === 'command' ? decoration.label.replace(/^[@/]/, '') : decoration.label;
}

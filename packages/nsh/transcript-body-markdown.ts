import type { TextViewStyles } from 'nsh/base';
import { nativeChatTextStyle, nativeCodeTextViewStyles } from './appearance';

/** Match Web's list/row indent; intrinsic marker width keeps 10. from being ellipsized. */
export function nativeTranscriptMarkdownStyles(role: 'user' | 'assistant', compact = false): TextViewStyles {
  const body = nativeChatTextStyle(role);
  return {
    root: body,
    ...nativeCodeTextViewStyles(),
    orderedList: { paddingLeft: 19 },
    unorderedList: { paddingLeft: 18 },
    listItem: { paddingLeft: 1 },
    listMarker: { width: 'max-content', paddingRight: 0, marginRight: 6, textAlign: 'right', flexShrink: 0, fontSize: body.fontSize === undefined ? undefined : body.fontSize * .72, lineHeight: body.lineHeight },
    ...(compact ? { paragraph: { marginTop: 0, marginBottom: 0 } } : {}),
  };
}

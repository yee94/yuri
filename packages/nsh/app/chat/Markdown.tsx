import { TextView } from 'nsh/base';
import { colors } from '../core/theme';

/** Markdown through the native text view: tables, code blocks, links and
    streaming replies whose changed blocks alone are drawn again. Message
    text is not selectable: its long press is the message's actions menu. */
export function Markdown(props: { text: () => string; class?: string; selectable?: boolean }) {
  return (
    <TextView
      class={props.class}
      markdown={props.text()}
      options={{ streaming: true }}
      selectable={props.selectable ?? false}
      codeBlockActions={[{ id: 'copy' }]}
      styles={{ root: { fontSize: 14, lineHeight: 21, color: colors.foreground() } }}
    />
  );
}

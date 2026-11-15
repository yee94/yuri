import { colorScheme, computed, Text, View } from 'nsh';
import { TextView, type TextViewProps } from 'nsh/base';
import { buildMessageReferenceParts } from '../ui/src/lib/messages/references/detect';
import type { MessageReferenceDecoration, MessageReferenceDetectContext } from '../ui/src/lib/messages/references/types';
import { Icon } from './Icon';
import { nativeAppearance, nativeChatTextStyle } from './appearance';
import { referenceChipColors } from './composer-inline-chips';
import { decorateNativeMessageDocument, nativeReferenceLabel, nativeReferenceNode } from './message-references';

export function NativeMessageReference(props: { decoration: MessageReferenceDecoration; onOpenSkill?: (name: string) => void }) {
  const color = () => {
    const scheme = colorScheme();
    const colors = referenceChipColors(nativeAppearance.current()?.webTheme?.[scheme], scheme === 'dark');
    return props.decoration.kind === 'skill' ? colors.skill : colors.primary;
  };
  return <View testID={`message-reference-${props.decoration.kind}`} class="flex-row items-center" style={{ gap: 3, maxWidth: '100%', verticalAlign: 'middle' }}
    role={props.decoration.skillName && props.onOpenSkill ? 'button' : undefined}
    accessibilityLabel={props.decoration.label} onPress={() => { if (props.decoration.skillName) props.onOpenSkill?.(props.decoration.skillName); }}>
    <If when={!!props.decoration.icon}><Icon name={props.decoration.icon!} size={(nativeChatTextStyle('user').fontSize ?? 14) * .875} color={color()} /></If><Text style={{ ...nativeChatTextStyle('user'), color: color(), flexShrink: 1 }}>{nativeReferenceLabel(props.decoration)}</Text>
  </View>;
}

/** Keeps the cheap native Markdown path when there are no reference decorations. */
export function NativeMessageText(props: TextViewProps & { referenceContext?: MessageReferenceDetectContext; onOpenSkill?: (name: string) => void }) {
  const document = computed(() => {
    const source = props.markdown ?? '';
    if (!props.referenceContext || !buildMessageReferenceParts(source, props.referenceContext)) return undefined;
    return decorateNativeMessageDocument(TextView.parse(source, props.options), props.referenceContext);
  });
  return <TextView {...props} class={props.class} style={props.style} styles={props.styles} classes={props.classes}
    renderImage={props.renderImage} selectable={props.selectable} links={props.links}
    markdown={document() ? undefined : props.markdown} document={document() ?? props.document}
    renderCustom={node => node.name === nativeReferenceNode
      ? <NativeMessageReference decoration={node.data as MessageReferenceDecoration} onOpenSkill={props.onOpenSkill} />
      : props.renderCustom?.(node)} />;
}

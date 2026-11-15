import { colorScheme, computed, Image, locale, signal, Text, token, View, type JSX } from 'nsh';
import { assistantAvatarMessageColors } from '../ui/src/lib/assistant-avatar/palette';
import { resolveAssistantAvatar } from '../ui/src/lib/assistant-avatar/recipe';
import { nativeChatTextStyle, nativeTimeFormat } from './appearance';
import { assistantBubblePath } from './assistants-presentation';
import { assistantPanelStyle } from './assistants-workspace';
import { language } from './i18n';
import { formatNativeTimeForLocale } from './transcript-time-core';

export function assistantContactTextStyle(outgoing: boolean, seed: string) {
  const body = nativeChatTextStyle(outgoing ? 'user' : 'assistant');
  return { ...body, lineHeight: (body.fontSize ?? 14) * 1.65, color: outgoing ? assistantAvatarMessageColors(resolveAssistantAvatar(seed).color).foreground : String(token('foreground')) };
}

/** Measurement paints the silhouette only; it never changes layout or scroll. */
export function AssistantTextBubble(props: { outgoing: boolean; seed: string; createdAt?: number; joinedBefore?: boolean; joinedAfter?: boolean; children?: JSX.Element }) {
  const size = signal({ width: 0, height: 0 });
  const fill = () => props.outgoing ? assistantAvatarMessageColors(resolveAssistantAvatar(props.seed).color).background : assistantPanelStyle().backgroundColor;
  const outline = computed(() => {
    const { width, height } = size();
    if (!width || !height) return '';
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width + 16}" height="${height}" viewBox="0 0 ${width + 16} ${height}"><path fill="${fill()}" d="${assistantBubblePath(width, height, props.outgoing, props.joinedBefore, props.joinedAfter)}"/></svg>`);
  });
  const time = () => props.createdAt === undefined ? '' : formatNativeTimeForLocale(props.createdAt, nativeTimeFormat() ?? 'auto', language() === 'system' ? locale() : language());
  return <View testID="assistant-text-bubble" style={{ alignSelf: props.outgoing ? 'flex-end' : 'flex-start', width: props.outgoing ? 'max-content' : '100%', maxWidth: '100%', minWidth: 48, paddingHorizontal: 10, paddingTop: 5, paddingBottom: time() ? 20 : 6, borderRadius: 18, backgroundColor: outline() ? 'transparent' : fill() }} onLayout={event => {
    const next = event.bounds.size;
    if (next.width !== size().width || next.height !== size().height) size.set(next);
  }}>
    <If when={!!outline()}><Image src={outline()} accessible={false} style={{ position: 'absolute', left: -8, top: 0, width: size().width + 16, height: size().height, objectFit: 'fill', pointerEvents: 'none', filter: colorScheme() === 'dark' ? undefined : `drop-shadow(0 1px 1px ${String(token('foreground')).slice(0, 7)}29)` }} /></If>
    {props.children}
    <If when={!!time()}><Text testID="assistant-bubble-time" style={{ position: 'absolute', right: 10, bottom: 3, fontSize: 11, lineHeight: 16, opacity: .55, color: assistantContactTextStyle(props.outgoing, props.seed).color }}>{time()}</Text></If>
  </View>;
}

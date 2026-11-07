import { View } from 'nsh';
import { Button } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';

export function NativeComposerSend(props: { disabled: boolean; inFlight: boolean; onPress: () => void; canAbort?: boolean; hasContent?: boolean; onStop?: () => void; testIDPrefix?: string }) {
  const id = (name: string) => `${props.testIDPrefix ?? ''}${name}`;
  return <If when={props.canAbort && !props.hasContent && !!props.onStop} else={<Button testID={id('send')} class={props.inFlight ? 'size-8 rounded-full items-center justify-center active:bg-accent' : 'size-8 rounded-full items-center justify-center active:bg-accent disabled:opacity-40'} hitSlop={6} disabled={props.disabled || props.inFlight} onPress={props.onPress} accessibilityLabel={t(props.inFlight ? 'chat.chatInput.actions.sendingMessageAria' : 'chat.chatInput.actions.sendMessageAria')}>
    <If when={!props.disabled || props.inFlight} else={<View testID={id('send-ghost')}><Icon name="send-plane-2" size={16} /></View>}>
      <View testID={id('send-disc')} class="size-6 rounded-full bg-foreground items-center justify-center">
        <If when={props.inFlight} else={<View testID={id('send-arrow')}><Icon name="arrow-up" size={24 * .56} tone="background" /></View>}>
          <View testID={id('send-loading')} class="animate-spin"><Icon name="loader-4" size={12} tone="background" /></View>
        </If>
      </View>
    </If>
  </Button>}>
    <Button testID={id('stop')} class="size-8 rounded-full items-center justify-center active:bg-accent" hitSlop={6} onPress={() => props.onStop?.()} accessibilityLabel={t('chat.chatInput.actions.stopGeneratingAria')}>
      <View testID={id('stop-disc')} class="size-6 rounded-full bg-foreground items-center justify-center"><View testID={id('stop-glyph')} class="bg-background" style={{ width: 24 * .38, height: 24 * .38, borderRadius: 24 * .38 * .2 }} /></View>
    </Button>
  </If>;
}

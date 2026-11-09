import { View } from 'nsh';
import { Button } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { nativeDensity } from './appearance';

export function NativeComposerSend(props: { disabled: boolean; inFlight: boolean; onPress: () => void; canAbort?: boolean; hasContent?: boolean; onStop?: () => void; testIDPrefix?: string }) {
  const id = (name: string) => `${props.testIDPrefix ?? ''}${name}`;
  const geometry = () => nativeDensity().chat.send;
  return <If when={props.canAbort && !props.hasContent && !!props.onStop} else={<Button testID={id('send')} class={props.inFlight ? 'size-8 rounded-full items-center justify-center active:bg-accent' : 'size-8 rounded-full items-center justify-center active:bg-accent disabled:opacity-40'} style={{ width: geometry().target, height: geometry().target }} hitSlop={geometry().hitSlop} disabled={props.disabled || props.inFlight} onPress={props.onPress} accessibilityLabel={t(props.inFlight ? 'chat.chatInput.actions.sendingMessageAria' : 'chat.chatInput.actions.sendMessageAria')}>
    <If when={!props.disabled || props.inFlight} else={<View testID={id('send-ghost')}><Icon name="send-plane-2" size={geometry().ghost} /></View>}>
      <View testID={id('send-disc')} class="size-6 rounded-full bg-foreground items-center justify-center" style={{ width: geometry().disc, height: geometry().disc }}>
        <If when={props.inFlight} else={<View testID={id('send-arrow')}><Icon name="arrow-up" size={geometry().disc * .56} tone="background" /></View>}>
          <View testID={id('send-loading')} class="animate-spin"><Icon name="loader-4" size={geometry().disc * .5} tone="background" /></View>
        </If>
      </View>
    </If>
  </Button>}>
    <Button testID={id('stop')} class="size-8 rounded-full items-center justify-center active:bg-accent" style={{ width: geometry().target, height: geometry().target }} hitSlop={geometry().hitSlop} onPress={() => props.onStop?.()} accessibilityLabel={t('chat.chatInput.actions.stopGeneratingAria')}>
      <View testID={id('stop-disc')} class="size-6 rounded-full bg-foreground items-center justify-center" style={{ width: geometry().disc, height: geometry().disc }}><View testID={id('stop-glyph')} class="bg-background" style={{ width: geometry().disc * .38, height: geometry().disc * .38, borderRadius: geometry().disc * .38 * .2 }} /></View>
    </Button>
  </If>;
}

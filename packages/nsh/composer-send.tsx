import { View } from 'nsh';
import { Button } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { nativeDensity } from './appearance';

export function NativeComposerSend(props: { disabled: boolean; inFlight: boolean; onPress: () => void; canAbort?: boolean; hasContent?: boolean; onStop?: () => void; testIDPrefix?: string; presentation?: 'desktop' | 'mobile'; active?: boolean }) {
  const id = (name: string) => `${props.testIDPrefix ?? ''}${name}`;
  const geometry = () => nativeDensity().chat.send;
  const control = () => `${props.presentation === 'desktop' ? 'size-6' : 'size-8'} rounded-full items-center justify-center active:bg-accent`;
  const geometryStyle = () => props.presentation === 'desktop' ? undefined : { width: geometry().target, height: geometry().target };
  const discStyle = () => props.presentation === 'desktop' ? undefined : { width: geometry().disc, height: geometry().disc };
  const inactive = () => props.active === false;
  return <If when={props.canAbort && !props.hasContent && !!props.onStop} else={<Button testID={id('send')} class={`${control()}${props.inFlight ? '' : ' disabled:opacity-40'}`} style={geometryStyle()} hitSlop={props.presentation === 'desktop' ? 6 : geometry().hitSlop} disabled={inactive() || props.disabled || props.inFlight} onPress={() => { if (!inactive() && !props.disabled && !props.inFlight) props.onPress(); }} accessibilityLabel={t(props.inFlight ? 'chat.chatInput.actions.sendingMessageAria' : 'chat.chatInput.actions.sendMessageAria')}>
    <If when={!props.disabled || props.inFlight} else={<View testID={id('send-ghost')}><Icon name="send-plane-2" size={props.presentation === 'desktop' ? 16 : geometry().ghost} /></View>}>
      <View testID={id('send-disc')} class="size-6 rounded-full bg-foreground items-center justify-center" style={discStyle()}>
        <If when={props.inFlight} else={<View testID={id('send-arrow')}><Icon name="arrow-up" size={props.presentation === 'desktop' ? 24 * .56 : geometry().disc * .56} tone="background" /></View>}>
          <View testID={id('send-loading')} class="animate-spin"><Icon name="loader-4" size={props.presentation === 'desktop' ? 12 : geometry().disc * .5} tone="background" /></View>
        </If>
      </View>
    </If>
  </Button>}>
    <Button testID={id('stop')} class={control() + ' disabled:opacity-40'} style={geometryStyle()} hitSlop={props.presentation === 'desktop' ? 6 : geometry().hitSlop} disabled={inactive()} onPress={() => { if (!inactive()) props.onStop?.(); }} accessibilityLabel={t('chat.chatInput.actions.stopGeneratingAria')}>
      <View testID={id('stop-disc')} class="size-6 rounded-full bg-foreground items-center justify-center" style={discStyle()}><View testID={id('stop-glyph')} class="bg-background" style={props.presentation === 'desktop' ? { width: 24 * .38, height: 24 * .38, borderRadius: 24 * .38 * .2 } : { width: geometry().disc * .38, height: geometry().disc * .38, borderRadius: geometry().disc * .38 * .2 }} /></View>
    </Button>
  </If>;
}

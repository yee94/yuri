import { effect, signal, Text, untracked, View } from 'nsh';
import { Button } from 'nsh/base';
import { ResourceRasterImage } from './resource-raster';
import type { RuntimeScope } from './runtime-scope';
import { t } from './i18n';

/** The native lease owns decoding; this leaf only presents its loading/retry state. */
export function ResourceRasterPresentation(props: { config: { lease: string; expectedHost: RuntimeScope | null; active: boolean } }) {
  const status = signal('loading');
  let image: { command(name: string): void } | undefined;
  effect(() => {
    props.config.lease; props.config.expectedHost; props.config.active;
    untracked(() => status.set('loading'));
  });
  return <View class="w-full h-full">
    <ResourceRasterImage class="w-full h-full" config={props.config} ref={value => { image = value; }}
      onLoad={() => status.set('ready')} onError={event => status.set(event.code === 'expired' ? 'expired' : 'failed')} />
    <If when={status() !== 'ready'}><View class="absolute inset-0 items-center justify-center" style={{ pointerEvents: 'box-none' }}>
      <View class="rounded-xl bg-background px-4 py-3 items-center gap-2">
        <Text class="text-sm text-foreground">{t(status() === 'loading' ? 'common.loading' : status() === 'expired' ? 'mobile.files.error.previewExpired' : 'mobile.files.error.readUnavailable')}</Text>
        <If when={status() === 'failed' && props.config.active}><Button testID="raster-image-retry" class="min-h-9 px-3 rounded-lg bg-secondary" onPress={() => { if (props.config.active) { status.set('loading'); image?.command('retry'); } }}><Text class="text-sm text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
      </View>
    </View></If>
  </View>;
}

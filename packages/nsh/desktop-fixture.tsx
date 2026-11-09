import { cleanup, mount, platform, signal, Text, View, type ViewRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { isAvailable, titleBar } from 'nsh/desktop';
import { installNativeDesktopMenu, NativeDesktopTitleBar } from './desktop';
import { language, t } from './i18n';

/** Isolated carrier: no application, Host, credentials or network. */
function Fixture() {
  const mounted = signal(true), revision = signal(0), languageRevision = signal(0), calls = signal(0);
  const slotted = signal(false), leadingWidth = signal(260), metrics = signal('');
  let leading: ViewRef | undefined, heading: ViewRef | undefined, actions: ViewRef | undefined;
  language.set('en');
  cleanup(() => language.set('system'));
  return <View class="flex-1 bg-background">
    <If when={mounted()}>{() => {
      const menu = installNativeDesktopMenu(() => ({ search: { run: () => calls.update(value => value + 1) } }));
      return <>
        <NativeDesktopTitleBar title={`Yuri ${revision()}`} menu={menu} leadingWidth={slotted() ? leadingWidth() : undefined}
          leading={slotted() ? <View ref={node => { leading = node; }} class="flex-1 flex-row items-center gap-2 min-w-0">
            <Text class="flex-1 text-foreground" style={{ numberOfLines: 1 }}>Yuri</Text>
            <Button testID="desktop-fixture-search" class="size-7" onPress={() => calls.update(value => value + 1)}><Text>?</Text></Button>
            <Button testID="desktop-fixture-sidebar" class="size-7" onPress={() => calls.update(value => value + 1)}><Text>≡</Text></Button>
          </View> : undefined}
          heading={slotted() ? <View ref={node => { heading = node; }} style={{ minWidth: 0, flexShrink: 1 }}>
            <Button testID="desktop-fixture-heading" class="min-w-0" style={{ flexShrink: 1 }} onPress={() => calls.update(value => value + 1)}>
              <Text class="text-foreground" style={{ numberOfLines: 1 }}>Session heading with a long title that must shrink before the right actions</Text>
            </Button>
          </View> : undefined}>
          <If when={slotted()} else={<Input testID="desktop-fixture-editor" accessibilityLabel={t('mobile.sessions.searchAria')} style={{ width: 180 }} />}>
            <View ref={node => { actions = node; }} class="flex-row items-center gap-2" style={{ width: 112 }}>
              <Button testID="desktop-fixture-right-action" onPress={() => calls.update(value => value + 1)}><Text>{t('mobile.menu.settings')}</Text></Button>
            </View>
          </If>
        </NativeDesktopTitleBar>
        <Text testID="desktop-fixture-labels">{menu.items().map(item => item.label).join('|')}</Text>
      </>;
    }}</If>
    <Text testID="desktop-fixture-state">{JSON.stringify({ available: isAvailable, desktop: platform.desktop, area: titleBar(), mounted: mounted(), calls: calls() })}</Text>
    <Button testID="desktop-fixture-toggle" onPress={() => mounted.set(!mounted())}><Text>{t('mobile.menu.settings')}</Text></Button>
    <Button testID="desktop-fixture-title" onPress={() => revision.update(value => value + 1)}><Text>Yuri {revision()}</Text></Button>
    <Button testID="desktop-fixture-slots" onPress={() => slotted.set(!slotted())}><Text>Slots</Text></Button>
    <Button testID="desktop-fixture-width" onPress={() => leadingWidth.set(leadingWidth() === 260 ? 180 : 260)}><Text>Width</Text></Button>
    <Button testID="desktop-fixture-measure" onPress={async () => {
      const measured = await Promise.all([leading?.measure(), heading?.measure(), actions?.measure()]);
      metrics.set('CHROME_METRICS ' + JSON.stringify(measured));
    }}><Text>Measure</Text></Button>
    <Text testID="desktop-fixture-metrics">{metrics()}</Text>
    <Button testID="desktop-fixture-language" onPress={() => {
      languageRevision.update(value => value + 1); language.set(languageRevision() % 2 ? 'zh-CN' : 'en');
    }}><Text>{t('settings.appearance.language.label')}</Text></Button>
  </View>;
}

mount(Fixture);

import { mount, Scroll, signal, Text, View, windowSize } from 'nsh';
import { Button, Dialog, Select } from 'nsh/base';
import { NativeDesktopSettingsWindow, type NativeDesktopSettingsPageContext } from './desktop-settings';
import type { SettingsRoute } from './settings';
import { language, t } from './i18n';

function Fixture() {
  language.set('en');
  const open = signal(true), active = signal(true), dirty = signal(false), pending = signal(false), approve = signal(false), ownerCloses = signal(false);
  const nested = signal(false), modal = signal(false), closes = signal(0), navigations = signal(0), confirmations = signal(0);
  const route = signal<SettingsRoute>({ page: 'appearance', directory: '/fixture/worktree' });
  const slotWidth = signal(0), slotHeight = signal(0);
  function Page(props: { context: NativeDesktopSettingsPageContext }) {
    return <View testID="fixture-page" class="flex-1 min-w-0 min-h-0" onLayout={event => { slotWidth.set(event.bounds.size.width); slotHeight.set(event.bounds.size.height); }}>
      <Scroll class="flex-1" contentClass="p-4 gap-3">
        <Text testID="fixture-route">{JSON.stringify(props.context.route)}</Text>
        <Text testID="fixture-active">{`active=${props.context.active}`}</Text>
        <Text testID="fixture-counts">{`closes=${closes()}, navigations=${navigations()}, confirmations=${confirmations()}`}</Text>
        <Text testID="fixture-size">{`slot=${slotWidth()}x${slotHeight()}`}</Text>
        <Text testID="fixture-long-copy" class="text-foreground">{t('settings.providers.delete.description')}</Text>
        <Button testID="fixture-dirty" onPress={() => dirty.set(!dirty())}><Text>{`dirty=${dirty()}`}</Text></Button>
        <Button testID="fixture-pending" onPress={() => pending.set(!pending())}><Text>{`pending=${pending()}`}</Text></Button>
        <Button testID="fixture-approve" onPress={() => approve.set(!approve())}><Text>{`approve=${approve()}`}</Text></Button>
        <Button testID="fixture-owner-closes" onPress={() => ownerCloses.set(!ownerCloses())}><Text>{`ownerCloses=${ownerCloses()}`}</Text></Button>
        <Button testID="fixture-active-toggle" onPress={() => active.set(!active())}><Text>Toggle active</Text></Button>
        <Button testID="fixture-language" onPress={() => language.set(language() === 'en' ? 'uk' : 'en')}><Text>Toggle language</Text></Button>
        <Select open={nested()} onOpenChange={event => nested.set(event.open)} items={[{ value: 'one', title: 'Nested choice one' }, { value: 'two', title: 'Nested choice two' }]}
          trigger={<View testID="fixture-picker"><Text>Open native Select</Text></View>} popupClass="bg-background p-4" itemClass="p-3" />
        <Button testID="fixture-modal" onPress={() => modal.set(true)}><Text>Open nested Dialog</Text></Button>
        <Dialog open={modal()} animation="none" closeOnEscape onOpenChange={event => modal.set(event.open)} class="m-auto w-80 p-4 bg-background" backdropClass="bg-background/50">
          <Text testID="fixture-modal-content">Nested modal content</Text>
        </Dialog>
      </Scroll>
    </View>;
  }
  return <View class="flex-1 bg-background">
    <Button testID="fixture-reopen" onPress={() => open.set(true)}><Text>Open Settings</Text></Button>
    <Text testID="fixture-owner-count">{`owner-closes=${closes()}`}</Text>
    <Text>{`viewport=${JSON.stringify(windowSize())}`}</Text>
    <NativeDesktopSettingsWindow open={open()} active={active()} route={route()} dirty={dirty()} pending={pending()} nestedPickerOpen={nested() || modal()}
      confirmDiscard={() => { confirmations.set(confirmations() + 1); return approve(); }}
      onClose={() => { closes.set(closes() + 1); if (ownerCloses()) open.set(false); }}
      onNavigate={next => { navigations.set(navigations() + 1); route.set(next); }} renderPage={context => <Page context={context} />} />
  </View>;
}

mount(Fixture);

import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeDesktopSettingsWindow } from './desktop-settings';
import { NativeDesktopSettingsContent, desktopSettingsIntegratedPages, type DesktopSettingsContentNavigationState } from './desktop-settings-content';
import type { SettingsRoute } from './settings';
import { admitSettingsFixture } from './settings-raw-fixture-bootstrap';
import { native } from './runtime';
import { language } from './i18n';
import { nativeChatTextStyle } from './appearance';

function Fixture() {
  language.set('en');
  const ready = signal(false), error = signal(''), open = signal(true), closes = signal(0), navigations = signal(0);
  const state = signal<DesktopSettingsContentNavigationState | null>(null), audit = signal('');
  const codeTypographyReady = signal(false);
  const route = signal<SettingsRoute>({ page: 'projects', entity: 'catalog-do-not-use', directory: '/fixture/other-worktree' });
  void admitSettingsFixture().then(() => ready.set(true), failure => error.set(String(failure)));
  function onNavigationState(next: DesktopSettingsContentNavigationState) {
    if (next.status === 'retired' && state()?.owner !== next.owner) return;
    state.set(next);
  }
  const callbacks = {
    onOpen: (next: SettingsRoute) => { navigations.set(navigations() + 1); route.set({ ...next, directory: next.directory ?? route().directory }); },
    onBack: () => { navigations.set(navigations() + 1); route.set({ page: route().entity || route().create ? route().page : 'projects', directory: route().directory }); },
    onConnect: () => {},
  };
  return <View class="flex-1 bg-background">
    <Text>{`closes=${closes()};navigations=${navigations()}`}</Text>
    <Text>{`code-font-size=${nativeChatTextStyle('code').fontSize}`}</Text>
    <Button testID="content-fixture-reopen" onPress={() => open.set(true)}><Text>Reopen settings</Text></Button>
    <Button testID="content-fixture-code-ready" onPress={() => codeTypographyReady.set(true)}><Text>Admit code typography consumers</Text></Button>
    <If when={!!error()}><Text>{error()}</Text></If>
    <If when={ready()}><NativeDesktopSettingsWindow open={open()} route={route()} visiblePages={desktopSettingsIntegratedPages}
      pending={state()?.pending === true} dirty={state()?.dirty !== false || state()?.status !== 'ready'} nestedPickerOpen={state()?.nestedPickerOpen === true}
      confirmDiscard={() => state()?.requestLeave() ?? false} onClose={() => { closes.set(closes() + 1); open.set(false); }} onNavigate={callbacks.onOpen}
      renderPage={context => <View class="flex-1 min-h-0">
        <View class="p-2 gap-1">
          <Text>{`route=${route().page};entity=${route().entity ?? ''}`}</Text>
          <Text>{`page-active=${context.active}`}</Text>
          <Text>{`protection=${state()?.status};pending=${state()?.pending};dirty=${state()?.dirty};picker=${state()?.nestedPickerOpen}`}</Text>
          <Button testID="content-fixture-create" onPress={() => context.onNavigate({ page: route().page, create: true })}><Text>Create fixture entry</Text></Button>
          <Button testID="content-fixture-detail" onPress={() => context.onNavigate({ page: route().page, entity: route().page === 'magic-prompts' ? 'git.commit.generate' : 'fixture' })}><Text>Edit fixture entry</Text></Button>
          <Button testID="content-fixture-list" onPress={() => context.onNavigate({ page: route().page })}><Text>Fixture list</Text></Button>
          <Button testID="content-fixture-hold" onPress={() => { void native('desktopSettings.fixture.scenario', { mode: 'hold-write' }); }}><Text>Hold next write</Text></Button>
          <Button testID="content-fixture-release" onPress={() => { void native('desktopSettings.fixture.scenario', { mode: 'release-write' }); }}><Text>Release write</Text></Button>
          <Button testID="content-fixture-audit" onPress={() => { void native('projectSettings.fixture.audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Audit</Text></Button>
          <Text>{audit()}</Text>
        </View>
        <NativeDesktopSettingsContent route={context.route} active={context.active} callbacks={callbacks} onNavigationState={onNavigationState} codeTypographyReady={codeTypographyReady()} />
      </View>} /></If>
  </View>;
}
mount(Fixture);

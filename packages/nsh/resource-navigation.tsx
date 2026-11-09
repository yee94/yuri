import { cleanup, signal, View, Text } from 'nsh';
import { Button, NavPage } from 'nsh/base';
import { ResourcePreview, ResourcesBrowser, type ResourcesBrowserProps } from './resources';
import { createResourceRouteExit, type ResourceRetirementOwner, type ResourceConnectionExit } from './resource-retirement';
import { t } from './i18n';

type ResourceRouteProps = ResourcesBrowserProps & { title: string; onClose(): void; connectionExit?: (owner: ResourceConnectionExit) => () => void };

/** The page, not a child cleanup, owns permission to pop the native route. */
export function ResourceFilesPage(props: ResourceRouteProps) {
  return <ResourceRoutePage {...props}>{(attach, back) => <ResourcesBrowser {...props} retirementOwner={attach} onClose={back} />}</ResourceRoutePage>;
}

export function ResourcePreviewPage(props: ResourceRouteProps & { path: string; targetLine?: number }) {
  return <ResourceRoutePage {...props}>{attach => <View class="flex-1 p-4"><ResourcePreview {...props} retirementOwner={attach} onClose={undefined} /></View>}</ResourceRoutePage>;
}

function ResourceRoutePage(props: ResourceRouteProps & { children: (attach: (owner: ResourceRetirementOwner) => void, back: () => void) => ReturnType<typeof View> }) {
  const state = signal({ pending: false, error: '' });
  const exit = createResourceRouteExit({ current: () => props.active !== false, pop: props.onClose, changed: value => state.set(value) });
  cleanup(exit.detachDisplay);
  const back = () => { void exit.back().catch(() => {}); };
  const body = props.children(owner => exit.attach(owner), back);
  const unregister = props.connectionExit?.(exit);
  if (unregister) cleanup(unregister);
  return <NavPage title={props.title} headerBackTitle="" popOnBack={false} popOnSwipe={false} onBackPress={back} class="flex-1 bg-background">
    {body}
    <If when={!!state().error}><View class="gap-2 p-4"><Text class="text-destructive">{t('mobile.files.error.readUnavailable')}</Text><Button testID="resource-route-retire-retry" disabled={state().pending} onPress={back}><Text>{t('contextPanel.preview.actions.retry')}</Text></Button></View></If>
  </NavPage>;
}

import { cleanup, effect, lifecycle, signal, untracked } from 'nsh';
import { NativeDesktopChatHeaderActions, type NativeDesktopChatHeaderActionsProps } from './desktop-chat-header';
import { createDesktopHeaderServices, type DesktopHeaderInstancesPort, type DesktopHeaderServicesSnapshot, type DesktopHeaderServicesTab, type DesktopHeaderUpdatePort } from './desktop-header-services';
import { NativeDesktopHeaderInstance, NativeDesktopHeaderMcp } from './desktop-header-services-view';
import { createPageOperations } from './page-operations';

type Props = Omit<NativeDesktopChatHeaderActionsProps, 'services' | 'operation' | 'onServicesTabChange'> & {
  directory?: string;
  instances?: DesktopHeaderInstancesPort;
  update?: DesktopHeaderUpdatePort;
};

/** One runtime presenter per exact window/route/Host scope, not per popup mount. */
export function NativeDesktopRuntimeHeader(props: Props) {
  return <Each of={[props.scope]} key={scope => scope}>{() => <RuntimeHeader {...props} />}</Each>;
}

function RuntimeHeader(props: Props) {
  const operations = createPageOperations(() => props.active && props.current());
  const tab = signal<DesktopHeaderServicesTab | null>(null);
  const snapshot = signal<DesktopHeaderServicesSnapshot | null>(null);
  const directory = untracked(() => props.directory);
  const services = createDesktopHeaderServices({ directory, current: operations.displayCurrent, operation: operations.operation,
    instances: props.instances, update: props.update, changed: value => snapshot.set(value) });
  snapshot.set(services.snapshot());
  const active = () => props.active && props.current() && lifecycle() === 'active' && operations.current();
  function demand(value: DesktopHeaderServicesTab | null) {
    tab.set(value);
    services.update({ tab: value, active: active() });
  }
  effect(() => {
    operations.operation();
    const visible = tab(), admitted = active();
    untracked(() => services.update({ tab: visible, active: admitted }));
  });
  cleanup(() => services.dispose());
  return <NativeDesktopChatHeaderActions {...props} operation={operations.operation} onServicesTabChange={demand}
    servicesBusy={snapshot()?.instancePending !== null}
    services={{ instance: () => <NativeDesktopHeaderInstance owner={services} snapshot={snapshot()!} />,
      mcp: () => <NativeDesktopHeaderMcp owner={services} snapshot={snapshot()!} directory={directory} /> }} />;
}

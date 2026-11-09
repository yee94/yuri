import { cleanup, computed, effect, signal, untracked, type Bounds, type ViewRef } from 'nsh';
import { sameRuntimeScope } from './runtime-scope';
import { createNativeDesktopWorkStatusOwner, createNativeDesktopWorkStatusWindowOwner, NativeDesktopWorkStatusPanel, type DesktopWorkStatusAdmission, type NativeDesktopWorkStatusActions } from './desktop-work-status';
import { desktopWorkStatusLayout, type DesktopWorkStatusChat, type DesktopWorkStatusChild, type DesktopWorkStatusChildRead, type DesktopWorkStatusLayoutInput, type DesktopWorkStatusLocation, type DesktopWorkStatusScope } from './desktop-work-status-core';

function sameBounds(left: Bounds | null, right: Bounds) {
  return left?.origin.x === right.origin.x && left.origin.y === right.origin.y && left.size.width === right.size.width && left.size.height === right.size.height;
}

export function createNativeDesktopChatWorkStatusWindow(input: () => DesktopWorkStatusLayoutInput) {
  const owner = createNativeDesktopWorkStatusWindowOwner();
  const layout = computed(() => desktopWorkStatusLayout(input(), owner.state()));
  const toggleBounds = signal<Bounds | undefined>(undefined);
  let node: ViewRef | undefined, alive = true, measurement = 0;
  cleanup(() => { alive = false; measurement++; node = undefined; });
  return { owner, layout, toggleBounds,
    toggle() { owner.toggle(layout().fits); },
    toggleRef(value: ViewRef) { node = value; },
    async measureToggle() {
      const captured = node, ticket = ++measurement;
      const value = await captured?.measure();
      if (!alive || ticket !== measurement || node !== captured || !value) return;
      const next = { origin: value.pagePosition, size: value.bounds.size };
      if (!sameBounds(toggleBounds() ?? null, next)) toggleBounds.set(next);
    },
  };
}
export type NativeDesktopChatWorkStatusWindow = ReturnType<typeof createNativeDesktopChatWorkStatusWindow>;

type Options = Omit<DesktopWorkStatusAdmission, 'scope'> & {
  scope(): DesktopWorkStatusScope | null;
  window(): NativeDesktopChatWorkStatusWindow | null;
  chat(): DesktopWorkStatusChat;
  location(): DesktopWorkStatusLocation;
  readChildren?: DesktopWorkStatusChildRead;
  observeChildren?: (operation: NonNullable<ReturnType<DesktopWorkStatusAdmission['operation']>>, scope: DesktopWorkStatusScope,
    children: readonly DesktopWorkStatusChild[], changed: (children: readonly DesktopWorkStatusChild[]) => void) => () => void;
  actions: NativeDesktopWorkStatusActions;
};

/** The mounted Chat owns data. This binding only connects its narrow projection,
 * real body geometry and the one window preference to the native presenter. */
export function createNativeDesktopChatWorkStatus(options: Options) {
  const bodyBounds = signal<Bounds | null>(null);
  let body: ViewRef | undefined, alive = true, measurement = 0;
  cleanup(() => { alive = false; measurement++; body = undefined; });
  const current = (scope: DesktopWorkStatusScope) => {
    const next = options.scope();
    return alive && options.current() && !!next && sameRuntimeScope(scope.host, next.host) && scope.authorityKey === next.authorityKey && scope.sessionID === next.sessionID && scope.directory === next.directory;
  };
  function Content(props: { scope: DesktopWorkStatusScope }) {
    const scope = props.scope;
    const owner = createNativeDesktopWorkStatusOwner({ scope, current: () => current(scope),
      active: options.active, interactive: options.interactive, operation: options.operation });
    effect(() => { const chat = options.chat(); untracked(() => owner.projection.commitChat(chat)); });
    effect(() => { const location = options.location(); untracked(() => owner.projection.commitLocation(location)); });
    let childDemand: ReturnType<Options['operation']> = null;
    let childGeneration = 0, stopChildren: (() => void) | undefined;
    const retireChildren = () => { childGeneration++; stopChildren?.(); stopChildren = undefined; };
    cleanup(retireChildren);
    effect(() => {
      const operation = options.operation(), window = options.window(), layout = window?.layout();
      const demanded = !!layout && (layout.inline || layout.overlay) && options.active() && options.interactive() && operation?.current() === true;
      untracked(() => {
        if (!demanded) { childDemand = null; retireChildren(); return; }
        if (childDemand === operation || !options.readChildren) return;
        retireChildren();
        childDemand = operation;
        const generation = childGeneration;
        const current = () => alive && generation === childGeneration && childDemand === operation && !!operation?.current()
          && options.active() && options.interactive() && !!(options.window()?.layout().inline || options.window()?.layout().overlay);
        void owner.readChildren(options.readChildren).then(() => {
          if (!operation || !current() || !options.observeChildren) return;
          const children = owner.projection.state().children.value;
          if (!children) return;
          const stop = options.observeChildren(operation, scope, children, rows => {
            if (!current()) return;
            const previous = owner.projection.state().children;
            if (rows !== previous.value) owner.projection.commitChildren({ phase: previous.phase === 'failed' ? 'failed' : 'ready', value: rows });
          });
          if (current()) stopChildren = stop; else stop();
        });
      });
    });
    return <If when={!!bodyBounds() && !!options.window()}>{() => {
      const window = options.window()!;
      return <NativeDesktopWorkStatusPanel owner={owner} actions={options.actions} chatBounds={bodyBounds()!}
        visible={!!window.layout().inline || !!window.layout().overlay && options.interactive()} overlay={window.layout().overlay}
        toggleBounds={window.toggleBounds()} onCloseOverlay={window.owner.closeOverlay} />;
    }}</If>;
  }
  function Panel() {
    return <Each of={options.scope() ? [options.scope()!] : []} key={scope => JSON.stringify([scope.host, scope.authorityKey, scope.sessionID, scope.directory])}>{scope => <Content scope={scope()} />}</Each>;
  }
  return { Panel,
    reserve: () => options.scope() && options.current() ? options.window()?.layout().reserve ?? 0 : 0,
    bodyRef(value: ViewRef) { body = value; },
    async measureBody() {
      const captured = body, ticket = ++measurement;
      const value = await captured?.measure();
      if (!alive || ticket !== measurement || body !== captured || !value) return;
      const next = { origin: value.pagePosition, size: value.bounds.size };
      if (next.size.width > 0 && next.size.height > 0 && !sameBounds(bodyBounds(), next)) bodyBounds.set(next);
    },
  };
}

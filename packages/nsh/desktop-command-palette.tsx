import { cleanup, effect, keymap, signal, untracked, type JSX } from 'nsh';
import { Dialog } from 'nsh/base';
import { ProjectsSearchContent, type ProjectsSearchProps } from './projects-search';

export type NativeDesktopCommandPaletteProps = ProjectsSearchProps & {
  open: boolean;
  onClose: () => void;
  scope?: unknown;
  onCompositionChange?: (composing: boolean) => void;
};

/** The product search content, without a NavPage or a second search controller. */
export function NativeDesktopCommandPalette(props: NativeDesktopCommandPaletteProps) {
  const composing = signal(false);
  return <NativeDesktopCommandPaletteAdapter open={props.open} active={props.active} scope={props.scope} composing={composing()}
    onOpenChange={open => { if (!open) props.onClose(); }} renderSearch={content => <ProjectsSearchContent {...props} presentation="dialog" active={content.active()} onClose={content.close}
      onCompositionChange={value => { composing.set(value); props.onCompositionChange?.(value); }} />} />;
}

export type NativeDesktopCommandPaletteContent = {
  /** Pass through to the existing search owner; hidden content is unmounted. */
  active: () => boolean;
  close: () => void;
  /** Close before navigation; the injected content owns request cancellation. */
  select: (work: () => void) => void;
};
export type NativeDesktopCommandPaletteAdapterProps = {
  open: boolean;
  active?: boolean;
  scope?: unknown;
  composing?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reuse ProjectsSearchPage/controller content here. This adapter deliberately
   * owns no independent search, action catalog, requests or application state. */
  renderSearch: (content: NativeDesktopCommandPaletteContent) => JSX.Element;
};

/** Desktop-only Dialog adapter. The main thread supplies the shared search content;
 * no copied native command/search implementation or nested navigation is created. */
export function NativeDesktopCommandPaletteAdapter(props: NativeDesktopCommandPaletteAdapterProps) {
  effect(() => { if (props.open && props.active === false) untracked(() => props.onOpenChange(false)); });
  return <If when={props.open && props.active !== false}><PaletteDialog {...props} /></If>;
}

function PaletteDialog(props: NativeDesktopCommandPaletteAdapterProps) {
  const scope = props.scope;
  let alive = true, closed = false;
  const active = () => alive && !closed && props.open && props.active !== false && props.scope === scope;
  const close = () => { if (active()) { closed = true; props.onOpenChange(false); } };
  cleanup(() => { alive = false; });
  effect(() => {
    if (!active() || props.composing) return;
    cleanup(keymap.bind('escape', () => untracked(close), { when: 'always' }));
  });
  effect(() => { if (props.scope !== scope && props.open) untracked(() => props.onOpenChange(false)); });
  const content = untracked(() => props.renderSearch({ active, close, select: work => { if (active()) { close(); work(); } } }));
  return <Dialog testID="desktop-command-palette" open={active()} animation="fade" closeOnEscape={false} closeOnBackdropPress
    class="bg-background rounded-2xl overflow-hidden" backdropClass="bg-background/50"
    style={{ position: 'absolute', width: '88%', maxWidth: 640, height: '72%', maxHeight: 560, alignSelf: 'center', top: '10%' }}
    onOpenChange={event => { if (!event.open) close(); }}>
    {content}
  </Dialog>;
}

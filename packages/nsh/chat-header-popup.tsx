import { cleanup, effect, Overlay, signal, untracked, windowSize, type Bounds, type JSX } from 'nsh';
import { Popover, type PopoverProps } from 'nsh/base';
import { native } from './runtime';

type Props = Pick<PopoverProps, 'open' | 'placement' | 'align' | 'offset' | 'margin' | 'popupClass' | 'popupStyle' | 'onOpenChange' | 'children'> & {
  native?: boolean;
  anchorID: string;
  current: () => boolean;
  trigger: (onPress?: () => void) => JSX.Element;
  onError: (error: unknown) => void;
};

/** UIKit bar slots have their own layout root. Their authoritative surface bounds
 * come from UIKit, not NSH's slot-local layout coordinates. */
export function ChatHeaderPopup(props: Props) {
  const anchor = signal<Bounds | null>(null);
  let revision = 0;
  cleanup(() => { revision++; });
  effect(() => {
    if (!props.native) return;
    const open = props.open;
    windowSize();
    const operation = ++revision;
    anchor.set(null);
    if (!open || !props.current()) return;
    untracked(() => {
      void native<Bounds | null>('navigation.anchor', { id: props.anchorID }).then(bounds => {
        if (revision !== operation || !props.current()) return;
        if (!bounds) throw new Error('Navigation anchor is not visible');
        anchor.set(bounds);
      }).catch(error => {
        if (revision !== operation || !props.current()) return;
        props.onOpenChange?.({ open: false, reason: 'cancel' });
        props.onError(error);
      });
    });
  });
  const close = (reason: 'pressOutside' | 'cancel') => props.onOpenChange?.({ open: false, reason });
  return <If when={props.native} else={<Popover open={props.open} placement={props.placement} align={props.align} offset={props.offset} margin={props.margin} popupClass={props.popupClass} popupStyle={props.popupStyle} onOpenChange={props.onOpenChange} trigger={props.trigger()}>{props.children}</Popover>}>
    {props.trigger(() => props.onOpenChange?.({ open: !props.open, reason: 'triggerPress' }))}
    <If when={props.open && !!anchor()}><Overlay anchor={anchor()} placement={props.placement} align={props.align} offset={props.offset} margin={props.margin} class={props.popupClass ?? undefined} style={props.popupStyle} onPressOutside={() => close('pressOutside')} onCancel={() => close('cancel')}>{props.children}</Overlay></If>
  </If>;
}

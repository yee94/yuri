import { cleanup, nativeComponent, platform } from 'nsh';
import { createDesktopTabEventGate, desktopTabEventsComponent, type DesktopTabEventBinding } from './desktop-panel-tabs-events-core';
const NativeEvents = nativeComponent<{ binding: DesktopTabEventBinding }, { middleClose: unknown; tabFocus: unknown; tabBlur: unknown }>(desktopTabEventsComponent, {
  props: ['binding'], events: ['middleClose', 'tabFocus', 'tabBlur'],
});
export function DesktopPanelTabNativeEvents(props: {
  binding: DesktopTabEventBinding; current: () => boolean; enabled: () => boolean; modal: () => boolean;
  middle: () => unknown; focus: () => void; blur: () => void;
}) {
  const gate = createDesktopTabEventGate({ binding: () => props.binding, current: props.current, enabled: props.enabled, modal: props.modal,
    windows: platform.os === 'windows', middle: props.middle, focus: props.focus, blur: props.blur });
  cleanup(gate.dispose);
  return <NativeEvents binding={props.binding} style={{ width: 0, height: 0, position: 'absolute', pointerEvents: 'none' }}
    onMiddleClose={event => { gate.event('middleClose', event); }} onTabFocus={event => { gate.event('tabFocus', event); }} onTabBlur={event => { gate.event('tabBlur', event); }} />;
}

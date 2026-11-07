import { nativeComponent } from 'nsh';

const InputAX = nativeComponent<{ field: 'selection' | 'presets' | 'directory'; label: string }, {
  failure: { code: string };
}>('yuri.newSession.inputAX', { props: ['field', 'label'], events: ['failure'] });

/** A nonvisual registration sibling; the existing NSH Input remains the editor. */
export function NativeNewSessionInputAX(props: { field: 'selection' | 'presets' | 'directory'; label: string }) {
  return <InputAX field={props.field} label={props.label} accessible={false} accessibilityElementsHidden
    style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
    onFailure={event => console.error(`[new-session-input-ax] ${props.field}: ${event.code}`)} />;
}

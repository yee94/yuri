import { cleanup, nativeComponent, type NativeComponentRef } from 'nsh';

const Registration = nativeComponent<{ config: { ownerID: string; inputID: string } }>('yuri.composer.press', { props: ['config'] });

/** Zero-size sibling of the composer Input. Native code scales the glass card from the editor's touches. */
export function NativeComposerPress(props: { ownerID: string; inputID: string }) {
  let registration: NativeComponentRef | undefined;
  cleanup(() => registration?.command('retire'));
  return <Registration config={{ ownerID: props.ownerID, inputID: props.inputID }} ref={ref => { registration = ref; }}
    accessible={false} accessibilityElementsHidden style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }} />;
}

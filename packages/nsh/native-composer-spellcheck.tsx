import { cleanup, nativeComponent, type NativeComponentRef } from 'nsh';

const Registration = nativeComponent<{ config: { ownerID: string; inputID: string } }>('yuri.composer.spellcheck', { props: ['config'] });

/** Mount beside the original multiline Input; visibility/Host state never changes this lease. */
export function NativeComposerSpellcheck(props: { ownerID: string; inputID: string }) {
  let registration: NativeComponentRef | undefined;
  cleanup(() => registration?.command('retire'));
  return <Registration config={{ ownerID: props.ownerID, inputID: props.inputID }} ref={ref => { registration = ref; }}
    accessible={false} accessibilityElementsHidden style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }} />;
}

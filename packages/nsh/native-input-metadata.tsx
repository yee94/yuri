import { nativeComponent } from 'nsh';

type InputMetadataConfig = {
  ownerID: string;
  inputID: string;
  expectedKind: 'multiline';
  editorAXID: string;
  label: string;
  active: boolean;
};
const Registration = nativeComponent<{ config: InputMetadataConfig }>('yuri.input.metadata', { props: ['config'] });
let mountSequence = 0;

/** Nonvisual sibling of the original Input. IDs remain stable for this mounted leaf. */
export function NativeInputMetadata(props: { ownerID: string; inputID: string; label: string; active: boolean }) {
  const editorAXID = `yuri-input-editor-${++mountSequence}`;
  return <Registration config={{ ownerID: props.ownerID, inputID: props.inputID, expectedKind: 'multiline', editorAXID, label: props.label, active: props.active }}
    accessible={false} accessibilityElementsHidden style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }} />;
}

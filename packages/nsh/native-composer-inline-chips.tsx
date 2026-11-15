import { colorScheme, nativeComponent } from 'nsh';
import { nativeAppearance } from './appearance';
import type { NativeReference } from './composer-references';
import { buildInlineChipConfig, referenceChipColors, type InlineChipColors, type NativeInlineChipConfig } from './composer-inline-chips';

const Registration = nativeComponent<{ config: NativeInlineChipConfig }>('yuri.composer.inlineChips', { props: ['config'] });

function chipColors(): InlineChipColors {
  const appearance = nativeAppearance.current();
  const dark = colorScheme() === 'dark';
  const theme = appearance?.webTheme?.[dark ? 'dark' : 'light'];
  return referenceChipColors(theme, dark);
}

/**
 * Decoration-only sibling of the real multiline Input. The bridge replaces each
 * reference's `@` trigger with its icon and colors the label; the Input keeps
 * the logical text, native selection, IME, spellcheck, metadata and draft.
 * NSH mounts this component once, so `config` must stay a lazy JSX expression:
 * a captured snapshot would freeze the references present at mount time.
 */
export function NativeComposerInlineChips(props: {
  ownerID: string;
  inputID: string;
  textLength: number;
  references: readonly NativeReference[];
  active?: boolean;
}) {
  // Inactive clears decorations only. The native bridges reconcile against the
  // real editor length, so a zero-length plan would never reach the clear step.
  const config = () => props.active === false ? { ownerID: props.ownerID, inputID: props.inputID, textLength: props.textLength, chips: [] }
    : buildInlineChipConfig({ ownerID: props.ownerID, inputID: props.inputID, textLength: props.textLength, references: props.references, colors: chipColors() });
  return <Registration config={config()} accessible={false} accessibilityElementsHidden style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }} />;
}

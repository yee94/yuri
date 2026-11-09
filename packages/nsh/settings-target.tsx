import { View, type Bounds, type JSX, type ViewRef } from 'nsh';

/** Smallest field owner; the page Scroll performs one measured reveal after layout. */
export function SettingsTarget(props: { id: string; target?: string; onReveal?: (node: ViewRef) => void; onLayout?: (event: { bounds: Bounds }) => void; children?: JSX.Element }) {
  let node!: ViewRef;
  return <View ref={node} testID={`settings-target-${props.id}`} onLayout={event => { props.onLayout?.(event); if (props.target === props.id && node) props.onReveal?.(node); }} class={props.target === props.id ? 'rounded-xl bg-accent gap-2' : 'gap-2'}>{props.children}</View>;
}

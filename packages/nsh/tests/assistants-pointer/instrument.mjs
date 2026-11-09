/** Instrument only the frozen test-stage copy. Fail closed if production anchors change. */
export function instrumentPointerRow(source) {
  function replace(before, after) {
    if (source.split(before).length !== 2) throw Error('Pointer instrumentation anchor changed: ' + before);
    source = source.replace(before, after);
  }
  replace("import { Button } from 'nsh/base';", "import { Button } from 'nsh/base';\nimport { record } from './tests/assistants-pointer/trace';");
  replace('      binding = nextBinding;', `      if (binding !== nextBinding) record('retire-binding');
      if (generation !== nextGeneration) record('retire-generation');
      if (pinned !== nextPinned) record('retire-pinned');
      if (disabled !== nextDisabled) record('retire-disabled');
      binding = nextBinding;`);
  replace('touching = false; cancelled = true; swipe.close();', "record('close-accessibility'); touching = false; cancelled = true; swipe.close();");
  replace('write: value => offset.set(value)', "write: value => { record(value === 0 ? 'offset-zero' : value === -128 ? 'offset-open' : 'offset-partial'); offset.set(value); }");
  replace('  function endGesture(terminated: boolean) {', "  function endGesture(terminated: boolean) {\n    record(terminated ? 'terminate' : 'release');");
  replace('    if (props.disabled || props.pinned || props.revealed !== props.id) swipe.close();', `    if (props.disabled || props.pinned || props.revealed !== props.id) {
      record(props.disabled ? 'close-disabled' : props.pinned ? 'close-pinned' : 'close-unrevealed'); swipe.close();
    }`);
  replace('  cleanup(swipe.close);', "  cleanup(() => { record('close-cleanup'); swipe.close(); });");
  replace('onStartShouldSetPanResponder: () => { current();', "onStartShouldSetPanResponder: () => { record('start'); current();");
  replace('onMoveShouldSetPanResponder: (_, gesture) => current() && !props.pinned && swipe.claim(gesture.dx, gesture.dy, gesture.numberActiveTouches),', `onMoveShouldSetPanResponder: (_, gesture) => {
      const claimed = current() && !props.pinned && swipe.claim(gesture.dx, gesture.dy, gesture.numberActiveTouches);
      record(claimed ? 'claim-yes' : 'claim-no'); return claimed;
    },`);
  replace('onPanResponderGrant: () => { if (current()) { panned = true; swipe.grant(); } },', "onPanResponderGrant: () => { if (current()) { record('grant'); panned = true; swipe.grant(); } else record('grant-rejected'); },");
  replace('onPanResponderMove: (_, gesture) => { if (!current()) return; if (gesture.numberActiveTouches !== 1) swipe.cancel(); else swipe.move(gesture.dx); },', "onPanResponderMove: (_, gesture) => { record('move'); if (!current()) { record('move-rejected'); return; } if (gesture.numberActiveTouches !== 1) { record('multitouch-cancel'); swipe.cancel(); } else swipe.move(gesture.dx); },");
  replace('onPanResponderTerminationRequest: () => true,', "onPanResponderTerminationRequest: () => { record('termination-request'); return true; },");
  replace('onShouldBlockNativeResponder: () => current() && !props.pinned,', "onShouldBlockNativeResponder: () => { const block = current() && !props.pinned; record(block ? 'block-yes' : 'block-no'); return block; },");
  return source;
}

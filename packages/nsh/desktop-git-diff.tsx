import { computed } from 'nsh';
import { DiffView, type DiffViewProps } from 'nsh/base';
import { nativeChatTextStyle } from './appearance';

/** NSH 0.4 DiffView fontSize and row lineHeight are both native points.
 * Keep the component/source mounted: typography updates only remeasure rows. */
export function DesktopGitDiff(props: Omit<DiffViewProps, 'fontFamily' | 'fontSize' | 'lineHeight'>) {
  const code = computed(() => nativeChatTextStyle('code'));
  return <DiffView {...props} fontFamily={code().fontFamily} fontSize={code().fontSize} lineHeight={code().lineHeight} />;
}

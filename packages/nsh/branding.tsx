import { Image, colorScheme } from 'nsh';
import markBlack from './assets/brand/yuri-b-mark-black.svg';
import markWhite from './assets/brand/yuri-b-mark-white.svg';
import wordmarkBlack from './assets/brand/yuri-wordmark-black.svg';
import wordmarkWhite from './assets/brand/yuri-wordmark-white.svg';

/** Brand dimensions in native points, shared by welcome and About surfaces. */
export const yuriBrandSizes = {
  mark: { compact: 24, standard: 64, hero: 96 },
  wordmark: { compact: 36, standard: 112, hero: 160 },
} as const;

export interface YuriBrandProps {
  size?: keyof typeof yuriBrandSizes.mark;
  /** Hide a repeated decorative mark when the nearby wordmark already names Yuri. */
  decorative?: boolean;
  testID?: string;
}

/** The approved Yuri B silhouette; the native image follows system appearance. */
export function YuriMark(props: YuriBrandProps) {
  return <Image
    src={colorScheme() === 'dark' ? markWhite : markBlack}
    style={{ width: yuriBrandSizes.mark[props.size ?? 'standard'], height: yuriBrandSizes.mark[props.size ?? 'standard'], objectFit: 'contain' }}
    accessible={!props.decorative}
    accessibilityLabel={props.decorative ? undefined : 'Yuri'}
    testID={props.testID}
  />;
}

/** The approved outlined wordmark, preserving its original aspect ratio. */
export function YuriWordmark(props: YuriBrandProps) {
  return <Image
    src={colorScheme() === 'dark' ? wordmarkWhite : wordmarkBlack}
    style={{ width: yuriBrandSizes.wordmark[props.size ?? 'standard'], height: yuriBrandSizes.wordmark[props.size ?? 'standard'] * wordmarkBlack.size.height / wordmarkBlack.size.width, objectFit: 'contain' }}
    accessible={!props.decorative}
    accessibilityLabel={props.decorative ? undefined : 'Yuri'}
    testID={props.testID}
  />;
}

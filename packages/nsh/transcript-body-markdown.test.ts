import { expect, test, vi } from 'vitest';

vi.mock('./appearance', () => ({ nativeChatTextStyle: (role: string) => role === 'code' ? { fontSize: 13, fontFamily: 'monospace' } : { fontSize: 15.75, lineHeight: 25.59375 } }));
import { nativeTranscriptMarkdownStyles } from './transcript-body-markdown';

test('list geometry matches Web 19/18px gutters and 1px item inset without narrowing native marker text boxes', () => {
  const styles = nativeTranscriptMarkdownStyles('assistant');
  expect(styles.orderedList).toEqual({ paddingLeft: 19 });
  expect(styles.unorderedList).toEqual({ paddingLeft: 18 });
  expect(styles.listItem).toEqual({ paddingLeft: 1 });
  expect(styles.listMarker).toMatchObject({ width: 'max-content', paddingRight: 0, marginRight: 6 });
  expect(styles.listMarker).toMatchObject({ fontSize: 15.75 * .72, lineHeight: 25.59375 });
  expect(styles.code).toEqual({ fontSize: 13, fontFamily: 'monospace' });
  expect(nativeTranscriptMarkdownStyles('user', true).paragraph).toEqual({ marginTop: 0, marginBottom: 0 });
});

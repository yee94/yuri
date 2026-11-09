import { Image, token } from 'nsh';
import { assignLanes, type LanedCommit } from '../ui/src/components/views/git/gitGraph';
import type { DesktopGitCommit } from './desktop-git-model';

/** Web's pure lane algorithm, native SVG image. No DOM/SVG component runtime. */
export function desktopGitGraph(commits: DesktopGitCommit[]) {
  const rows = assignLanes(commits);
  const lanes = rows.reduce((maximum, row) => Math.max(maximum, row.lane + 1, ...row.connectors.flatMap(segment => [segment.fromLane + 1, segment.toLane + 1])), 1);
  return { rows, width: lanes * 14 + 10 };
}

export function NativeDesktopGitGraphSegment(props: { row: LanedCommit; width: number }) {
  const x = (lane: number) => lane * 14 + 10, height = 64, middle = height / 2;
  const source = () => {
    const foreground = String(token('foreground')), background = String(token('background'));
    const paths = props.row.connectors.map(segment => {
      const from = x(segment.fromLane), to = x(segment.toLane);
      const path = segment.type === 'branch-out' ? `M ${from} ${middle} C ${from} ${height}, ${to} ${middle}, ${to} ${height}`
        : segment.type === 'merge-in' ? `M ${from} 0 C ${from} ${middle}, ${to} 0, ${to} ${middle}`
        : segment.type === 'top-stub' ? `M ${from} 0 L ${from} ${middle}`
        : segment.type === 'bottom-stub' ? `M ${from} ${middle} L ${from} ${height}`
        : `M ${from} 0 L ${from} ${height}`;
      return `<path d="${path}" fill="none" stroke="${foreground}" stroke-width="1.5"/>`;
    }).join('');
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${props.width}" height="${height}" viewBox="0 0 ${props.width} ${height}">${paths}<circle cx="${x(props.row.lane)}" cy="${middle}" r="3.5" stroke="${foreground}" fill="${background}" stroke-width="2"/></svg>`);
  };
  return <Image testID={`desktop-git-graph-${props.row.commit.hash}`} src={source()} style={{ width: props.width, height, flexShrink: 0 }} />;
}

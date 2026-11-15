/** Web assistant-workspace.css uses sRGB mixing, independent of the theme accent. */
export function assistantPanelColor(background: string, dark: boolean): string {
  const short = /^#[\da-f]{3}$/i.test(background);
  const value = short ? '#' + [...background.slice(1)].map(char => char + char).join('') : background;
  if (!/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)) return background;
  const amount = dark ? .06 : .03, target = dark ? 255 : 0;
  return '#' + [1, 3, 5].map(offset => Math.round(parseInt(value.slice(offset, offset + 2), 16) * (1 - amount) + target * amount).toString(16).padStart(2, '0')).join('');
}

/** Same single closed body/tail silhouette as Web ContactMessageBubble. */
export function assistantBubblePath(width: number, height: number, outgoing: boolean, joinedBefore = false, joinedAfter = false): string {
  const radius = Math.min(18, width / 2, height / 2), join = Math.min(6, radius);
  const tl = !outgoing && joinedBefore ? join : radius;
  const tr = outgoing && joinedBefore ? join : radius;
  const bl = outgoing ? radius : join, br = outgoing ? join : radius;
  const x = 8, right = x + width;
  const bottomRight = outgoing && !joinedAfter
    ? `V ${height - 10} C ${right} ${height - 5} ${right + 3} ${height - 1} ${right + 8} ${height}`
    : `V ${height - br} A ${br} ${br} 0 0 1 ${right - br} ${height}`;
  const bottomLeft = !outgoing && !joinedAfter
    ? `H 0 C 5 ${height - 1} ${x} ${height - 5} ${x} ${height - 10}`
    : `H ${x + bl} A ${bl} ${bl} 0 0 1 ${x} ${height - bl}`;
  return `M ${x + tl} 0 H ${right - tr} A ${tr} ${tr} 0 0 1 ${right} ${tr} ${bottomRight} ${bottomLeft} V ${tl} A ${tl} ${tl} 0 0 1 ${x + tl} 0 Z`;
}

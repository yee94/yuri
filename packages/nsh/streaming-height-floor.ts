/**
 * Height a row must keep while its message is still streaming. Web never lets a streaming
 * row get shorter between frames (partial Markdown, tool/activity rows and the thinking
 * block re-flow, and the intermediate layout is taller or shorter than the next one);
 * native follows: the floor only rises while streaming and is released once the row settles.
 */
export function nextStreamingHeightFloor(previous: number, measured: number, streaming: boolean): number {
  if (!streaming) return 0;
  if (!Number.isFinite(measured) || measured <= 0) return previous;
  // Whole points: sub-point layout noise must not ratchet the floor upward on its own.
  return Math.max(previous, Math.floor(measured));
}

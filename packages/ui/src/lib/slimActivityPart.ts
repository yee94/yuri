/** Data-only predicate; safe for native exact reads without task/render dependencies. */
export function isSlimActivityPart(part: { type: string; slim?: unknown }): boolean {
  return part.slim === true && (part.type === 'tool' || part.type === 'reasoning' || part.type === 'file');
}

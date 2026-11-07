const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Official tool result content is authoritative even when an older output field is also present. */
export function projectionToolOutput(state: Record<string, unknown>): string | undefined {
  const content = state.content;
  if (!Array.isArray(content)) return typeof state.output === 'string' ? state.output : undefined;
  return content.flatMap(item => record(item) && item.type === 'text' && typeof item.text === 'string' ? [item.text] : []).join('\n');
}

/** OpenCode 2 keeps tool execution clocks on the part, not inside state. */
export function projectionToolTime(value: unknown): { start?: number; end?: number } {
  const time = record(value) ? value : {};
  return {
    ...(typeof time.ran === 'number' && Number.isFinite(time.ran) ? { start: time.ran } : {}),
    ...(typeof time.completed === 'number' && Number.isFinite(time.completed) ? { end: time.completed } : {}),
  };
}

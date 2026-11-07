type Context = { scope: string; active: boolean; visible: boolean; contentKey: string };
type NaturalRef = { measure(): Promise<{ bounds: { size: { height: number } } } | null | undefined> };

/** Fixture-only natural-content reader. No held wrapper/ref, timers, or scroll geometry. */
export function createNaturalFooterReader(accept: (scope: string, height: number, contentKey: string) => boolean) {
  let context: Context | undefined, ref: NaturalRef | null = null, ticket = 0, wasActive = false, initialLayout = true;
  return {
    update(next: Context) {
      if (!context || context.scope !== next.scope) { wasActive = false; initialLayout = true; }
      if (context?.active && !next.active) initialLayout = false;
      if (!context || Object.keys(next).some(key => next[key as keyof Context] !== context![key as keyof Context])) ticket++;
      context = { ...next }; wasActive ||= next.active;
    },
    attach(next: NaturalRef | null) { if (ref !== next) { ref = next; ticket++; } },
    layout(node: NaturalRef | null, scope: string, contentKey: string, height: number) {
      if (!context || node !== ref || !ref || context.scope !== scope || context.contentKey !== contentKey || !context.visible || !context.active && (!initialLayout || wasActive)) return false;
      ticket++; // A newer real layout supersedes a pending ref read.
      return accept(scope, height, contentKey);
    },
    async measure() {
      if (!context?.active || !context.visible || !ref) return false;
      const captured = { ...context }, node = ref, id = ++ticket;
      const matches = () => id === ticket && node === ref && context?.active && context.visible && context.scope === captured.scope && context.contentKey === captured.contentKey;
      try {
        const frame = await node.measure();
        if (!matches()) return false;
        const height = frame?.bounds.size.height;
        return height !== undefined && Number.isFinite(height) && height > 0 && accept(captured.scope, height, captured.contentKey);
      } catch (failure) { if (!matches()) return false; throw failure; }
    },
    invalidate() { ticket++; ref = null; context = undefined; wasActive = false; initialLayout = false; },
  };
}

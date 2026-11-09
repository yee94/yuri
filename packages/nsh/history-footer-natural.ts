type Context = { scope: string; active: boolean; visible: boolean; contentKey: string };
export type NativeHistoryNaturalRef = { measure(): Promise<{ bounds: { size: { height: number } } } | null | undefined> };
type NaturalRef = NativeHistoryNaturalRef;

/** Natural-content reader. No held wrapper/ref, timers, or scroll geometry. */
export function createNaturalFooterReader(accept: (scope: string, height: number, contentKey: string) => boolean) {
  let context: Context | undefined, ref: NaturalRef | null = null, ticket = 0, sourceGeneration = 0, wasActive = false, initialLayout = true;
  let bindingGeneration = 0;
  function attach(next: NaturalRef | null) { if (ref !== next) { ref = next; ticket++; sourceGeneration++; } }
  function layout(node: NaturalRef | null, scope: string, contentKey: string, height: number) {
    if (!context || node !== ref || !ref || context.scope !== scope || context.contentKey !== contentKey || !context.visible || !context.active && (!initialLayout || wasActive)) return false;
    ticket++; // A newer real layout supersedes a pending ref read.
    return accept(scope, height, contentKey);
  }
  return {
    update(next: Context) {
      if (!context || context.scope !== next.scope || context.contentKey !== next.contentKey || context.visible !== next.visible || context.active && !next.active) sourceGeneration++;
      if (!context || context.scope !== next.scope) { wasActive = false; initialLayout = true; }
      if (context?.active && !next.active) initialLayout = false;
      if (!context || Object.keys(next).some(key => next[key as keyof Context] !== context![key as keyof Context])) ticket++;
      context = { ...next }; wasActive ||= next.active;
    },
    attach,
    layout,
    captureLayout(node: NaturalRef | null, scope: string, contentKey: string) {
      const generation = sourceGeneration;
      return (height: number) => generation === sourceGeneration && layout(node, scope, contentKey, height);
    },
    captureSource(scope: string, contentKey: string) {
      const binding = ++bindingGeneration;
      attach(null);
      const born = sourceGeneration;
      let node: NaturalRef | undefined, generation: number | undefined, retired = false;
      const current = () => !retired && binding === bindingGeneration;
      function retire() {
        if (current() && node === ref) attach(null);
        retired = true;
      }
      return {
        current: () => current() && generation === sourceGeneration,
        ref(next: NaturalRef | null) {
          if (!current()) return false;
          if (!node && born !== sourceGeneration) { retire(); return false; }
          if (!next) { retire(); return true; }
          if (node) { if (node !== next) { retire(); return false; } return generation === sourceGeneration; }
          node = next; attach(next); generation = sourceGeneration;
          return true;
        },
        onLayout(event: { bounds: { size: { height: number } } }) {
          return current() && generation === sourceGeneration && !!node && layout(node, scope, contentKey, event.bounds.size.height);
        },
        retire,
      };
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
    invalidate() { ticket++; sourceGeneration++; bindingGeneration++; ref = null; context = undefined; wasActive = false; initialLayout = false; },
  };
}

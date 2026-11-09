import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';
import { validateGuiPluginPreviewIntent, type GuiPluginPreviewIntent, type GuiPluginPresentationResult } from './gui-plugin-preview';

export type ResourceGuiState = Readonly<{ preparing: boolean; matched: boolean; failed: boolean }>;
type Presentation = { present(intent: GuiPluginPreviewIntent): Promise<GuiPluginPresentationResult>; close(): Promise<void> };

/** Only the WK host's actual file registry decides matching. Capture the full
 * operation synchronously before waiting for a previous owner to close. */
export function createResourceGuiFile(input: {
  expectedHost: RuntimeScope | null; active(): boolean; capture(expectedHost: RuntimeScope): Presentation;
  changed(state: ResourceGuiState): void;
  /** Authoritative registry miss, published only after the GUI WK is retired. */
  unmatched?(): void;
}) {
  const scope = runtimeScopeFrom(input.expectedHost);
  let sequence = 0, disposed = false, lastAuto: string | undefined;
  type Operation = { id: number; bound: Presentation; closing?: Promise<void> };
  let operation: Operation | undefined;
  const retiring = new Set<Operation>();
  let retirement = Promise.resolve();
  const retire = (owner?: Operation) => {
    if (owner) retiring.add(owner);
    const closes = [...retiring].map(previous => {
      previous.closing ??= Promise.resolve().then(() => previous.bound.close()).then(() => { retiring.delete(previous); })
        .catch(cause => { previous.closing = undefined; throw cause; });
      return previous.closing;
    });
    const pending = Promise.all([retirement, ...closes]).then(() => {});
    retirement = pending.catch(() => {});
    return pending;
  };
  const publish = (preparing = false, matched = false, failed = false) => input.changed(Object.freeze({ preparing, matched, failed }));
  async function close(resetAuto = false) {
    if (resetAuto) lastAuto = undefined;
    sequence++; const previous = operation;
    try { await retire(previous); if (operation === previous) operation = undefined; publish(); }
    catch (cause) { publish(false, false, true); throw cause; }
  }
  async function open(value: GuiPluginPreviewIntent, options: { manual?: boolean; targetLine?: number } = {}) {
    if (disposed || !scope || !input.active()) return;
    if (options.targetLine !== undefined) { lastAuto = undefined; await close(); return; }
    let intent: GuiPluginPreviewIntent;
    try { intent = validateGuiPluginPreviewIntent(value); }
    catch {
      sequence++; const previous = operation; operation = undefined;
      if (!disposed && input.active()) publish(false, false, true);
      await retire(previous).catch(() => {});
      return;
    }
    const identity = JSON.stringify([intent.directory, intent.path, intent.sessionId ?? null]);
    if (!options.manual && identity === lastAuto) return;
    lastAuto = identity;
    const ticket = ++sequence, previous = operation;
    const current = () => !disposed && ticket === sequence && input.active();
    let bound: Presentation;
    try { bound = input.capture(scope); }
    catch {
      operation = undefined;
      if (current()) publish(false, false, true);
      await retire(previous).catch(() => {});
      return;
    }
    const owner = { id: ticket, bound };
    operation = owner; publish(true);
    let unmatched = false;
    try {
      await retire(previous);
      if (!current()) return;
      const result = await bound.present(intent);
      if (current()) { unmatched = result.matched === false; publish(false, result.matched === true); }
    } catch { if (current()) publish(false, false, true); }
    finally {
      try {
        await retire(owner);
        if (operation?.id === ticket) operation = undefined;
        if (current() && unmatched) input.unmatched?.();
      } catch { if (current()) publish(false, false, true); }
    }
  }
  return { open, close, dispose() { disposed = true; return close(); } };
}

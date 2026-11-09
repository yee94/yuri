import type { AssistantReadPosition } from '../ui/src/queries/assistantDTO';
import type { DesktopAssistantReadMarkerFrame, DesktopAssistantReadMarkerOperation } from './desktop-assistant-read-marker';

type List = { getScrollSnapshot(): Promise<DesktopAssistantReadMarkerFrame | null> };
type Options = {
  current(): boolean;
  list(): List | null;
  marker(): object | null;
  operation(): DesktopAssistantReadMarkerOperation | null;
  position(): AssistantReadPosition | null;
  invalidateFrame(): void;
  accept(frame: DesktopAssistantReadMarkerFrame): void;
};
const samePosition = (a: AssistantReadPosition | null, b: AssistantReadPosition) => a?.generation === b.generation && a.ordinal === b.ordinal && a.messageID === b.messageID;

/** One event-driven read of the original List. This adapter only fences native
 * snapshot replies; it never measures, scrolls, polls or decides a read watermark. */
export function createDesktopAssistantReadSnapshot(options: Options) {
  let alive = true, revision = 0, requested = false;
  let flight: Promise<void> | null = null;
  async function run() {
    try {
      while (alive && requested) {
        requested = false;
        const serial = revision, list = options.list(), marker = options.marker(), operation = options.operation(), value = options.position();
        if (!options.current() || !list || !marker || !operation?.current() || !value) continue;
        const position = { ...value };
        let snapshot: DesktopAssistantReadMarkerFrame | null;
        try { snapshot = await list.getScrollSnapshot(); } catch { snapshot = null; }
        if (!snapshot || !alive || serial !== revision || !options.current() || !operation.current()
          || options.list() !== list || options.marker() !== marker || options.operation() !== operation || !samePosition(options.position(), position)) continue;
        options.accept(snapshot);
      }
    } finally { flight = null; }
  }
  return {
    request(): Promise<void> {
      if (!alive) return Promise.resolve();
      revision++; requested = true; options.invalidateFrame();
      if (flight) return flight;
      const pending = Promise.resolve().then(run);
      flight = pending;
      return pending;
    },
    scroll(frame: DesktopAssistantReadMarkerFrame) {
      if (!alive) return;
      revision++; requested = false;
      options.accept(frame);
    },
    dispose() { alive = false; revision++; requested = false; options.invalidateFrame(); },
  };
}

export type ProjectsOrderGeometry = Map<string, { measure(): Promise<{ pagePosition: { y: number }; bounds: { size: { height: number } } } | null> }>;

/** One geometry read per row at grant; move frames never read layout or write order. */
export function createProjectsOrderGesture(options: {
  id: string;
  ids(): string[];
  geometry: ProjectsOrderGeometry;
  current(): boolean;
  generation(): number;
  offset(value: number): void;
  commit(over: string): void;
  started?(): void;
}) {
  let serial = 0;
  let gesture: { serial: number; generation: number; ids: string[]; measured: Promise<Array<{ id: string; center: number }> | null> } | undefined;
  const cancel = () => { serial++; gesture = undefined; options.offset(0); };
  return {
    cancel,
    handlers: {
      onMoveShouldSetPanResponder: (_event: unknown, g: { dx: number; dy: number }) => options.current() && Math.abs(g.dy) > 10 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderGrant: () => {
        cancel();
        if (!options.current()) return;
        const ids = options.ids();
        if (!ids.includes(options.id)) return;
        const measured = Promise.all(ids.map(async id => {
          const frame = await options.geometry.get(id)?.measure();
          if (!frame || !Number.isFinite(frame.pagePosition.y) || !Number.isFinite(frame.bounds.size.height) || frame.bounds.size.height <= 0) throw new Error('Unmeasured order row');
          return { id, center: frame.pagePosition.y + frame.bounds.size.height / 2 };
        })).catch(() => null);
        gesture = { serial, generation: options.generation(), ids, measured };
        options.started?.();
      },
      onPanResponderMove: (_event: unknown, g: { dy: number }) => {
        if (gesture && options.current() && gesture.generation === options.generation()) options.offset(g.dy);
        else cancel();
      },
      onPanResponderRelease: (_event: unknown, g: { dy: number }) => {
        const released = gesture; gesture = undefined; options.offset(0);
        if (!released || !Number.isFinite(g.dy)) return;
        void released.measured.then(frames => {
          if (!frames || released.serial !== serial || !options.current() || released.generation !== options.generation()) return;
          const ids = options.ids();
          if (ids.length !== released.ids.length || ids.some((id, i) => id !== released.ids[i])) return;
          const origin = frames.find(frame => frame.id === options.id);
          if (!origin) return;
          const center = origin.center + g.dy;
          let over = origin;
          for (const frame of frames) if (Math.abs(frame.center - center) < Math.abs(over.center - center)) over = frame;
          if (over.id !== options.id) options.commit(over.id);
        });
      },
      onPanResponderTerminate: cancel,
    },
  };
}

export type ProjectsOrderGeometry = Map<string, { measure(): Promise<{ pagePosition: { y: number }; bounds: { size: { height: number } } } | null> }>;
export type ProjectsOrderGesturePhase = 'start' | 'claim' | 'grant' | 'move' | 'activate' | 'release' | 'terminate' | 'cancel' | 'measured' | 'unmeasured' | 'drop' | 'stale';
type Touch = { identifier: number; pageX: number; pageY: number; touches: readonly { identifier: number }[] };

/** One geometry read per row at touch down; move frames never read layout or write order. */
export function createProjectsOrderGesture(options: {
  id: string;
  ids(): string[];
  geometry: ProjectsOrderGeometry;
  current(): boolean;
  generation(): number;
  offset(value: number): void;
  horizontal?(value: number): void;
  claim(): (() => void) | null;
  commit(over: string): void;
  started?(): void;
  audit?(phase: ProjectsOrderGesturePhase): void;
}) {
  let serial = 0, disposed = false;
  type Gesture = { serial: number; generation: number; ids: string[]; finger: number; x: number; y: number; granted: boolean; activated: boolean; release(): void; measured: Promise<Array<{ id: string; center: number }> | null> };
  let gesture: Gesture | undefined, settling: Gesture | undefined;
  const reset = () => { gesture?.release(); gesture = undefined; options.offset(0); options.horizontal?.(0); };
  const cancel = () => { serial++; if (gesture || settling) options.audit?.('cancel'); settling = undefined; reset(); };
  const valid = (value: Gesture) => !disposed && value.serial === serial && options.current() && value.generation === options.generation();
  const member = (value: Gesture) => { const ids = options.ids(); return ids.length === value.ids.length && ids.every((id, i) => id === value.ids[i]); };
  function start(event: Touch) {
    cancel(); options.audit?.('start');
    if (disposed || !options.current() || event.touches.length !== 1 || ![event.pageX, event.pageY].every(Number.isFinite)) return;
    const ids = [...options.ids()];
    if (ids.length < 2 || !ids.includes(options.id)) return;
    const release = options.claim();
    if (!release) return;
    options.audit?.('claim');
    const measured = Promise.all(ids.map(async id => {
      const frame = await options.geometry.get(id)?.measure();
      if (!frame || !Number.isFinite(frame.pagePosition.y) || !Number.isFinite(frame.bounds.size.height) || frame.bounds.size.height <= 0) throw new Error('Unmeasured order row');
      return { id, center: frame.pagePosition.y + frame.bounds.size.height / 2 };
    })).catch(() => null);
    const value: Gesture = { serial, generation: options.generation(), ids, finger: event.identifier, x: event.pageX, y: event.pageY, granted: false, activated: false, release, measured };
    gesture = value;
    void measured.then(frames => { if (valid(value)) options.audit?.(frames ? 'measured' : 'unmeasured'); });
  }
  function move(event: Touch) {
    const value = gesture;
    if (!value) return;
    if (!valid(value) || event.touches.length !== 1 || event.identifier !== value.finger || ![event.pageX, event.pageY].every(Number.isFinite)) { cancel(); return; }
    options.audit?.('move');
    const dx = event.pageX - value.x, dy = event.pageY - value.y;
    if (!value.activated && Math.hypot(dx, dy) > 8) { value.activated = true; options.started?.(); options.audit?.('activate'); }
    if (value.activated) { options.offset(dy); options.horizontal?.(dx); }
  }
  function finish(event: Touch) {
    const value = gesture;
    if (!value) return;
    if (event.identifier !== value.finger || event.touches.length !== 0 || !Number.isFinite(event.pageY)) { cancel(); return; }
    options.audit?.('release');
    const dy = event.pageY - value.y;
    reset();
    if (!value.granted || !value.activated) return;
    settling = value;
    void value.measured.then(frames => {
      if (settling === value) settling = undefined;
      if (!frames || !valid(value) || !member(value)) { options.audit?.('stale'); return; }
      const origin = frames.find(frame => frame.id === options.id);
      if (!origin) return;
      const center = origin.center + dy;
      let over = origin;
      for (const frame of frames) if (Math.abs(frame.center - center) < Math.abs(over.center - center)) over = frame;
      if (over.id !== options.id) { options.audit?.('drop'); options.commit(over.id); }
    });
  }
  return {
    cancel,
    reconcile() { const value = gesture ?? settling; if (value && (!valid(value) || !member(value))) cancel(); },
    dispose() { disposed = true; cancel(); },
    handlers: {
      onTouchStartCapture: start,
      onTouchMoveCapture: move,
      onTouchEndCapture: finish,
      onTouchCancelCapture: cancel,
      onStartShouldSetResponder: () => !!gesture && valid(gesture),
      onMoveShouldSetResponderCapture: () => !!gesture && valid(gesture),
      onResponderGrant: () => { if (!gesture || !valid(gesture)) return false; gesture.granted = true; options.audit?.('grant'); return true; },
      onResponderMove: move,
      onResponderRelease: finish,
      onResponderTerminationRequest: () => !gesture || !valid(gesture),
      onResponderTerminate: () => { options.audit?.('terminate'); cancel(); },
    },
  };
}

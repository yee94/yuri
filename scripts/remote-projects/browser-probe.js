// Inject before navigation scripts, into an isolated TEST profile only.
// Does not save text, clipboard contents, tokens, or paths.
(() => {
  if (window.remoteProjectsPerformance) throw new Error('Probe already installed');
  const samples = [];
  const longTasks = [];
  const eventStarts = new WeakMap();
  let scenario = 'unset';
  let selector = 'textarea';
  let observer;
  const supported = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
  if (supported) {
    observer = new PerformanceObserver(list => {
      for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration });
    });
    observer.observe({ type: 'longtask', buffered: true });
  }
  const start = e => {
    if (!(e.target instanceof Element) || !e.target.matches(selector)) return;
    const entry = { start: performance.now(), scenario, event: e.type,
      inputType: e.inputType ?? null, composing: Boolean(e.isComposing), trusted: e.isTrusted,
      synchronousDispatchMs: null, nextAnimationFrameMs: null };
    eventStarts.set(e, entry);
    samples.push(entry);
    requestAnimationFrame(() => { entry.nextAnimationFrameMs = performance.now() - entry.start; });
  };
  const finish = e => {
    const entry = eventStarts.get(e);
    if (!entry) return;
    entry.synchronousDispatchMs = performance.now() - entry.start;
    // rAF precedes paint: nextAnimationFrameMs is NOT actual paint.
  };
  for (const kind of ['keydown', 'beforeinput', 'input', 'paste', 'compositionupdate', 'compositionend']) {
    window.addEventListener(kind, start, true);
    window.addEventListener(kind, finish);
  }
  window.remoteProjectsPerformance = {
    scenario(name, targetSelector = 'textarea') { scenario = name; selector = targetSelector; },
    reset() { samples.length = 0; longTasks.length = 0; },
    snapshot() {
      return { schemaVersion: 1, timeOrigin: performance.timeOrigin,
        observer: { longtask: supported }, samples: structuredClone(samples), longTasks: structuredClone(longTasks),
        limitations: ['Dispatch timing excludes post-event microtasks/React deferred commits.',
          'nextAnimationFrameMs is not input-to-paint; collect a rendering trace separately.',
          'Overlapping long tasks are correlation, not proof of input attribution.',
          'Synthetic composition events do not validate a platform IME.',
          'Null dispatch duration means propagation never reached window bubble; do not discard these events.',
          'Native iOS UITextView requires native instrumentation; DOM samples cannot replace it.'] };
    },
    dispose() {
      observer?.disconnect();
      for (const kind of ['keydown', 'beforeinput', 'input', 'paste', 'compositionupdate', 'compositionend']) {
        window.removeEventListener(kind, start, true); window.removeEventListener(kind, finish);
      }
    },
  };
})();

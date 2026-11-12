const deadlines = new FinalizationRegistry((timer) => clearTimeout(timer));
// Keep the timer callback's closure separate from the returned signal and its owner.
const expire = (reference) => () => reference.deref()?.controller.abort(
  new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
);

export const remoteDeadlineSignal = (milliseconds, parents = []) => {
  const controller = new AbortController();
  const signal = AbortSignal.any([...parents, controller.signal]);
  if (signal.aborted) return signal;
  const owner = { controller };
  const timer = setTimeout(expire(new WeakRef(owner)), milliseconds);
  timer.unref?.();
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    deadlines.unregister(owner);
  }, { once: true });
  // Like AbortSignal.timeout, an abandoned signal must not be retained by its timer.
  // Unlike a standalone timeout, parent cancellation also disposes the deadline now.
  deadlines.register(signal, timer, owner);
  return signal;
};

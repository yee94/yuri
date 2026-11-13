export const CONTACT_TOOL_TIMEOUT_MS = 300_000;

/** One limiter per contact turn, shared by direct, deferred and result-phase tools. */
export function createContactToolLimiter() {
  const wrapped = new WeakMap();
  let timeoutResult = null;
  const wrap = (tool) => {
    if (wrapped.has(tool)) return wrapped.get(tool);
    const limited = {
      ...tool,
      execute: async (callID, params, parentSignal, onUpdate) => {
        parentSignal?.throwIfAborted();
        if (timeoutResult) return timeoutResult;
        const controller = new AbortController();
        const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
        const error = Object.assign(new Error(`${tool.name} timed out after 300 seconds.`), { code: 'tool_timeout' });
        let onAbort;
        const timer = setTimeout(() => {
          timeoutResult = {
            content: [{ type: 'text', text: `${error.message} Cancellation was requested. The operation outcome is unknown; do not claim success or automatically retry. Check authoritative state before any later retry.` }],
            details: { error: 'tool_timeout', tool: tool.name, timeoutMs: CONTACT_TOOL_TIMEOUT_MS },
            isError: true,
            terminate: true,
          };
          controller.abort(error);
        }, CONTACT_TOOL_TIMEOUT_MS);
        try {
          return await new Promise((resolve, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) { onAbort(); return; }
            Promise.resolve().then(() => {
              signal.throwIfAborted();
              return tool.execute(callID, params, signal, onUpdate ? (...args) => {
                if (!signal.aborted) onUpdate(...args);
              } : undefined);
            }).then(resolve, reject);
          });
        } catch (caught) {
          parentSignal?.throwIfAborted();
          if (controller.signal.aborted) return timeoutResult;
          throw caught;
        } finally {
          clearTimeout(timer);
          if (onAbort) signal.removeEventListener('abort', onAbort);
        }
      },
    };
    wrapped.set(tool, limited);
    return limited;
  };
  return { wrap, get timedOut() { return timeoutResult !== null; } };
}

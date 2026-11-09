/** Presentation owns dismissal and retry admission; it never changes a failed domain's authority. */
export type ErrorFeedback = Readonly<{ id: number; message: string; visible: boolean; busy: boolean; current: () => boolean; retry?: () => Promise<unknown> }>;
export function feedbackErrorKey(error: unknown) {
  const fields = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; message?: unknown } : {};
  if (fields.code === 'ERR_ACCESS_DENIED' || typeof fields.message === 'string' && fields.message.startsWith('nsh/host:') && fields.message.includes('not granted')) return 'native.feedback.permission';
  if (fields.status === 401 || fields.status === 403) return 'native.feedback.authorization';
  if (fields.code === 'ETIMEDOUT' || fields.code === 'ECONNREFUSED' || fields.code === 'ERR_NETWORK' || typeof fields.status === 'number' && fields.status >= 502 && fields.status <= 504) return 'native.feedback.connection';
  return 'native.feedback.operation';
}
export function createErrorFeedback(input: { read: () => ErrorFeedback | null; write: (value: ErrorFeedback | null) => void }) {
  let serial = 0;
  const publish = (message: string, current: () => boolean, retry?: () => Promise<unknown>) => {
    if (!current()) return;
    input.write({ id: ++serial, message, visible: true, busy: false, current, ...(retry ? { retry } : {}) });
  };
  return {
    publish,
    resolve(id: number) { if (input.read()?.id === id) input.write(null); },
    dismiss(id: number) { const value = input.read(); if (value?.id === id) input.write({ ...value, visible: false }); },
    retire() { serial++; input.write(null); },
    async retry(id: number) {
      const value = input.read();
      if (!value || value.id !== id || value.busy || !value.retry || !value.current()) return;
      input.write({ ...value, busy: true });
      try {
        await value.retry();
        if (input.read()?.id === id && value.current()) input.write(null);
      } catch {
        // The captured action may contain a write with an unknown outcome. Only
        // explicitly supplied owner recovery callbacks can reach this branch.
        const latest = input.read();
        if (latest?.id === id && value.current()) input.write({ ...latest, busy: false });
      }
    },
  };
}

export function feedbackGeometry(size: { height: number; width: number }, insets: { top: number; bottom: number; left: number; right: number }) {
  const width = Math.min(560, Math.max(0, size.width - 2 * (Math.max(insets.left, insets.right) + 16)));
  const inset = (size.width - width) / 2;
  return { top: insets.top + 16, left: inset, right: inset, maxHeight: Math.max(0, size.height - insets.top - insets.bottom - 32) * .6 };
}

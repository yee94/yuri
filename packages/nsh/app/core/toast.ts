import { signal } from 'nsh';

/** One transient message; `action` is the Undo of the Web toast (`sessionMutationUndo`). */
export type Toast = {
  id: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Web's second toast action (`View archived sessions`). */
  secondaryLabel?: string;
  onSecondary?: () => void;
};

const DEFAULT_TIMEOUT = 5000; // Web `SESSION_DELETE_UNDO_MS`

const items = signal<Toast[]>([]);
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let serial = 0;

export const toasts = () => items();

function drop(id: string) {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  items.set(items().filter((toast) => toast.id !== id));
}

/** Shows one toast; `timeout` 0 keeps it until its action or dismissal. */
export function showToast(input: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  timeout?: number;
}): string {
  const id = `toast-${Date.now().toString(36)}-${(serial += 1)}`;
  items.set([
    ...items(),
    {
      id,
      message: input.message,
      actionLabel: input.actionLabel,
      onAction: input.onAction,
      secondaryLabel: input.secondaryLabel,
      onSecondary: input.onSecondary,
    },
  ]);
  const timeout = input.timeout ?? DEFAULT_TIMEOUT;
  if (timeout > 0) timers.set(id, setTimeout(() => drop(id), timeout));
  return id;
}

export function dismissToast(id: string) {
  drop(id);
}

export function dismissAllToasts() {
  for (const id of [...timers.keys()]) drop(id);
  items.set([]);
}

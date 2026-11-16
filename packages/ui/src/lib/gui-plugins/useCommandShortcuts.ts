import { useContext, useMemo, useSyncExternalStore } from 'react';
import { GuiPluginHostContext } from './react';
import type { GuiCommandShortcut } from './command-shortcuts';

const empty: readonly GuiCommandShortcut[] = Object.freeze([]);
const emptySnapshot = () => empty;
const noopSubscribe = () => () => {};

/** Command metadata changes independently of session/panel snapshot updates. */
export function useCommandShortcuts() {
  const host = useContext(GuiPluginHostContext);
  const subscribe = useMemo(() => host ? (notify: () => void) => host.subscribe(notify) : noopSubscribe, [host]);
  const snapshot = useMemo(() => host ? () => host.getCommandShortcuts() : emptySnapshot, [host]);
  return useSyncExternalStore(subscribe, snapshot, emptySnapshot);
}

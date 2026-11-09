import { cleanup, lifecycle, signal, Storage, Text, untracked, View } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import type { NativeDesktopPanelTabsOwner } from './desktop-panel';
import { createDesktopPanelTabsPersistence, type DesktopPanelMetadataStorage } from './desktop-panel-tabs-persistence';

/** Bind once beside the existing window tabs owner, NOT inside the strip's mount.
 * Uses public NSH Storage for metadata only; never supplies journal durability or
 * changes the editor/file-operation storage. All model changes share this one lane. */
export function createNativeDesktopPanelTabsPersistence(tabs: NativeDesktopPanelTabsOwner, options: { storage?: DesktopPanelMetadataStorage } = {}) {
  const revision = signal(0);
  let alive = true;
  const persistence = createDesktopPanelTabsPersistence(tabs, options.storage ?? Storage, () => untracked(() => revision.set(revision() + 1)));
  const state = () => { revision(); return persistence.state(); };
  const restore = async () => {
    try { await tabs.editors.journal?.ready; } catch { return false; }
    return alive && persistence.restore();
  };
  const ready = restore();
  const dispose = () => { alive = false; persistence.dispose(); };
  cleanup(dispose);
  return { state, ready, restore, flush: persistence.flush, retry: () => state().hydrated ? persistence.retry() : restore(), dispose };
}
export type NativeDesktopPanelTabsPersistence = ReturnType<typeof createNativeDesktopPanelTabsPersistence>;

/** Workbench-content feedback, never another titlebar/toolbar. A failed metadata
 * write leaves the same live tabs usable; retry never calls open/close or a Host API. */
export function DesktopPanelTabsMetadataFeedback(props: {
  metadata: Pick<NativeDesktopPanelTabsPersistence, 'state' | 'retry'>;
  current: () => boolean; active: boolean;
}) {
  const retrying = signal(false);
  const state = props.metadata.state;
  const current = () => props.active && props.current() && lifecycle() === 'active';
  const retryable = () => !!state().error && state().error !== 'conflict' && state().error !== 'rollback';
  const enabled = () => current() && retryable() && !retrying() && !state().reading && !state().writing;
  async function retry() {
    if (!enabled()) return;
    retrying.set(true);
    try { if (current()) await props.metadata.retry(); }
    finally { retrying.set(false); }
  }
  return <If when={!!state().error}><View testID="desktop-panel-tabs-metadata-error" role="alert" class="px-3 py-2 flex-row items-center gap-2 bg-card">
    <Text class="flex-1 text-xs text-destructive">{t(state().error === 'read' ? 'common.unavailable' : 'filesView.toast.saveFailed')}</Text>
    <If when={retryable()}><Button testID="desktop-panel-tabs-metadata-retry" class="min-h-8 px-3 rounded-md bg-secondary hover:bg-accent active:bg-accent disabled:opacity-40 items-center justify-center" disabled={!enabled()} onPress={() => { void retry(); }}><Text class="text-xs text-foreground">{t('diffView.actions.retry')}</Text></Button></If>
  </View></If>;
}

import { cleanup, effect, lifecycle, Scroll, signal, Storage, Text, untracked, View, type ScrollRef } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { language, t } from './i18n';
import { text, type Row } from './model';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { nativeAppearance, nativeDensity, refreshNativeAppearance, saveNativeAppearanceMode } from './appearance';
import { nativeAppearanceModeFromSettings } from './appearance-core';
import { settingsObject, settingsRows } from './settings-protocol';
import { SettingsChoice, SettingsFeedback, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { settingsPreferenceFields, settingsPreferencePatch, settingsPreferenceReadbackMatches } from './settings-preferences-core';
import { hasPreferenceChoicePresentation, SettingsPreferenceChoiceField } from './settings-preferences-fields';
import { createPreferencePreviewVisibility } from './settings-preferences-preview-visibility';
import { SettingsTarget } from './settings-target';
import { createSettingsTargetNavigation } from './settings-search-core';
import { CODE_FONT_OPTIONS, DEFAULT_MONO_FONT } from '../ui/src/lib/fontOptions';
import { themes } from '../ui/src/lib/theme/themes';
import { isValidTheme } from '../ui/src/contexts/theme-validation';
import type { Theme } from '../ui/src/types/theme';
import { deviceChatPreferences, deviceChatPreferenceStore } from './settings-preferences-device';
import { isDeviceChatPreference, type DeviceChatPreferences } from './settings-preferences-device-core';
import { app, clearHistoryCache } from './state';
import { openPreferenceReceipt, type PreferenceReceipt } from './settings-preferences-receipt';
import { deviceAppearance, deviceAppearanceError, loadDeviceAppearance, saveDeviceCodeFontSize, saveDeviceEditorFontSize, saveDeviceFileEditorKeymap } from './device-appearance';
import { deviceEditorFontSize, deviceFileEditorKeymap, type DeviceAppearance } from './device-appearance-core';
import { localCompatibilityPreferences } from './local-compatibility-preferences';
import type { IosNativeUiPreference, SidebarBrandPreference, LocalPreferenceOwner } from './local-compatibility-preferences-core';

const isDeviceFontSize = (key: string): key is 'codeFontSize' | 'editorFontSize' => key === 'codeFontSize' || key === 'editorFontSize';
const isDeviceAppearancePreference = (key: string): key is keyof DeviceAppearance => isDeviceFontSize(key) || key === 'fileEditorKeymap';
const isIndependentDevicePreference = (key: string) => isDeviceAppearancePreference(key) || key === 'iosNativeUiEnabled';

export function SettingsPreferences(props: SettingsCallbacks & SettingsRoute & { active?: boolean; clearHistoryCache?: () => Promise<void> }) {
  const state = settingsPageLifetime(() => props.active !== false && lifecycle() === 'active'), settings = signal<Row>({}), changes = signal<Row>({});
  type Receipt = PreferenceReceipt;
  // This is the page's mirror of the authorized durable receipt owner, never
  // the replaceable operation lane. No GET can certify an unknown PUT.
  const pending = signal<Receipt | null>(null), pendingUnsent = signal(false), confirming = signal(false);
  const edits: Record<string, number> = {};
  let editRevision = 0;
  const cacheBusy = signal(false), cacheConfirming = signal(false), cacheError = signal(false), cacheCleared = signal(false);
  const codeReadBusy = signal(false), codeSaveBusy = signal(false), codeReadFailed = signal(false);
  const preferenceSaveBusy = signal(false), localSaveError = signal('');
  let savingOperation: { operation: SettingsOperation } | null = null;
  const deviceSaveFailed = signal<Partial<Record<string, boolean>>>({}), deviceSaved = signal<Partial<Record<string, boolean>>>({});
  let pageAlive = true;
  const brandTransportID = app.connection()?.transportID ?? null;
  const brandPreference = signal<SidebarBrandPreference | null>(null), brandReadBusy = signal(false), brandReadFailed = signal(false);
  let brandOwner: LocalPreferenceOwner<SidebarBrandPreference> | null = null;
  async function reloadBrandPreference() {
    const owner = brandOwner;
    if (!owner || brandReadBusy() || !state.current()) return;
    brandReadBusy.set(true); brandReadFailed.set(false);
    try { await owner.load(); }
    catch { if (brandOwner === owner && state.current()) brandReadFailed.set(true); }
    finally { if (brandOwner === owner) brandReadBusy.set(false); }
  }
  effect(() => {
    const operation = state.operation(), active = props.active !== false && lifecycle() === 'active', transportID = app.connection()?.transportID;
    untracked(() => {
      brandOwner?.dispose(); brandOwner = null; brandPreference.set(null); brandReadBusy.set(false); brandReadFailed.set(false);
      deviceSaved.set({ ...deviceSaved(), sidebarBrandName: false });
      if (props.page !== 'appearance' || !active || !operation?.current() || !operation.scope || !brandTransportID || transportID !== brandTransportID) return;
      brandOwner = localCompatibilityPreferences.openSidebarBrand({ transportID: brandTransportID, expectedHost: operation.scope, current: () => pageAlive && operation.current(), currentHost: app.runtimeScope, currentTransportID: () => app.connection()?.transportID ?? null }, value => brandPreference.set(value));
      void reloadBrandPreference();
    });
  });
  cleanup(() => { brandOwner?.dispose(); brandOwner = null; });
  const iosPreference = signal<IosNativeUiPreference | null>(null), iosReadBusy = signal(false), iosReadFailed = signal(false);
  let iosOwner: LocalPreferenceOwner<IosNativeUiPreference> | null = null;
  async function reloadIosPreference() {
    const owner = iosOwner;
    if (!owner || iosReadBusy() || !state.current()) return;
    iosReadBusy.set(true); iosReadFailed.set(false);
    try { await owner.load(); }
    catch { if (iosOwner === owner && state.current()) iosReadFailed.set(true); }
    finally { if (iosOwner === owner) iosReadBusy.set(false); }
  }
  effect(() => {
    const operation = state.operation(), active = props.active !== false && lifecycle() === 'active';
    untracked(() => {
      iosOwner?.dispose(); iosOwner = null; iosPreference.set(null); iosReadBusy.set(false); iosReadFailed.set(false);
      if (props.page !== 'appearance' || !active || !operation?.current()) return;
      iosOwner = localCompatibilityPreferences.openIosNativeUi({ current: () => pageAlive && operation.current(), changed: value => iosPreference.set(value) });
      void reloadIosPreference();
    });
  });
  cleanup(() => { iosOwner?.dispose(); iosOwner = null; });
  const connection = app.connection();
  let journal = connection?.authorizationID ? openPreferenceReceipt(connection.id, connection.authorizationID) : null;
  const receiptReady = signal(!journal);
  cleanup(() => { pageAlive = false; void journal?.close().catch(() => {}); });
  async function restoreReceipt(retry = false) {
    // A retained navigation page can become active again after another settings
    // page owned this same partition. Reacquire explicitly, never through an old
    // asynchronous continuation or a mutable request proxy.
    if (journal && !journal.current() && connection?.authorizationID) {
      const previous = journal;
      journal = openPreferenceReceipt(connection.id, connection.authorizationID);
      receiptReady.set(false); void previous.close().catch(() => {});
    }
    if (!journal || receiptReady()) return;
    const captured = journal;
    try { if (retry) await captured.retry(); else await captured.ready; }
    catch { throw new Error(t('settings.voice.volcengine.saveFailed')); }
    if (!pageAlive || journal !== captured || !captured.current()) return;
    const saved = captured.value();
    pending.set(saved); pendingUnsent.set(false); editRevision = Math.max(editRevision, saved?.revision ?? 0);
    for (const key of Object.keys(changes())) edits[key] = ++editRevision;
    const restored = { ...changes() };
    for (const [key, value] of Object.entries(saved?.submitted ?? {})) {
      if (key in restored) continue;
      restored[key] = value; edits[key] = saved!.edits[key]!;
    }
    changes.set(restored);
    receiptReady.set(true);
  }

  let scroll!: ScrollRef;
  const navigation = createSettingsTargetNavigation(() => scroll, state.current, () => state.operation()?.current ?? (() => false));
  const customThemes = signal<Theme[]>([]), themeError = signal(''), themeBusy = signal(false);
  const fields = settingsPreferenceFields.filter(field => field.page === props.page);
  const initial = (key: string) => key === 'sidebarBrandName' ? brandPreference()?.sidebarBrandName : key === 'iosNativeUiEnabled' ? iosPreference()?.iosNativeUiEnabled : isDeviceAppearancePreference(key) ? deviceAppearance()?.[key] : isDeviceChatPreference(key) ? deviceChatPreferences()?.[key] : settings()[key] ?? settingsPreferenceFields.find(field => field.key === key)?.initial;
  const value = (key: string) => key in changes() ? changes()[key] : initial(key);
  const disabled = () => state.busy() || preferenceSaveBusy() || confirming() || cacheBusy() || cacheConfirming() || !receiptReady() || !state.ready();
  const deviceDisabled = () => !state.current() || props.active === false || lifecycle() !== 'active' || confirming() || cacheBusy() || cacheConfirming() || preferenceSaveBusy() && savingOperation?.operation === state.operation();
  const fieldDisabled = (key: string) => isIndependentDevicePreference(key) ? deviceDisabled() : disabled();
  const hasIndependentDraft = () => Object.keys(changes()).some(isIndependentDevicePreference);
  const cacheDisabled = () => state.busy() || confirming() || cacheBusy() || cacheConfirming();
  async function reloadDeviceCodeFontSize() {
    if (!pageAlive || props.active === false || !state.current() || codeReadBusy() || codeSaveBusy()) return;
    codeReadBusy.set(true); codeReadFailed.set(false);
    try { await loadDeviceAppearance(); }
    catch { if (pageAlive) codeReadFailed.set(true); }
    finally { if (pageAlive) codeReadBusy.set(false); }
  }
  async function requestCacheClear() {
    if (!pageAlive || cacheBusy() || cacheConfirming() || state.busy() || confirming()) return;
    const clear = props.clearHistoryCache ?? clearHistoryCache;
    cacheConfirming.set(true);
    try {
      const answer = await AlertDialog.show({ title: t('settings.yuri.visual.transcriptCache.dialog.title'), description: t('settings.yuri.visual.transcriptCache.dialog.description'), actions: [
        { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
        { id: 'clear', label: t('settings.yuri.visual.transcriptCache.action'), role: 'destructive' },
      ] });
      if (!pageAlive || answer.action !== 'clear') return;
      cacheBusy.set(true); cacheError.set(false); cacheCleared.set(false);
      // This is one device-local cache operation, independent of Host leases.
      // Its durable cleanup journal and retry belong to the singleton cache.
      await clear();
      if (pageAlive) cacheCleared.set(true);
    } catch { if (pageAlive) cacheError.set(true); }
    finally { if (pageAlive) { cacheBusy.set(false); cacheConfirming.set(false); } }
  }
  function update(key: string, next: unknown) {
    if (fieldDisabled(key)) return;
    if (key === 'iosNativeUiEnabled') {
      if (!iosPreference() || iosReadBusy() || !state.current()) return;
      deviceSaved.set({ ...deviceSaved(), [key]: false });
    }
    if (key === 'sidebarBrandName') {
      if (!brandOwner?.snapshot() || brandReadBusy() || !state.current()) return;
      deviceSaved.set({ ...deviceSaved(), [key]: false });
    }
    if (isDeviceAppearancePreference(key)) {
      if (props.active === false || !state.current() || !deviceAppearance() || codeReadBusy()) return;
      deviceSaved.set({ ...deviceSaved(), [key]: false });
    }
    edits[key] = ++editRevision;
    const retained = { ...changes() };
    if (next === initial(key) && !(key in (pending()?.patch ?? {}))) delete retained[key]; else retained[key] = next;
    changes.set(retained);
  }
  async function back(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current() || state.busy() || confirming() || cacheBusy() || cacheConfirming() || codeSaveBusy() || preferenceSaveBusy()) return;
    confirming.set(true);
    try {
      await restoreReceipt();
      let receipt = pending();
      if (receipt) {
        const captured = journal;
        if (!captured) throw new Error('preference-receipt-authorization-required');
        // Leaving is not discarding: transfer the original operation/revisions
        // durably before asking about unrelated unsent edits or popping.
        if (pendingUnsent()) {
          await clearUnsent(receipt, captured);
          receipt = pending();
        } else await captured.handoff(receipt);
        if (journal !== captured || !captured.current()) throw new Error('preference-receipt-retired');
      }
      if (!operation.current()) return;
      const unsent = Object.keys(changes()).some(key => !receipt || edits[key] !== receipt.edits[key]);
      if (!unsent) { props.onBack(); return; }
      const answer = await AlertDialog.show({ title: t('filesView.unsaved.title'), description: t('sessions.scheduledTasks.workspace.confirm.discardChanges'), actions: [
        { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
        { id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' },
      ] });
      if (operation.current() && answer.action === 'discard') props.onBack();
    } catch { if (operation.current()) state.error.set(t('settings.voice.volcengine.saveFailed')); }
    finally { if (pageAlive) confirming.set(false); }
  }
  effect(() => {
    const blocked = state.busy() || confirming() || cacheBusy() || cacheConfirming() || codeSaveBusy() || preferenceSaveBusy() || !receiptReady() || !!pending() || Object.keys(changes()).length > 0;
    untracked(() => props.onCollectionNavigation?.({ blocked, back: () => { void back(); } }));
  });
  async function refreshCommitted(operation: SettingsOperation, snapshot?: Row) {
    const receipt = pending(), captured = journal;
    if (receipt && pendingUnsent()) {
      if (!captured) throw new Error(t('settings.voice.volcengine.saveFailed'));
      await clearUnsent(receipt, captured); return;
    }
    const confirmed = snapshot ?? settingsObject(await operation.request('/api/config/settings'));
    if (!operation.current()) return;
    if (receipt?.acknowledged && !settingsPreferenceReadbackMatches(receipt.patch, confirmed)) throw new Error(t('settings.preferences.native.notApplied'));
    settings.set(confirmed); state.ready.set(true);
    await refreshNativeAppearance(receipt?.acknowledged ? () => operation.current() && pending() === receipt && journal === captured && captured?.current() === true : undefined);
    if (!operation.current()) return;
    // Appearance reports failures through its signal as well as rejected calls.
    if (nativeAppearance.error()) throw new Error(t('chat.chatInput.toast.reloadFailed'));
    if (receipt && !receipt.acknowledged) throw new Error(t('settings.github.native.unknown'));
    if (pending() !== receipt) return;
    if (receipt) {
      if (!captured?.current() || journal !== captured) throw new Error(t('settings.voice.volcengine.saveFailed'));
      if (captured.value()) {
        await captured.confirm(receipt);
        if (!operation.current() || journal !== captured || !captured.current()) return;
        await captured.clear(receipt);
        if (!operation.current() || journal !== captured || !captured.current()) return;
      }
    }
    if (receipt) clearSubmitted(receipt);
    pending.set(null);
    state.notice.set(t('filesView.editor.saved'));
  }
  async function retryRefresh() {
    await state.perform(async operation => { await restoreReceipt(true); await refreshCommitted(operation); });
  }
  async function clearUnsent(receipt: Receipt, captured: NonNullable<typeof journal>) {
    if (journal !== captured || !pendingUnsent()) throw new Error(t('settings.voice.volcengine.saveFailed'));
    try { await captured.cancelUnsent(receipt); }
    catch { throw new Error(t('settings.voice.volcengine.saveFailed')); }
    if (!pageAlive || journal !== captured || !captured.current() || pending() !== receipt) return;
    // Durable cleanup succeeded for this owner-proven unsent attempt. Keep all
    // submitted/newer edits; the next explicit Save may create a new operation.
    pending.set(null); pendingUnsent.set(false); state.error.set(''); state.notice.set('');
  }
  function clearSubmitted(receipt: Receipt) {
    const retained = { ...changes() };
    for (const key of Object.keys(receipt.submitted)) if (edits[key] === receipt.edits[key]) delete retained[key];
    changes.set(retained);
  }
  async function dispatchPreferences(operation: SettingsOperation, patch: Row, submitted: Row = {}): Promise<Row> {
    if (pending()) throw new Error(t('settings.github.native.unknown'));
    const captured = journal;
    if (!captured?.current()) throw new Error(t('common.unavailable'));
    const receipt: Receipt = { acknowledged: false, patch: { ...patch }, submitted: { ...submitted }, edits: Object.fromEntries(Object.keys(submitted).map(key => [key, edits[key]])), revision: editRevision };
    // Register before dispatch; a lease change may hide even a successful ACK.
    pending.set(receipt); pendingUnsent.set(true);
    try { await captured.prepare(receipt); }
    catch { throw new Error(t('settings.voice.volcengine.saveFailed')); }
    if (!operation.current() || !pageAlive || journal !== captured || !captured.current()) return {};
    captured.enterPut(receipt); pendingUnsent.set(false);
    let response: Row;
    try { response = await operation.transaction('/api/config/settings', 'PUT', patch); }
    // The route has no durable operation receipt or atomic reject contract.
    // Even an error may follow a committed persist, so retain the unknown.
    catch { throw new Error(t('settings.github.native.unknown')); }
    if (!operation.current() || pending() !== receipt || journal !== captured || !captured.current()) return response;
    receipt.acknowledged = true;
    pending.set({ ...receipt });
    await captured.confirm(receipt);
    return response;
  }
  async function writePreferences(operation: SettingsOperation, patch: Row, submitted: Row = {}) {
    if (pending()) { await refreshCommitted(operation); return; }
    await dispatchPreferences(operation, patch, submitted);
    if (!operation.current()) return;
    await refreshCommitted(operation);
  }
  async function loadThemes(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (themeBusy() || !operation.current()) return;
    themeBusy.set(true); themeError.set('');
    try {
      const result = settingsObject(await operation.request('/api/config/themes'));
      const rows: unknown[] = settingsRows(result.themes);
      const valid = rows.filter(isValidTheme);
      if (valid.length !== rows.length) throw new Error('Invalid theme catalog');
      if (operation.current()) customThemes.set(valid);
    } catch { if (operation.current()) themeError.set(t('common.unavailable')); }
    finally { if (operation.current()) themeBusy.set(false); }
  }
  async function load(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    // Delegate cold reads to the existing singleton. The appearance root still
    // owns projection into native consumers; no second device store is created.
    if (props.page === 'appearance' && !deviceAppearance() && !deviceAppearanceError()) void reloadDeviceCodeFontSize();
    await state.perform(async (operation) => {
      if (props.page === 'chat') await deviceChatPreferenceStore.load();
      const result = settingsObject(await operation.request('/api/config/settings'));
      if (!operation.current()) return;
      settings.set(result); state.ready.set(true);
      await restoreReceipt();
      if (pending()) await refreshCommitted(operation, result);
    }, operation);
    if (props.page === 'appearance' && state.ready()) await loadThemes(operation);
  }
  effect(() => { const operation = state.operation(), active = props.active !== false && lifecycle() === 'active'; untracked(() => { if (active && operation?.current()) void load(operation); }); });
  state.observeOperation(() => { themeBusy.set(false); confirming.set(false); });
  async function save(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current() || preferenceSaveBusy() || codeSaveBusy()) return;
    const hostAdmitted = !disabled();
    if (!hostAdmitted && (deviceDisabled() || !hasIndependentDraft())) return;
    const capturedSave = { operation };
    savingOperation = capturedSave; preferenceSaveBusy.set(true); localSaveError.set('');
    const work = async (operation: SettingsOperation) => {
      if (!operation.current()) return;
      let patch: Row;
      const deviceValues: Partial<DeviceAppearance> = {};
      const snapshot = Object.fromEntries(Object.entries(changes()).filter(([key]) => hostAdmitted || isIndependentDevicePreference(key))), submittedEdits = { ...edits };
      const local = Object.fromEntries(Object.entries(snapshot).filter(([key]) => isDeviceChatPreference(key))) as Partial<DeviceChatPreferences>;
      try {
        if ('codeFontSize' in snapshot) {
          const raw = snapshot.codeFontSize;
          if (!deviceAppearance() || typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) throw new Error('codeFontSize');
          const codeSize = Number(raw);
          if (!Number.isInteger(codeSize) || codeSize < 50 || codeSize > 200) throw new Error('codeFontSize');
          deviceValues.codeFontSize = codeSize;
        }
        if ('editorFontSize' in snapshot) {
          const raw = snapshot.editorFontSize;
          if (!deviceAppearance() || typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim()) || !Number.isFinite(Number(raw))) throw new Error('editorFontSize');
          deviceValues.editorFontSize = deviceEditorFontSize(Number(raw));
        }
        if ('fileEditorKeymap' in snapshot) {
          if (!deviceAppearance() || snapshot.fileEditorKeymap !== 'default' && snapshot.fileEditorKeymap !== 'vim') throw new Error('fileEditorKeymap');
          deviceValues.fileEditorKeymap = deviceFileEditorKeymap(snapshot.fileEditorKeymap);
        }
        // A pending Host operation admits only its recovery lane. Device-local
        // edits remain independently saveable, never part of its receipt/PUT.
        if ('iosNativeUiEnabled' in snapshot && (!iosOwner?.snapshot() || typeof snapshot.iosNativeUiEnabled !== 'boolean')) throw new Error('iosNativeUiEnabled');
        if ('sidebarBrandName' in snapshot && (!brandOwner?.snapshot() || typeof snapshot.sidebarBrandName !== 'string')) throw new Error('sidebarBrandName');
        patch = !hostAdmitted || pending() ? {} : settingsPreferencePatch(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'sidebarBrandName' && key !== 'iosNativeUiEnabled' && !isDeviceChatPreference(key) && !isDeviceAppearancePreference(key))));
      }
      catch (failure) {
        const field = fields.find(item => item.key === (failure instanceof Error ? failure.message : ''));
        throw new Error(`${field ? t(field.title) : t('common.unavailable')}${field?.kind === 'number' ? `: ${field.min}–${field.max}` : ''}`);
      }
      for (const key of ['codeFontSize', 'editorFontSize', 'fileEditorKeymap'] as const) {
        if (deviceValues[key] === undefined) continue;
        codeSaveBusy.set(true); deviceSaveFailed.set({ ...deviceSaveFailed(), [key]: false }); deviceSaved.set({ ...deviceSaved(), [key]: false });
        try {
          if (key === 'fileEditorKeymap') await saveDeviceFileEditorKeymap(deviceValues[key]!);
          else await (key === 'codeFontSize' ? saveDeviceCodeFontSize : saveDeviceEditorFontSize)(deviceValues[key]!);
        }
        catch { if (pageAlive) deviceSaveFailed.set({ ...deviceSaveFailed(), [key]: true }); throw new Error(t('settings.voice.volcengine.saveFailed')); }
        finally { if (pageAlive) codeSaveBusy.set(false); }
        if (!pageAlive) return;
        codeReadFailed.set(false); deviceSaveFailed.set({ ...deviceSaveFailed(), [key]: false });
        const retained = { ...changes() };
        if (edits[key] === submittedEdits[key]) { delete retained[key]; deviceSaved.set({ ...deviceSaved(), [key]: true }); }
        changes.set(retained);
        // Device success survives a lease change; the old captured Host lane
        // must never dispatch its mixed Host patch on the renewed connection.
        if (!operation.current()) return;
      }
      if (Object.keys(local).length) {
        await deviceChatPreferenceStore.save(local);
        if (!operation.current()) return;
        const retained = { ...changes() };
        for (const key of Object.keys(local)) if (edits[key] === submittedEdits[key]) delete retained[key];
        changes.set(retained);
      }
      if ('iosNativeUiEnabled' in snapshot) {
        const owner = iosOwner;
        if (!owner || typeof snapshot.iosNativeUiEnabled !== 'boolean') throw new Error(t('settings.voice.volcengine.saveFailed'));
        try { await owner.save({ iosNativeUiEnabled: snapshot.iosNativeUiEnabled }); }
        catch { throw new Error(t('settings.voice.volcengine.saveFailed')); }
        if (!operation.current() || iosOwner !== owner) return;
        const retained = { ...changes() };
        if (edits.iosNativeUiEnabled === submittedEdits.iosNativeUiEnabled) {
          delete retained.iosNativeUiEnabled; deviceSaved.set({ ...deviceSaved(), iosNativeUiEnabled: true });
        }
        changes.set(retained);
      }
      if ('sidebarBrandName' in snapshot) {
        const owner = brandOwner;
        if (!owner || typeof snapshot.sidebarBrandName !== 'string') throw new Error(t('settings.voice.volcengine.saveFailed'));
        try { await owner.save({ sidebarBrandName: snapshot.sidebarBrandName }); }
        catch { throw new Error(t('settings.voice.volcengine.saveFailed')); }
        if (!operation.current() || brandOwner !== owner || app.connection()?.transportID !== brandTransportID) return;
        const retained = { ...changes() };
        if (edits.sidebarBrandName === submittedEdits.sidebarBrandName) {
          delete retained.sidebarBrandName; deviceSaved.set({ ...deviceSaved(), sidebarBrandName: true });
        }
        changes.set(retained);
      }
      if (!hostAdmitted) return;
      if (savingOperation === capturedSave) { preferenceSaveBusy.set(false); savingOperation = null; }
      if (pending()) { await refreshCommitted(operation); return; }
      if (!Object.keys(patch).length) { if (!Object.keys(changes()).length) state.notice.set(t('filesView.editor.saved')); return; }
      await writePreferences(operation, patch, Object.fromEntries(Object.keys(patch).map(key => [key, snapshot[key]])));
    };
    try {
      if (hostAdmitted) await state.perform(work, operation);
      else await work(operation);
    } catch (failure) {
      if (operation.current()) localSaveError.set(failure instanceof Error ? failure.message : t('settings.voice.volcengine.saveFailed'));
    } finally {
      if (savingOperation === capturedSave) {
        if (pageAlive) preferenceSaveBusy.set(false);
        savingOperation = null;
      }
    }
  }
  const themeItems = (variant: 'light' | 'dark') => [...new Map([...themes, ...customThemes()].map(theme => [theme.metadata.id, theme])).values()].filter(theme => theme.metadata.variant === variant).map(theme => ({ value: theme.metadata.id, title: theme.metadata.name }));
  const themeValue = (variant: 'light' | 'dark') => nativeAppearance.current()?.themeIDs[variant] || text(settings()[variant === 'light' ? 'lightThemeId' : 'darkThemeId']);
  async function selectTheme(variant: 'light' | 'dark', id: string, operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current() || disabled()) return;
    await state.perform(async (operation) => {
      if (pending()) { await refreshCommitted(operation); return; }
      if (!themeItems(variant).some(item => item.value === id)) return;
      const current = settingsObject(await operation.request('/api/config/settings'));
      if (!operation.current()) return;
      const patch = { [variant === 'light' ? 'lightThemeId' : 'darkThemeId']: id, ...(nativeAppearanceModeFromSettings(current) === variant ? { themeId: id, themeVariant: variant } : {}) };
      await writePreferences(operation, patch);
    }, operation);
  }
  const special = props.page === 'appearance' ? ['appearance.theme-mode', 'appearance.light-theme', 'appearance.dark-theme', 'appearance.language'] : [];
  const ordered = () => [...(state.ready() ? special : []), ...fields.filter(field => state.ready() || isIndependentDevicePreference(field.key)).map(field => field.id)];
  const previewVisible = signal(false);
  const previewVisibility = createPreferencePreviewVisibility(visible => previewVisible.set(visible));
  return <Scroll ref={scroll} onLayout={previewVisibility.onViewportLayout} onScroll={event => { navigation.onScroll(event); previewVisibility.onScroll(event); }} class="flex-1" contentClass="p-5 gap-5 pb-10" contentStyle={nativeDensity().pages.settings}>
    <SettingsFeedback state={state} retry={pending() || !receiptReady() ? () => { void retryRefresh(); } : !state.ready() ? () => { void load(); } : undefined} />
    <If when={!!localSaveError()}><Text testID="settings-device-save-error" class="text-sm text-destructive">{localSaveError()}</Text><Button testID="settings-device-save-retry" class={settingsAction} disabled={deviceDisabled() || preferenceSaveBusy() || codeSaveBusy() || !hasIndependentDraft()} onPress={() => { void save(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
    <If when={!!pending() && !pendingUnsent() && !pending()!.acknowledged}><Text testID="settings-preferences-unknown" class="text-sm text-destructive">{t('settings.github.native.unknown')}</Text></If>
    <If when={!!nativeAppearance.error()}><Text class="text-sm text-destructive">{t('chat.chatInput.toast.reloadFailed')}</Text><Button class={settingsAction} disabled={state.busy()} onPress={() => { void refreshNativeAppearance(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
    <Each of={ordered()}>{id => <SettingsTarget id={id()} target={props.target} onReveal={node => { void navigation.reveal(node); }} onLayout={id() === 'chat.render-mode' ? previewVisibility.onFieldLayout : undefined}>
      <If when={id() === 'appearance.theme-mode'}><SettingsGroup title={t('settings.yuri.visual.section.colorMode')}><SettingsChoice title={t('settings.yuri.visual.field.themeMode')} value={nativeAppearance.current()?.mode ?? nativeAppearanceModeFromSettings(settings())} disabled={disabled() || nativeAppearance.saving()} items={(['system', 'light', 'dark'] as const).map(value => ({ value, title: t(`settings.yuri.visual.option.themeMode.${value}`) }))} onChange={next => { void state.perform(async (operation) => {
        if (next !== 'system' && next !== 'light' && next !== 'dark') return;
        if (pending()) { await refreshCommitted(operation); return; }
        await saveNativeAppearanceMode(next, operation.current, (path, method, body) => {
          if (path === '/api/config/settings' && method?.toUpperCase() === 'PUT') return dispatchPreferences(operation, settingsObject(body));
          return operation.request(path, method, body);
        });
        if (operation.current() && pending()) await refreshCommitted(operation);
        if (operation.current()) props.onAppearanceChange?.(next);
      }); }} /></SettingsGroup></If>
      <If when={id() === 'appearance.language'}><SettingsGroup title={t('settings.appearance.language.label')}><SettingsChoice title={t('settings.appearance.language.select')} value={language()} items={[{ value: 'system', title: t('settings.yuri.visual.option.themeMode.system') }, { value: 'en', title: 'English' }, { value: 'zh-CN', title: '简体中文' }, { value: 'zh-TW', title: '繁體中文' }, { value: 'ja', title: '日本語' }, { value: 'ko', title: '한국어' }, { value: 'fr', title: 'Français' }, { value: 'es', title: 'Español' }, { value: 'pl', title: 'Polski' }, { value: 'pt-BR', title: 'Português (Brasil)' }, { value: 'uk', title: 'Українська' }]} onChange={next => { void state.perform(async (operation) => { await Storage.setItem('language', next); if (operation.current()) language.set(next); }); }} /></SettingsGroup></If>
      <If when={id() === 'appearance.light-theme' || id() === 'appearance.dark-theme'}><SettingsGroup title={t(id() === 'appearance.light-theme' ? 'settings.yuri.visual.field.lightTheme' : 'settings.yuri.visual.field.darkTheme')}>
        <SettingsChoice title={t(id() === 'appearance.light-theme' ? 'settings.yuri.visual.field.lightTheme' : 'settings.yuri.visual.field.darkTheme')} value={themeValue(id() === 'appearance.light-theme' ? 'light' : 'dark')} items={themeItems(id() === 'appearance.light-theme' ? 'light' : 'dark')} disabled={disabled() || themeBusy() || nativeAppearance.saving()} onChange={next => { void selectTheme(id() === 'appearance.light-theme' ? 'light' : 'dark', next); }} />
        <If when={!!themeError()}><Text class="text-sm text-destructive">{themeError()}</Text></If>
        <Button class={settingsAction} disabled={themeBusy()} onPress={() => { void loadThemes(); }}><Text class="text-foreground">{t('settings.yuri.visual.actions.reloadThemes')}</Text></Button>
      </SettingsGroup></If>
      <Each of={fields.filter(field => field.id === id())}>{field => <If when={hasPreferenceChoicePresentation(field().key)} else={<SettingsGroup title={t(field().title)}>
        <If when={field().consumer === 'device-cache'}>
          <Text class="text-xs text-muted-foreground">{t('settings.yuri.visual.transcriptCache.description')}</Text>
          <Button testID="settings-transcript-cache-clear" class={settingsAction} disabled={cacheDisabled()} onPress={() => { void requestCacheClear(); }}><Text class="text-foreground">{t(cacheBusy() ? 'settings.yuri.visual.transcriptCache.dialog.clearing' : 'settings.yuri.visual.transcriptCache.action')}</Text></Button>
          <If when={cacheCleared()}><Text testID="settings-transcript-cache-cleared" class="text-sm text-muted-foreground">{t('settings.yuri.visual.transcriptCache.toast.cleared')}</Text></If>
          <If when={cacheError()}><Text testID="settings-transcript-cache-error" class="text-sm text-destructive">{t('settings.yuri.visual.transcriptCache.toast.failed')}</Text><Button testID="settings-transcript-cache-retry" class={settingsAction} disabled={cacheDisabled()} onPress={() => { void requestCacheClear(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
        </If>
        <If when={isDeviceFontSize(field().key)}>
          <If when={!deviceAppearance()}><Text testID={`settings-${field().key === 'codeFontSize' ? 'code' : 'editor'}-font-size-unknown`} class="text-sm text-muted-foreground">{t('common.unavailable')}</Text></If>
          <If when={codeReadFailed() || deviceSaveFailed()[field().key] || deviceAppearanceError() === 'device-appearance-read-failed'}><Text testID={`settings-${field().key === 'codeFontSize' ? 'code' : 'editor'}-font-size-error`} class="text-sm text-destructive">{t(deviceSaveFailed()[field().key] ? 'settings.voice.volcengine.saveFailed' : 'chat.chatInput.toast.reloadFailed')}</Text><Button testID={`settings-${field().key === 'codeFontSize' ? 'code' : 'editor'}-font-size-retry`} class={settingsAction} disabled={deviceDisabled() || codeReadBusy() || codeSaveBusy()} onPress={() => { if (deviceSaveFailed()[field().key]) void save(); else void reloadDeviceCodeFontSize(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
          <If when={deviceSaved()[field().key]}><Text testID={`settings-${field().key === 'codeFontSize' ? 'code' : 'editor'}-font-size-saved`} class="text-sm text-muted-foreground">{t('filesView.editor.saved')}</Text></If>
        </If>
        <If when={field().consumer === 'host-runtime'}><Text class="text-xs text-muted-foreground">{t('settings.gitIdentities.editor.field.host')}</Text></If>
        <If when={!!field().description}><Text testID={`settings-description-${field().key}`} class="text-xs text-muted-foreground">{field().description ? t(field().description!) : ''}</Text></If>
        <If when={field().key === 'sidebarBrandName' && (!brandTransportID || app.connection()?.transportID !== brandTransportID)}><Text testID="settings-sidebar-brand-scope-required" class="text-sm text-muted-foreground">{t('settings.preferences.native.brandScopeDescription')}</Text></If>
        <If when={field().key === 'sidebarBrandName' && !brandPreference()}><Text testID="settings-sidebar-brand-unknown" class="text-sm text-muted-foreground">{t('common.unavailable')}</Text></If>
        <If when={field().key === 'sidebarBrandName' && brandReadFailed()}><Text testID="settings-sidebar-brand-error" class="text-sm text-destructive">{t('chat.chatInput.toast.reloadFailed')}</Text><Button testID="settings-sidebar-brand-retry" class={settingsAction} disabled={disabled() || brandReadBusy() || !state.current()} onPress={() => { void reloadBrandPreference(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
        <If when={field().key === 'sidebarBrandName' && deviceSaved().sidebarBrandName}><Text testID="settings-sidebar-brand-saved" class="text-sm text-muted-foreground">{t('filesView.editor.saved')}</Text></If>
        <If when={field().key === 'iosNativeUiEnabled' && !iosPreference()}><Text testID="settings-ios-native-ui-unknown" class="text-sm text-muted-foreground">{t('common.unavailable')}</Text></If>
        <If when={field().key === 'iosNativeUiEnabled' && iosReadFailed()}><Text testID="settings-ios-native-ui-error" class="text-sm text-destructive">{t('chat.chatInput.toast.reloadFailed')}</Text><Button testID="settings-ios-native-ui-retry" class={settingsAction} disabled={deviceDisabled() || iosReadBusy()} onPress={() => { void reloadIosPreference(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
        <If when={field().key === 'iosNativeUiEnabled' && deviceSaved().iosNativeUiEnabled}><Text testID="settings-ios-native-ui-saved" class="text-sm text-muted-foreground">{t('filesView.editor.saved')}</Text></If>
        <If when={!field().local || isDeviceChatPreference(field().key) || isDeviceFontSize(field().key) || field().key === 'sidebarBrandName' && !!brandPreference() || field().key === 'iosNativeUiEnabled' && !!iosPreference()}>
          <If when={field().kind === 'boolean'}><SettingsToggle testID={`settings-preference-${field().key}`} title={t(field().title)} value={value(field().key) === true} disabled={fieldDisabled(field().key)} onChange={next => update(field().key, next)} /></If>
          <If when={!!field().options || field().key === 'monoFont'}><SettingsChoice title={t(field().title)} value={text(value(field().key)) || (field().key === 'monoFont' ? DEFAULT_MONO_FONT : '')} items={field().key === 'monoFont' ? CODE_FONT_OPTIONS.map(option => ({ value: option.id, title: option.label })) : (field().options || []).map(option => ({ value: option.value, title: t(option.title) }))} disabled={disabled()} onChange={next => update(field().key, next)} /></If>
          <If when={field().kind !== 'boolean' && !field().options && field().key !== 'monoFont'}><SettingsInput testID={`settings-basics-${field().key}`} title={t(field().title) + (field().kind === 'number' ? ` (${field().min}–${field().max})` : '')} value={value(field().key) === undefined ? '' : String(value(field().key))} disabled={fieldDisabled(field().key) || field().key === 'sidebarBrandName' && (!brandOwner?.snapshot() || brandReadBusy()) || isDeviceFontSize(field().key) && (!deviceAppearance() || codeReadBusy() || props.active === false || !state.current())} onChange={next => update(field().key, next)} /></If>
          <If when={field().page === 'appearance' && (field().kind === 'number' || field().key === 'monoFont' || ['pwaAppName', 'pwaOrientation', 'mobileKeyboardMode', 'iosNativeUiEnabled'].includes(field().key))}><Button testID={`settings-reset-${field().key}`} class={settingsAction} disabled={fieldDisabled(field().key) || isDeviceFontSize(field().key) && (!deviceAppearance() || codeReadBusy() || props.active === false || !state.current())} onPress={() => update(field().key, field().key === 'monoFont' ? DEFAULT_MONO_FONT : field().initial)}><Text class="text-foreground">{t('settings.common.actions.reset')}</Text></Button></If>
        </If>
      </SettingsGroup>}>
        <SettingsPreferenceChoiceField field={field()} value={value(field().key)} previewVisible={previewVisible()} active={props.active !== false && state.current()} disabled={fieldDisabled(field().key) || props.active === false || !state.current() || field().key === 'fileEditorKeymap' && (!deviceAppearance() || codeReadBusy())} onChange={next => { if (props.active !== false && state.current() && !fieldDisabled(field().key)) update(field().key, next); }} />
        <If when={field().key === 'fileEditorKeymap'}><View class="gap-2" style={nativeDensity().settings.section}>
          <If when={!deviceAppearance()}><Text testID="settings-file-editor-keymap-unknown" class="text-sm text-muted-foreground">{t('common.unavailable')}</Text></If>
          <If when={codeReadFailed() || deviceSaveFailed().fileEditorKeymap || deviceAppearanceError() === 'device-appearance-read-failed'}><Text testID="settings-file-editor-keymap-error" class="text-sm text-destructive">{t(deviceSaveFailed().fileEditorKeymap ? 'settings.voice.volcengine.saveFailed' : 'chat.chatInput.toast.reloadFailed')}</Text><Button testID="settings-file-editor-keymap-retry" class={settingsAction} disabled={deviceDisabled() || codeReadBusy() || codeSaveBusy()} onPress={() => { if (deviceSaveFailed().fileEditorKeymap) void save(); else void reloadDeviceCodeFontSize(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
          <If when={deviceSaved().fileEditorKeymap}><Text testID="settings-file-editor-keymap-saved" class="text-sm text-muted-foreground">{t('filesView.editor.saved')}</Text></If>
          <Button testID="settings-reset-fileEditorKeymap" class={settingsAction} disabled={deviceDisabled() || !deviceAppearance() || codeReadBusy()} onPress={() => update('fileEditorKeymap', 'default')}><Text class="text-foreground">{t('settings.common.actions.reset')}</Text></Button>
        </View></If>
      </If>}</Each>
    </SettingsTarget>}</Each>
    <Button testID="settings-preferences-save" class={settingsAction} disabled={preferenceSaveBusy() || codeSaveBusy() || !Object.keys(changes()).length || disabled() && (deviceDisabled() || !hasIndependentDraft())} onPress={() => { void save(); }}><Text class="text-foreground">{t('settings.plugins.page.action.save')}</Text></Button>
  </Scroll>;
}

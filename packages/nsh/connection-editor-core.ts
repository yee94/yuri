import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { Connection } from './model';

export type ConnectionEditorDescriptor = {
  id: string; version: string; label: string; url: string; transport: 'direct' | 'relay';
};
export type ConnectionEditorMutation = { id: string; version: string; label: string; url?: string };
export type ConnectionEditorSnapshot = { connections: Connection[]; selected: string | null; runtimeInvalidated?: boolean };
export type ConnectionEditorNavigation = { blocked: boolean; back: () => void };

export function connectionEditorDirty(baseline: ConnectionEditorDescriptor | undefined, label: string, url?: string): boolean {
  return !!baseline && (label !== baseline.label || url !== undefined && url !== baseline.url);
}

/** One leave owner for the native back button and the form's cancel action. */
export function createConnectionEditorLeaveGuard(options: {
  dirty: () => boolean; busy: () => boolean; current: () => boolean;
  confirmDiscard: () => Promise<boolean>; onLeave: () => void;
  onConfirming: (confirming: boolean) => void;
}) {
  let confirming = false;
  return {
    blocked: () => options.busy() || confirming || options.dirty(),
    async back() {
      if (!options.current() || options.busy() || confirming) return;
      if (!options.dirty()) { options.onLeave(); return; }
      confirming = true; options.onConfirming(true);
      try {
        const discard = await options.confirmDiscard();
        if (discard && options.current() && !options.busy()) options.onLeave();
      } finally { confirming = false; options.onConfirming(false); }
    },
  };
}

export function connectionEditorDescriptor(value: unknown, id: string): ConnectionEditorDescriptor {
  if (!value || typeof value !== 'object') throw new Error('connection_editor_invalid');
  const row = value as Record<string, unknown>;
  if (row.id !== id || typeof row.version !== 'string' || !row.version || typeof row.label !== 'string' ||
      typeof row.url !== 'string' || !['direct', 'relay'].includes(String(row.transport))) throw new Error('connection_editor_invalid');
  // Deliberately project: a malformed native response must not populate credentials in a form.
  return { id, version: row.version, label: row.label, url: row.url, transport: row.transport as 'direct' | 'relay' };
}

export function connectionEditorInput(descriptor: ConnectionEditorDescriptor, label: string, url?: string): ConnectionEditorMutation {
  const name = label.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error('connection_editor_invalid');
  return { id: descriptor.id, version: descriptor.version, label: name, ...(url === undefined ? {} : { url }) };
}

const failures: Record<string, I18nKey> = {
  connection_editor_invalid: 'mobile.instances.nativeEditor.invalid',
  connection_editor_missing: 'mobile.instances.nativeEditor.missing',
  connection_editor_stale: 'mobile.instances.nativeEditor.stale',
  connection_editor_pairing_required: 'mobile.instances.nativeEditor.pairingRequired',
  connection_editor_duplicate: 'mobile.instances.nativeEditor.duplicate',
  connection_editor_storage: 'mobile.instances.nativeEditor.storage',
};
export function connectionEditorFailureKey(error: unknown): I18nKey {
  const message = error instanceof Error ? error.message : '';
  return Object.entries(failures).find(([code]) => new RegExp(`(?:^|[^a-z_])${code}(?:$|[^a-z_])`).test(message))?.[1] ?? 'mobile.instances.nativeEditor.storage';
}

/** No connect/auth call exists on this metadata-only path. A failed save keeps the draft. */
export function createConnectionEditor(options: {
  read: (id: string) => Promise<unknown>;
  write: (method: 'connection.rename' | 'connection.edit', input: ConnectionEditorMutation) => Promise<ConnectionEditorSnapshot>;
  current: () => boolean;
}) {
  let descriptor: ConnectionEditorDescriptor | undefined;
  let busy = false;
  return {
    async load(id: string) {
      const value = connectionEditorDescriptor(await options.read(id), id);
      if (!options.current()) return undefined;
      descriptor = value;
      return value;
    },
    async save(label: string, url?: string) {
      if (!options.current() || busy) return undefined;
      if (!descriptor) throw new Error('connection_editor_missing');
      const input = connectionEditorInput(descriptor, label, url);
      busy = true;
      try {
        const snapshot = await options.write(url === undefined ? 'connection.rename' : 'connection.edit', input);
        if (!options.current()) return undefined;
        return snapshot;
      } finally { busy = false; }
    },
  };
}

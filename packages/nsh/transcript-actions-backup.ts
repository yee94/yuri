import { record, type Attachment } from './model';
import { nativeEditFiles } from './transcript-actions-core';
import { referenceKinds, sameReferenceScope, validateNativeReferences, type NativeReference, type ReferenceScope, type ScopedReferenceDocument } from './composer-references';

export type HistoryDraftSnapshot = { text: string; files: Attachment[]; references: ScopedReferenceDocument };
export type HistoryDraftOwner = {
  attachments: { (): Attachment[]; set(files: Attachment[]): void };
  referenceDocument: () => ScopedReferenceDocument;
  setReferenceDocument: (next: ScopedReferenceDocument, expected?: ScopedReferenceDocument) => boolean;
};
export function historyDraftSnapshot(owner: HistoryDraftOwner): HistoryDraftSnapshot {
  const document = owner.referenceDocument();
  return { text: document.text, files: owner.attachments().map(file => ({ uri: file.uri, name: file.name, mime: file.mime })), references: { text: document.text, scope: { ...document.scope }, references: document.references.map(ref => ({ kind: ref.kind, value: ref.value, label: ref.label, display: ref.display, start: ref.start, end: ref.end,
    ...(ref.directory !== undefined ? { directory: ref.directory } : {}), ...(ref.description !== undefined ? { description: ref.description } : {}), ...(ref.scope ? { scope: { ...ref.scope } } : {}),
  })) } };
}
function snapshotFrom(value: unknown, scope: ReferenceScope): HistoryDraftSnapshot {
  const input = record(value);
  if (typeof input.text !== 'string' || !Array.isArray(input.files) || input.files.length > 100) throw new Error('Invalid saved history draft');
  let references: NativeReference[] = [];
  if (input.references !== undefined) {
    const document = record(input.references), stored = record(document.scope);
    if (document.text !== input.text || stored.host !== scope.host || stored.draft !== scope.draft || stored.directory !== scope.directory || !Array.isArray(document.references)) throw new Error('native-reference-scope-mismatch');
    references = document.references.map(value => {
      const ref = record(value);
      const kind = referenceKinds.find(kind => kind === ref.kind);
      if (!kind || typeof ref.value !== 'string' || typeof ref.label !== 'string' || typeof ref.display !== 'string' || typeof ref.start !== 'number' || typeof ref.end !== 'number') throw new Error('native-reference-invalid');
      const refScope = ref.scope === undefined ? undefined : record(ref.scope);
      if (refScope && (refScope.host !== scope.host || refScope.draft !== scope.draft || refScope.directory !== scope.directory)) throw new Error('native-reference-scope-mismatch');
      return { kind, value: ref.value, label: ref.label, display: ref.display, start: ref.start, end: ref.end,
        ...(typeof ref.directory === 'string' ? { directory: ref.directory } : {}), ...(typeof ref.description === 'string' ? { description: ref.description } : {}), ...(refScope ? { scope: { ...scope } } : {}) };
    });
  }
  const document = { text: input.text, references, scope: { ...scope } };
  validateNativeReferences(document);
  return { text: input.text, files: nativeEditFiles(input.files.map(record)), references: document };
}
/** v1 backups lacked sidecars: restore plain text, never infer semantics from @ text. */
export function historyDraftBackupFrom(raw: string | null, scope: ReferenceScope): HistoryDraftSnapshot[] {
  const input: unknown = raw === null ? null : JSON.parse(raw);
  if (input === null) return [];
  const root = record(input);
  if (root.version === undefined) return [snapshotFrom(root, scope)];
  if (root.version !== 2 || !Array.isArray(root.snapshots) || root.snapshots.length > 16) throw new Error('Invalid history recovery journal');
  return root.snapshots.map(value => snapshotFrom(value, scope));
}
export function historyDraftBackupJSON(snapshots: HistoryDraftSnapshot[]) {
  if (snapshots.length > 16) throw new Error('History recovery journal is full');
  const value = JSON.stringify({ version: 2, snapshots });
  if (value.length > 750_000) throw new Error('History recovery journal is too large');
  return value;
}
/** Existing durable document CAS owns text/reference replacement; files follow synchronously. */
export function replaceHistoryDraft(owner: HistoryDraftOwner, next: HistoryDraftSnapshot, expected: HistoryDraftSnapshot) {
  const files = owner.attachments();
  if (!sameReferenceScope(next.references.scope, expected.references.scope) || files.length !== expected.files.length || files.some((file, i) => file.uri !== expected.files[i]?.uri || file.name !== expected.files[i]?.name || file.mime !== expected.files[i]?.mime)) return false;
  if (!owner.setReferenceDocument(next.references, expected.references)) return false;
  owner.attachments.set(next.files.map(file => ({ ...file }))); return true;
}

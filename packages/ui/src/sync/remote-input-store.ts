import { create } from 'zustand';
import type { HostLocation } from '@/lib/remote-projects/location';
import { locationKey, REMOTE_NEW_SESSION_DRAFT_ID } from '@/lib/remote-projects/location';
import { getRuntimeGeneration } from '@/lib/runtime-switch';
import { createInputStore, type InputDraftServices, type SyntheticContextPart } from './input-store';
import { blobFromDataUrl } from '@/lib/prompt-attachment-upload';
import { createInputDraftBlobStore, createIndexedDBInputDraftBlobDriver } from './input-draft-blob-store';
import { createDefaultInputDraftMetadataSink } from './input-draft-metadata-store';
import { draftKeyString, newSessionDraftKey, sessionDraftKey } from './input-draft-types';

const stores = new Map<string, ReturnType<typeof createInputStore>>();
export const remoteDraftTransportIdentity = (hubId: string) => `remote-hub:${JSON.stringify(hubId)}`;

/** One client-local Hub partition; LAN/Relay fingerprints remain request fences, not durable keys. */
export function createRemoteInputStore(hubId: string, services: InputDraftServices = {}) {
  if (!hubId) throw new Error('Remote draft requires a Hub identity');
  const backing = services.sink ?? createDefaultInputDraftMetadataSink();
  const prefix = `remote-input:${encodeURIComponent(hubId)}:`;
  const sink = {
    read: (key: string) => backing.read(prefix + key),
    write: (key: string, value: string) => backing.write(prefix + key, value),
    remove: (key: string) => backing.remove(prefix + key),
    keys: async () => {
      const result = await backing.keys();
      return result.ok ? { ok: true as const, value: result.value.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)) } : result;
    },
  };
  // Each durability coordinator reconciles its complete reference set. It must
  // never sweep the Hub/local coordinator's or another Hub's blob database.
  const blobStore = services.blobStore ?? createInputDraftBlobStore(createIndexedDBInputDraftBlobDriver(`yuri-remote-input-drafts:${encodeURIComponent(hubId)}`));
  return createInputStore({ ...services, sink, blobStore, runtimeCapture: services.runtimeCapture ?? (() => ({ transportIdentity: remoteDraftTransportIdentity(hubId), generation: getRuntimeGeneration() })) });
}

export function getRemoteInputStore(location: HostLocation) {
  if (!location.hostId) throw new Error('Remote input store requires a Host Location');
  let store = stores.get(location.hubId);
  if (!store) { store = createRemoteInputStore(location.hubId); stores.set(location.hubId, store); }
  return store;
}

export function remoteSessionDraftKey(location: HostLocation, sessionID: string | null) {
  const scope = { transportIdentity: remoteDraftTransportIdentity(location.hubId), location };
  return sessionID ? sessionDraftKey(scope, sessionID) : newSessionDraftKey(scope, REMOTE_NEW_SESSION_DRAFT_ID);
}

export async function seedRemoteDraft(location: HostLocation, text: string): Promise<void> {
  const store = getRemoteInputStore(location);
  const key = remoteSessionDraftKey(location, null);
  if (!await store.getState().hydrateDraftMetadata(key.transportIdentity)) throw new Error('Remote draft storage unavailable');
  store.getState().setDraftText(key, text);
}

export async function seedRemoteDraftSyntheticParts(location: HostLocation, parts: readonly SyntheticContextPart[]): Promise<void> {
  const store = getRemoteInputStore(location);
  const key = remoteSessionDraftKey(location, null);
  if (!await store.getState().hydrateDraftMetadata(key.transportIdentity)) throw new Error('Remote draft storage unavailable');
  for (const [index, part] of parts.entries()) {
    const partID = part.partID ?? `remote-draft-metadata:${index}`;
    const input = store.getState();
    if (!input.getDraft(key)?.syntheticParts.some((existing) => existing.partID === partID)) {
      input.setDraftSyntheticParts(key, [...input.getDraft(key)?.syntheticParts ?? [], { partID, text: part.text, synthetic: part.synthetic, attachments: [] }]);
    }
    for (const file of part.attachments ?? []) {
      if (store.getState().getDraft(key)?.syntheticParts.find((candidate) => candidate.partID === partID)?.attachments.some((metadata) => metadata.attachmentID === file.id)) continue;
      const bytes = file.file?.size ? file.file : blobFromDataUrl(file.dataUrl, file.mimeType);
      if (bytes) {
        if (!await store.getState().addDraftLocalAttachment(key, bytes, { attachmentID: file.id, filename: file.filename, partID })) throw new Error('Remote draft attachment could not be persisted');
      } else if (!store.getState().addDraftDurableAttachment(key, { attachmentID: file.id, filename: file.filename, mimeType: file.mimeType, size: file.size, source: 'server', serverPath: file.serverPath ?? file.dataUrl, url: file.dataUrl, partID })) {
        throw new Error('Remote draft attachment source unavailable');
      }
    }
  }
}

type PendingInput = { text: string; mode: 'replace' | 'append' | 'append-inline' };
type PendingResource = { input?: PendingInput; preset?: string };
export const useRemotePendingComposer = create<{ entries: Record<string, PendingResource> }>(() => ({ entries: {} }));
const resourceKey = (location: HostLocation, sessionID: string | null) => `${locationKey(location)}:${draftKeyString(remoteSessionDraftKey(location, sessionID))}`;
export function requestRemoteComposerInput(location: HostLocation, sessionID: string | null, input: PendingInput) {
  const key = resourceKey(location, sessionID);
  useRemotePendingComposer.setState((state) => ({ entries: { ...state.entries, [key]: { ...state.entries[key], input } } }));
}
export function requestRemotePresetSubmit(location: HostLocation, sessionID: string | null, preset: string) {
  const key = resourceKey(location, sessionID);
  useRemotePendingComposer.setState((state) => ({ entries: { ...state.entries, [key]: { ...state.entries[key], preset } } }));
}
export const remotePendingComposerKey = resourceKey;
export function consumeRemoteComposerResource(location: HostLocation, sessionID: string | null, kind: 'input'): PendingInput | null;
export function consumeRemoteComposerResource(location: HostLocation, sessionID: string | null, kind: 'preset'): string | null;
export function consumeRemoteComposerResource(location: HostLocation, sessionID: string | null, kind: 'input' | 'preset') {
  const key = resourceKey(location, sessionID);
  const value = useRemotePendingComposer.getState().entries[key]?.[kind] ?? null;
  if (value === null) return null;
  useRemotePendingComposer.setState((state) => {
    const entry = { ...state.entries[key] }; delete entry[kind];
    const entries = { ...state.entries };
    if (entry.input || entry.preset !== undefined) entries[key] = entry; else delete entries[key];
    return { entries };
  });
  return value;
}

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'vitest';
import { useComposerController } from '@/composer/use-composer-controller';
import { createRemoteInputStore, remoteSessionDraftKey, requestRemoteComposerInput, requestRemotePresetSubmit, consumeRemoteComposerResource } from './remote-input-store';
import { createInputDraftBlobStore, MemoryInputDraftBlobDriver } from './input-draft-blob-store';
import type { InputDraftMetadataSink } from './input-draft-metadata-store';
import { getRuntimeApiBaseUrl, getRuntimeKey, getRuntimeTransportIdentity, switchRuntimeEndpoint } from '@/lib/runtime-switch';

test('real composer and durable attachment bytes recover after same-Hub LAN to Relay remount, without crossing Host/Hub', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const values = new Map<string, string>();
  const sink: InputDraftMetadataSink = {
    read: async (key) => ({ ok: true, value: values.get(key) ?? null }),
    write: async (key, value) => { values.set(key, value); return { ok: true, value: undefined }; },
    remove: async (key) => { values.delete(key); return { ok: true, value: undefined }; },
    keys: async () => ({ ok: true, value: [...values.keys()] }),
  };
  const drivers = new Map<string, MemoryInputDraftBlobDriver>();
  const location = { hubId: 'hub-a', hostId: 'host-b', directory: '/repo' };
  const key = remoteSessionDraftKey(location, 'same');
  const previous = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
  switchRuntimeEndpoint({ apiBaseUrl: 'http://lan.example', runtimeKey: 'hub-a' });
  const lanTransport = getRuntimeTransportIdentity();
  const makeStore = (hubId: string) => {
    let driver = drivers.get(hubId);
    if (!driver) { driver = new MemoryInputDraftBlobDriver(); drivers.set(hubId, driver); }
    return createRemoteInputStore(hubId, { sink, blobStore: createInputDraftBlobStore(driver) });
  };
  let store = makeStore(location.hubId);
  await store.getState().hydrateDraftMetadata(key.transportIdentity);
  store.getState().setDraftText(key, 'LAN draft with attachment');
  await store.getState().addDraftLocalAttachment(key, new File(['exact attachment bytes'], 'context.txt', { type: 'text/plain' }));
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  const titles = { get: () => undefined };
  function Editor({ draftKey = key }: { draftKey?: typeof key }) {
    const composer = useComposerController({ draftKey, sessionTitles: titles, persistenceEnabled: true, store });
    return <textarea value={composer.document.text} onChange={() => {}} onInput={(event) => composer.applyBrowserEdit(event.currentTarget.value, event.currentTarget.selectionStart)} />;
  }
  try {
    await act(async () => root.render(<Editor key="LAN-fingerprint" />));
    expect(node.querySelector('textarea')!.value).toBe('LAN draft with attachment');
    await act(async () => {
      const textarea = node.querySelector('textarea')!;
      textarea.value = 'Typed on LAN, restored on Relay';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await store.getState().setDraftPersistenceEnabled(true);
    });
    await act(async () => root.render(null));
    switchRuntimeEndpoint({ apiBaseUrl: 'http://relay.example', runtimeKey: 'hub-a', relay: { relayUrl: 'wss://relay.example', serverId: 'hub-a', hostEncPubJwk: { kty: 'EC', crv: 'P-256' } } });
    expect(getRuntimeTransportIdentity()).not.toBe(lanTransport);
    expect(getRuntimeTransportIdentity()).toMatch(/^relay:/);
    // A fresh owner must recover from disk, not from an accidentally retained text/Blob view.
    store = makeStore(location.hubId);
    expect(store.getState().getDraft(key)).toBeUndefined();
    await store.getState().hydrateDraftMetadata(key.transportIdentity);
    await store.getState().hydrateDraftAttachments(key);
    await act(async () => root.render(<Editor key="Relay-fingerprint" />));
    expect(node.querySelector('textarea')!.value).toBe('Typed on LAN, restored on Relay');
    const restored = store.getState().getDraftAttachmentViews(key);
    expect(restored).toHaveLength(1);
    expect(restored[0].filename).toBe('context.txt');
    expect(await restored[0].file!.text()).toBe('exact attachment bytes');
    await act(async () => root.render(<Editor key="other-host" draftKey={remoteSessionDraftKey({ ...location, hostId: 'host-c' }, 'same')} />));
    expect(node.querySelector('textarea')!.value).toBe('');
    store = makeStore('other-hub');
    const otherKey = remoteSessionDraftKey({ ...location, hubId: 'other-hub' }, 'same');
    await store.getState().hydrateDraftMetadata(otherKey.transportIdentity);
    await act(async () => root.render(<Editor key="other-hub" draftKey={otherKey} />));
    expect(node.querySelector('textarea')!.value).toBe('');
    expect(store.getState().getDraftAttachmentViews(otherKey)).toEqual([]);
    store = makeStore(location.hubId);
    await store.getState().hydrateDraftMetadata(key.transportIdentity);
    await store.getState().hydrateDraftAttachments(key);
    expect(await store.getState().getDraftAttachmentViews(key)[0].file!.text()).toBe('exact attachment bytes');
  } finally { await act(async () => root.unmount()); node.remove(); switchRuntimeEndpoint({ ...previous, relay: null }); }
});

test('pending input and preset admission are isolated by Location and draft owner', () => {
  const a = { hubId: 'hub', hostId: 'a', directory: '/repo' };
  const b = { ...a, hostId: 'b' };
  requestRemoteComposerInput(a, 'same', { text: 'insert A', mode: 'append-inline' });
  requestRemotePresetSubmit(a, 'same', 'preset A');
  expect(consumeRemoteComposerResource(b, 'same', 'input')).toBeNull();
  expect(consumeRemoteComposerResource(a, null, 'preset')).toBeNull();
  expect(consumeRemoteComposerResource(a, 'same', 'input')).toEqual({ text: 'insert A', mode: 'append-inline' });
  expect(consumeRemoteComposerResource(a, 'same', 'preset')).toBe('preset A');
  expect(consumeRemoteComposerResource(a, 'same', 'preset')).toBeNull();
});

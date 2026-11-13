import { locationCachePartition, type HostLocation } from '../../lib/remote-projects/location'
import { sessionDraftKey } from '../input-draft-types'
import { createInputDraftBlobStore } from '../input-draft-blob-store'
import { createRuntimeTranscriptDurableStore } from '../transcript-durable-store-runtime'
import { createIndexedDBTranscriptDurableStore } from '../transcript-durable-store-indexeddb'
import { toTranscriptDurableScope } from '../transcript-durable-store-query'
import type { Message, Part } from '../../lib/opencode/v2-types'

// Loaded by the existing Electron evidence harness, never by the application.
const check = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const run = async () => {
  const locations: HostLocation[] = [
    { hubId: 'hub-a', directory: '/workspace' },
    { hubId: 'hub-a', hostId: 'host-a', directory: '/workspace' },
    { hubId: 'hub-a', hostId: 'host-b', directory: '/workspace' },
    { hubId: 'hub-b', hostId: 'host-a', directory: '/workspace' },
  ]
  const databaseName = 'yuri-remote-projects-evidence'
  const scopes = locations.map((location) => toTranscriptDurableScope({
    transport: 'initial-transport', generation: 1, directory: location.directory, sessionID: 'same-session',
  }, locationCachePartition(location)))
  const open = (location: HostLocation) => createRuntimeTranscriptDurableStore({
    location,
    isDesktopShell: () => true,
    isDesktopLocalOriginActive: () => true,
    createHttpStore: () => { throw new Error('Remote body reached Hub HTTP cache') },
    createIndexedDBStore: () => createIndexedDBTranscriptDurableStore({ databaseName }),
  })
  const local = createIndexedDBTranscriptDurableStore({ databaseName })
  for (let index = 0; index < locations.length; index += 1) {
    const store = index === 0 ? local : open(locations[index])
    const info = { id: 'same-message', sessionID: 'same-session', role: 'user', time: { created: 1 } } as Message
    const parts = [{ id: 'same-part', messageID: info.id, sessionID: info.sessionID, type: 'text', text: `body-${index}` }] as Part[]
    check((await store.upsertSettled(scopes[index], info, parts)).status === 'written', 'Scoped transcript write failed')
  }
  const reopened = createIndexedDBTranscriptDurableStore({ databaseName })
  for (let index = 0; index < scopes.length; index += 1) {
    const row = await reopened.readMessage(scopes[index], 'same-message')
    check((row?.parts[0] as { text?: string })?.text === `body-${index}`, 'Hub/Host transcript partition collision')
  }
  const reconnect = toTranscriptDurableScope({ transport: 'relay-transport', generation: 99, directory: '/workspace', sessionID: 'same-session' }, locationCachePartition(locations[1]))
  check(!!await reopened.readMessage(reconnect, 'same-message'), 'Reconnect lost durable remote transcript')
  await open(locations[1]).clearSession(scopes[1])
  check(!await reopened.readMessage(scopes[1], 'same-message'), 'Remote transcript delete failed')
  check(!!await reopened.readMessage(scopes[0], 'same-message'), 'Remote delete erased local transcript')
  check(!!await reopened.readMessage(scopes[2], 'same-message'), 'Remote delete erased another Host transcript')
  await open(locations[1]).clearGeneration({ transport: 'unused-generation', generation: 77 })

  const blobs = createInputDraftBlobStore()
  const references = locations.map((location) => ({
    ...sessionDraftKey({ transportIdentity: 'hub-client', location }, 'same-session'),
    attachmentOccurrenceRefID: 'same-attachment',
  }))
  for (let index = 0; index < references.length; index += 1) {
    check((await blobs.putAndRetain(references[index], `blob-${index}`, `https://example.test/${index}`)).ok, 'Scoped attachment write failed')
  }
  const reopenedBlobs = createInputDraftBlobStore()
  for (let index = 0; index < references.length; index += 1) {
    const result = await reopenedBlobs.readReference(references[index])
    check(result.ok && result.value === `blob-${index}`, 'Hub/Host draft reference collision')
  }
  check((await reopenedBlobs.release(references[1])).ok, 'Remote attachment release failed')
  for (const index of [0, 2, 3]) {
    const result = await reopenedBlobs.readReference(references[index])
    check(result.ok && result.value === `blob-${index}`, 'Remote release erased another draft owner')
  }
  await reopened.destroy()
  return [
    { name: 'same session/message isolated across local, Host and Hub after reopen' },
    { name: 'remote desktop-local writes and cleanup never construct Hub HTTP cache' },
    { name: 'LAN/Relay reconnect retains durable remote transcript' },
    { name: 'remote transcript deletion preserves local and other Host rows' },
    { name: 'draft attachment owners isolated across Host/Hub after reopen and release' },
  ]
}

Object.assign(window, {
  __YURI_TRANSCRIPT_DURABLE_INDEXEDDB_EVIDENCE__: run().then(
    (evidence) => ({ ok: true, evidence }),
    (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  ),
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostRuntimeRegistry, type HostRuntimeDependencies } from '@/lib/remote-projects/registry'
import { locationSessionKey } from '@/lib/remote-projects/location'
import { applySessionCompactionLiveEvent, isCompactionBarrierActive, postSessionCompact, resetSessionCompactionBarrier } from './session-compaction-api'
import { postSessionPermissionReply } from './session-permission-api'
import { postSessionRevertClear, postSessionRevertCommit, postSessionRevertStage } from './session-revert-api'

const location = { hubId: 'hub', hostId: 'host', directory: 'C:\\Project Raw\\' }
const sessionID = 'same/session'
const harness = () => {
  let active = true
  const fetch = vi.fn<HostRuntimeDependencies['fetch']>(async (path) => {
    if (path.endsWith('/compact')) return Response.json({ id: 'compact', sessionID, type: 'compaction', timeCreated: 1 })
    if (path.endsWith('/stage')) return Response.json({ messageID: 'message', files: [] })
    return new Response(null, { status: 204 })
  })
  const registry = new HostRuntimeRegistry('hub', {
    transportIdentity: 'hub-transport', isCurrent: () => active, fetch,
    sdk: () => ({} as ReturnType<HostRuntimeDependencies['sdk']>),
  })
  return { fetch, scope: registry.resolve(location), deactivate: () => { active = false } }
}

afterEach(() => {
  resetSessionCompactionBarrier()
})

describe('scoped session control production API boundaries', () => {
  it('routes compact, revert and permission through the Host with raw directory and signal', async () => {
    const { fetch, scope } = harness()
    const signal = new AbortController().signal
    const input = { sessionID, directory: '/wrong-local-path', signal, scope }
    await postSessionCompact(input)
    await postSessionRevertStage({ ...input, messageID: 'message', files: false })
    await postSessionRevertClear(input)
    await postSessionRevertCommit(input)
    await postSessionPermissionReply({ ...input, requestID: 'request/id', reply: 'reject' })
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/hosts/host/api/session/same%2Fsession/compact',
      '/api/hosts/host/api/session/same%2Fsession/revert/stage',
      '/api/hosts/host/api/session/same%2Fsession/revert',
      '/api/hosts/host/api/session/same%2Fsession/revert/commit',
      '/api/hosts/host/api/session/same%2Fsession/permission/request%2Fid/reply',
    ])
    for (const [, init] of fetch.mock.calls) {
      expect(init?.query).toEqual({ directory: location.directory })
      expect(init?.signal).toBe(signal)
    }
    expect(JSON.parse(String(fetch.mock.calls[4][1]?.body))).toEqual({ decision: 'reject' })
    expect(isCompactionBarrierActive(sessionID)).toBe(false)
    expect(isCompactionBarrierActive(locationSessionKey(location, sessionID))).toBe(true)
  })

  it('keeps remote compaction events from blocking or unblocking a local same-id session', () => {
    const draft = { message: {}, part: {} }
    const properties = { sessionID, id: 'compact' }
    applySessionCompactionLiveEvent(draft, { type: 'session.compaction.started', properties, clientLocation: location })
    expect(isCompactionBarrierActive(sessionID)).toBe(false)
    expect(isCompactionBarrierActive(locationSessionKey(location, sessionID))).toBe(true)
    applySessionCompactionLiveEvent({ message: {}, part: {} }, { type: 'session.compaction.started', properties })
    applySessionCompactionLiveEvent(draft, { type: 'session.compaction.ended', properties, clientLocation: location })
    expect(isCompactionBarrierActive(sessionID)).toBe(true)
    expect(isCompactionBarrierActive(locationSessionKey(location, sessionID))).toBe(false)
  })

  it('rejects an old Hub response before setting the remote compaction barrier', async () => {
    const { fetch, scope, deactivate } = harness()
    fetch.mockImplementationOnce(async () => {
      deactivate()
      return Response.json({ id: 'compact', sessionID, type: 'compaction', timeCreated: 1 })
    })
    await expect(postSessionCompact({ sessionID, scope, directory: location.directory })).rejects.toThrow('Inactive Hub registry')
    expect(isCompactionBarrierActive(locationSessionKey(location, sessionID))).toBe(false)
  })
})

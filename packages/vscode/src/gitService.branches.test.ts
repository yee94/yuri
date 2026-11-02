import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { getGitBranches } from './gitService'

const state = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('child_process', async (original) => ({ ...await original<typeof import('child_process')>(), spawn: state.spawn }))
vi.mock('vscode', () => ({ extensions: { getExtension: () => undefined } }))

const reply = (stdout: string, stderr = '', exitCode = 0) => {
  state.spawn.mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
    queueMicrotask(() => {
      child.stdout.emit('data', stdout)
      child.stderr.emit('data', stderr)
      child.emit('close', exitCode)
    })
    return child
  })
}
beforeEach(() => {
  state.spawn.mockReset()
  vi.stubEnv('SSH_AUTH_SOCK', '/test/agent')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

test('raw fallback reads the actual directory branch, including main', async () => {
  reply('main|abc||*\nfeature|def|| \n')
  expect(await getGitBranches('/repo')).toMatchObject({ current: 'main', all: ['main', 'feature'] })
  expect(state.spawn.mock.calls[0][2]).toMatchObject({ cwd: '/repo' })
  expect(state.spawn).toHaveBeenCalledTimes(1)
})

test('confirmed non-Git is empty but permission failures reject', async () => {
  reply('', 'fatal: not a git repository', 128)
  expect(await getGitBranches('/plain')).toEqual({ all: [], current: '', branches: {} })
  reply('', 'fatal: Permission denied', 128)
  await expect(getGitBranches('/repo')).rejects.toThrow('Permission denied')
})

test('raw detached HEAD has no branch while unborn HEAD preserves its real name', async () => {
  reply('main|abc|| \n')
  reply('', '', 1)
  expect(await getGitBranches('/detached')).toMatchObject({ current: '' })
  reply('')
  reply('trunk\n')
  expect(await getGitBranches('/unborn')).toEqual({ all: [], current: 'trunk', branches: {} })
})

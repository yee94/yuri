import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { ContactMessageBubble } from './ContactMessageBubble'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Array<{ host: HTMLDivElement; root: ReturnType<typeof createRoot> }> = []
afterEach(async () => {
  for (const { host, root } of roots.splice(0)) {
    await act(async () => root.unmount())
    host.remove()
  }
  vi.restoreAllMocks()
})

test.each([true, false])('draws body and tail as one closed path (outgoing=%s), with time but no delivery status', async (outgoing) => {
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ width: 160, height: 32 }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ host, root })
  const render = (joinedAfter = false, media = false) => root.render(<ContactMessageBubble outgoing={outgoing} joinedBefore={false} joinedAfter={joinedAfter} createdAt={1000} time="13:29" mobile={false} media={media}>晓得</ContactMessageBubble>)
  await act(async () => render())
  const path = host.querySelector('path')!
  expect(host.querySelectorAll('svg')).toHaveLength(1)
  expect(host.querySelectorAll('path')).toHaveLength(1)
  expect(path.getAttribute('d')).toMatch(/^M .* Z$/)
  expect(path.getAttribute('d')?.match(/M /g)).toHaveLength(1)
  expect(path.getAttribute('d')).toContain(outgoing ? 'C 168 27 171 31 176 32' : 'H 0 C 5 31 8 27 8 22')
  expect(host.querySelector('time')?.textContent).toBe('13:29')
  expect(host.querySelector('[data-assistant-contact-body]')?.textContent).toBe('晓得')
  expect(host.querySelector('use')).toBeNull()
  const reads = measure.mock.calls.length
  for (let i = 0; i < 50; i++) await act(async () => render())
  expect(measure.mock.calls.length).toBe(reads)
  await act(async () => render(true))
  expect(path.getAttribute('d')).not.toContain(outgoing ? 'C 168 27 171 31 176 32' : 'H 0 C 5 31 8 27 8 22')
  await act(async () => render(false, true))
  expect(host.querySelector('svg')).toBeNull()
  expect(host.querySelector('time')).toBeNull()
})

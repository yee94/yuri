import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }))

import { AssistantMessageReadingView } from './AssistantMessageReadingView'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host.remove() })

const mount = async (onOpenChange: (open: boolean) => void) => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root.render(<AssistantMessageReadingView open text="hello reading" onOpenChange={onOpenChange} />) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  return document.querySelector<HTMLElement>('[data-assistant-contact-reading]')!
}

test('reading view is edge to edge with no header, buttons or safe-area padding', async () => {
  const view = await mount(() => {})
  expect(view.textContent).toContain('hello reading')
  expect(view.querySelector('button')).toBeNull()
  expect(view.className).toContain('fixed inset-0')
  expect(view.className).toContain('bg-background')
  expect(view.innerHTML).not.toContain('safe-area')
})

test('a plain tap leaves, but tapping with text selected does not', async () => {
  const onOpenChange = vi.fn()
  const view = await mount(onOpenChange)
  await act(async () => { view.click() })
  expect(onOpenChange).toHaveBeenCalledWith(false)
  onOpenChange.mockClear()
  const range = document.createRange()
  range.selectNodeContents(view.querySelector('p')!)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
  await act(async () => { view.click() })
  expect(onOpenChange).not.toHaveBeenCalled()
  document.getSelection()!.removeAllRanges()
})

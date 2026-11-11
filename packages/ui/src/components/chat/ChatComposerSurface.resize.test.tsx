import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const motion = vi.hoisted(() => ({ reduced: false, animate: vi.fn() }))
vi.mock('motion/react', () => ({ animate: motion.animate, useReducedMotion: () => motion.reduced }))
import { ChatComposerSurface } from './ChatComposerSurface'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class ResizeProbe {
  static instances: ResizeProbe[] = []
  targets = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) { ResizeProbe.instances.push(this) }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
  static emit(target: Element) {
    for (const observer of this.instances) if (observer.targets.has(target)) observer.callback([], observer as unknown as ResizeObserver)
  }
}

const roots: Array<ReturnType<typeof createRoot>> = []
beforeEach(() => {
  motion.reduced = false
  motion.animate.mockReset().mockImplementation(() => ({ stop: vi.fn() }))
  ResizeProbe.instances = []
  vi.stubGlobal('ResizeObserver', ResizeProbe)
  vi.stubGlobal('DOMMatrixReadOnly', class {
    m22: number
    m42: number
    constructor(transform: string) {
      this.m22 = Number(/scaleY\(([^)]+)\)/.exec(transform)?.[1] ?? 1)
      this.m42 = Number(/translateY\(([-\d.]+)/.exec(transform)?.[1] ?? 0)
    }
  })
})
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const mount = async (enabled = true) => {
  let height = 42
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ width: 728, height }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const render = (animateResize = enabled) => root.render(<ChatComposerSurface animateResize={animateResize}><div data-composer-input-shell="">Text</div><button>Send</button></ChatComposerSurface>)
  await act(async () => render())
  return { root, host, measure, render, resize: (next: number) => { height = next; ResizeProbe.emit(host.firstElementChild!) } }
}

test('uses transform-only FLIP for the paint and text, never the action rails or layout height', async () => {
  const { host, resize, render, measure, root } = await mount()
  const paint = host.querySelector<HTMLElement>('[data-composer-material]')!
  const input = host.querySelector<HTMLElement>('[data-composer-input-shell]')!
  const reads = measure.mock.calls.length
  for (let index = 0; index < 50; index++) await act(async () => render())
  expect(measure.mock.calls.length).toBe(reads)
  expect(ResizeProbe.instances).toHaveLength(1)
  expect(motion.animate).not.toHaveBeenCalled()

  resize(82)
  expect(motion.animate).toHaveBeenNthCalledWith(1, paint, { scaleY: [42 / 82, 1] }, expect.objectContaining({ duration: 0.2 }))
  expect(motion.animate).toHaveBeenNthCalledWith(2, input, { y: [40, 0] }, expect.any(Object))
  resize(82)
  expect(motion.animate).toHaveBeenCalledTimes(2)
  paint.style.transform = 'scaleY(0.8)'
  input.style.transform = 'translateY(20px)'
  const first = motion.animate.mock.results.slice(0, 2).map(result => result.value)
  resize(102)
  expect(first.every(controls => controls.stop.mock.calls.length === 1)).toBe(true)
  expect(motion.animate).toHaveBeenNthCalledWith(3, paint, { scaleY: [82 * 0.8 / 102, 1] }, expect.any(Object))
  expect(motion.animate).toHaveBeenNthCalledWith(4, input, { y: [40, 0] }, expect.any(Object))
  expect(motion.animate.mock.calls.every(([element]) => element !== host.querySelector('button'))).toBe(true)
  await act(async () => root.unmount())
  roots.splice(roots.indexOf(root), 1)
  expect(input.style.transform).toBe('')
  expect(motion.animate.mock.results.slice(2).every(result => result.value.stop.mock.calls.length === 1)).toBe(true)
})

test('reduced motion bypasses resize animation', async () => {
  motion.reduced = true
  const { resize } = await mount()
  resize(82)
  expect(motion.animate).not.toHaveBeenCalled()
})

test('deactivation removes the observer and active transforms without moving or replacing controls', async () => {
  const { host, resize, render } = await mount()
  const input = host.querySelector<HTMLElement>('[data-composer-input-shell]')!
  const button = host.querySelector('button')!
  resize(82)
  input.style.transform = 'translateY(20px)'
  const controls = motion.animate.mock.results.map(result => result.value)
  await act(async () => render(false))
  expect(host.querySelector('[data-composer-material]')).toBeNull()
  expect(host.querySelector('button')).toBe(button)
  expect(input.style.transform).toBe('')
  expect(controls.every(control => control.stop.mock.calls.length === 1)).toBe(true)
  expect(ResizeProbe.instances.every(observer => observer.targets.size === 0)).toBe(true)
  resize(102)
  expect(motion.animate).toHaveBeenCalledTimes(2)
})

test('ordinary composer consumers retain their original material without observers', async () => {
  const { host } = await mount(false)
  expect(host.querySelector('[data-composer-material]')).toBeNull()
  expect(ResizeProbe.instances).toHaveLength(0)
})

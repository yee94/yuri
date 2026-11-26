import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { captureContactSendFlightSource, captureTextSendFlightSource, startContactSendFlight } from './contactSendFlight'

const rect = (left: number, top: number, width: number, height: number) => () => DOMRect.fromRect({ x: left, y: top, width, height })

const frames: Array<FrameRequestCallback | null> = []
const flushFrame = () => frames.splice(0).forEach((callback) => callback?.(performance.now()))
type FakeAnimation = { keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn>; finish: () => void; playing: boolean }
let animations: FakeAnimation[] = []

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = null })
  animations = []
  HTMLElement.prototype.animate = function (keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    let resolve!: () => void
    const finished = new Promise<void>((done) => { resolve = done })
    const animation: FakeAnimation = { keyframes, options, cancel: vi.fn(), finish: () => resolve(), playing: true }
    animations.push(animation)
    return {
      finished,
      cancel: animation.cancel,
      pause: () => { animation.playing = false },
      play: () => { animation.playing = true },
      effect: { setKeyframes: (next: Keyframe[]) => { animation.keyframes = next } },
    } as unknown as Animation
  } as unknown as HTMLElement['animate']
})

afterEach(() => {
  document.body.innerHTML = ''
  frames.length = 0
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate
})

const mount = () => {
  document.body.innerHTML = `
    <textarea style="padding: 12px"></textarea>
    <div data-bubble style="padding: 10px 16px; border-radius: 18px">Ship it</div>`
  const field = document.querySelector('textarea')!
  const bubble = document.querySelector<HTMLElement>('[data-bubble]')!
  field.getBoundingClientRect = rect(56, 900, 280, 48)
  bubble.getBoundingClientRect = rect(290, 600, 90, 44)
  field.value = 'Ship it'
  return { field, bubble }
}

const overlay = () => document.querySelector<HTMLElement>('[data-assistant-contact-send-flight]')
const translate = (keyframe: Keyframe) => {
  const [, x, y] = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(String(keyframe.transform)) ?? []
  return { x: Number(x), y: Number(y) }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve() }

test('flies a fixed snapshot from the composer text to the bubble on split compositor curves', async () => {
  const { field, bubble } = mount()
  const settled = vi.fn()
  startContactSendFlight(captureContactSendFlightSource(field)!, bubble, bubble, settled)
  expect(bubble.style.visibility).toBe('hidden')
  // The opaque clone covers the typed text in the mount frame, paused at the start.
  expect(overlay()).toBeTruthy()
  expect(animations[0].playing).toBe(false)

  flushFrame()
  expect(animations[0].playing).toBe(true)
  const clone = overlay()!
  expect(clone.textContent).toBe('Ship it')
  expect(clone.style.position).toBe('fixed')
  expect([clone.style.left, clone.style.top, clone.style.width, clone.style.height]).toEqual(['290px', '600px', '90px', '44px'])
  const [{ keyframes, options }] = animations
  expect(options).toMatchObject({ duration: 300, easing: 'linear' })
  // Bubble text origin (306, 610) starts on the field text origin (68, 912).
  expect(translate(keyframes[0])).toEqual({ x: 68 - 306, y: 912 - 610 })
  expect(translate(keyframes.at(-1)!)).toEqual({ x: 0, y: 0 })
  // No fade: every frame is fully visible, including the first.
  expect(keyframes.every((frame) => frame.opacity === undefined)).toBe(true)
  // Horizontal motion leads on the fast ease-out; vertical trails on the slow curve.
  const mid = translate(keyframes[keyframes.length >> 1])
  expect(1 - mid.x / (68 - 306)).toBeGreaterThan(1 - mid.y / (912 - 610))
  // Only compositor properties animate.
  expect(keyframes.every((frame) => Object.keys(frame).every((key) => ['offset', 'transform'].includes(key)))).toBe(true)

  animations[0].finish()
  await settle()
  expect(overlay()).toBeNull()
  expect(bubble.style.visibility).toBe('')
  expect(settled).toHaveBeenCalledTimes(1)
})

test('the landing slot follows a transcript scroll during the flight', () => {
  const { field, bubble } = mount()
  startContactSendFlight(captureContactSendFlightSource(field)!, bubble)
  flushFrame()
  bubble.getBoundingClientRect = rect(290, 576, 90, 44)
  document.body.dispatchEvent(new Event('scroll'))
  expect(overlay()!.style.top).toBe('576px')
})

test('stop before the first frame cancels the start; stop is idempotent', () => {
  const { field, bubble } = mount()
  const settled = vi.fn()
  const stop = startContactSendFlight(captureContactSendFlightSource(field)!, bubble, bubble, settled)
  stop()
  stop()
  flushFrame()
  expect(animations[0].playing).toBe(false)
  expect(animations[0].cancel).toHaveBeenCalled()
  expect(overlay()).toBeNull()
  expect(bubble.style.visibility).toBe('')
  expect(settled).toHaveBeenCalledTimes(1)
})

test('stop mid-flight cancels the animation and reveals the bubble', () => {
  const { field, bubble } = mount()
  const stop = startContactSendFlight(captureContactSendFlightSource(field)!, bubble)
  flushFrame()
  stop()
  expect(animations[0].cancel).toHaveBeenCalled()
  expect(overlay()).toBeNull()
  expect(bubble.style.visibility).toBe('')
})

test('a queued chip text element is a flight source; hidden or empty text is not', () => {
  document.body.innerHTML = '<span data-chip>queued</span>'
  const chip = document.querySelector<HTMLElement>('[data-chip]')!
  chip.getBoundingClientRect = rect(40, 720, 200, 20)
  expect(captureTextSendFlightSource(chip)).toEqual({ textBox: { left: 40, top: 720, width: 200, height: 20 }, text: 'queued' })
  chip.getBoundingClientRect = rect(40, 720, 0, 0)
  expect(captureTextSendFlightSource(chip)).toBeNull()
  chip.textContent = ' '
  chip.getBoundingClientRect = rect(40, 720, 200, 20)
  expect(captureTextSendFlightSource(chip)).toBeNull()
})

test('an empty field captures nothing', () => {
  const { field } = mount()
  field.value = '   '
  expect(captureContactSendFlightSource(field)).toBeNull()
})

test('re-aims before the clock starts so the start stays on the typed text after a park scroll', () => {
  const { field, bubble } = mount()
  startContactSendFlight(captureContactSendFlightSource(field)!, bubble)
  // The send-park scroll moves the bubble before the first flight frame.
  bubble.getBoundingClientRect = rect(290, 500, 90, 44)
  document.body.dispatchEvent(new Event('scroll'))
  expect(overlay()!.style.top).toBe('500px')
  expect(translate(animations[0].keyframes[0])).toEqual({ x: 68 - 306, y: 912 - 510 })
  flushFrame()
  expect(translate(animations[0].keyframes[0])).toEqual({ x: 68 - 306, y: 912 - 510 })
})

test('the flight element is a plain-text stand-in, never the rendered bubble DOM', () => {
  const { field, bubble } = mount()
  bubble.innerHTML = '<div class="markdown-content"><p>Ship <code>it</code></p></div><p aria-hidden="true">copy</p>'
  startContactSendFlight(captureContactSendFlightSource(field)!, bubble)
  const clone = overlay()!
  expect(clone.childNodes).toHaveLength(1)
  expect(clone.firstChild!.nodeType).toBe(Node.TEXT_NODE)
  expect(clone.textContent).toBe('Ship it')
})

test('composer chips travel as the labels painted in the highlight overlay', () => {
  document.body.innerHTML = `<div data-composer-input-shell><div data-composer-highlight>Fix @App.tsx now</div><textarea></textarea></div>`
  const field = document.querySelector('textarea')!
  field.value = 'Fix \u2063ref:1\u2063 now'
  field.getBoundingClientRect = rect(56, 900, 280, 48)
  expect(captureContactSendFlightSource(field)!.text).toBe('Fix @App.tsx now')
})

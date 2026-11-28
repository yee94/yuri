import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { captureContactSendFlightSource, captureTextSendFlightSource, startContactSendFlight } from './contactSendFlight'

const rect = (left: number, top: number, width: number, height: number) => () => DOMRect.fromRect({ x: left, y: top, width, height })

const frames: Array<FrameRequestCallback | null> = []
const flushFrame = () => frames.splice(0).forEach((callback) => callback?.(performance.now()))
type FakeAnimation = { keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn>; finish: () => void; playing: boolean; startTime?: number }
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
      timeline: { currentTime: 123 },
      set startTime(time: number) { animation.startTime = time },
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
const settle = async () => { await Promise.resolve(); await Promise.resolve() }

test('flies a fixed snapshot from the composer text to the bubble on split compositor curves', async () => {
  const { field, bubble } = mount()
  const settled = vi.fn()
  startContactSendFlight(captureContactSendFlightSource(field)!, bubble, bubble, settled)
  expect(bubble.style.opacity).toBe('0')
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
  expect(options).toMatchObject({ duration: 350, easing: 'linear' })
  // Bubble text origin (306, 610) starts on the field text origin (68, 912).
  expect(keyframes).toEqual([
    { offset: 0, translate: '-238px 0px', easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
    { offset: 0, transform: 'translateY(302px)', easing: expect.stringContaining('cubic-bezier(') },
    { offset: 1, translate: '0px 0px', transform: 'translateY(0px)' },
  ])

  animations[0].finish()
  await settle()
  expect(overlay()).toBeNull()
  expect(bubble.style.opacity).toBe('')
  expect(settled).toHaveBeenCalledTimes(1)
})

test('transcript scroll moves only the destination, not the flight origin', () => {
  const { field, bubble } = mount()
  startContactSendFlight(captureContactSendFlightSource(field)!, bubble)
  flushFrame()
  bubble.getBoundingClientRect = rect(290, 576, 90, 44)
  document.body.dispatchEvent(new Event('scroll'))
  expect(overlay()!.style.top).toBe('600px')
  expect(animations[0].keyframes[1].transform).toBe('translateY(302px)')
  expect(animations[0].keyframes.at(-1)?.transform).toBe('translateY(-24px)')
})

test('waits at the composer when the transcript has to bring the row up into reach', () => {
  const { field, bubble } = mount()
  bubble.getBoundingClientRect = rect(290, 1020, 90, 44)
  const stop = startContactSendFlight(captureContactSendFlightSource(field)!, bubble)
  flushFrame()
  expect(animations[0].playing).toBe(false)
  expect(animations[0].startTime).toBeUndefined()

  bubble.getBoundingClientRect = rect(290, 850, 90, 44)
  document.body.dispatchEvent(new Event('scroll'))
  expect(animations[0].playing).toBe(true)
  expect(animations[0].startTime).toBe(123)
  expect(animations[0].keyframes[1].transform).toBe('translateY(52px)')
  stop()
})

test('reveals the real row if the transcript never brings the destination into reach', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const { field, bubble } = mount()
    bubble.getBoundingClientRect = rect(290, 1020, 90, 44)
    startContactSendFlight(captureContactSendFlightSource(field)!, bubble)
    flushFrame()
    vi.runOnlyPendingTimers()
    expect(overlay()).toBeNull()
    expect(bubble.style.opacity).toBe('')
  } finally {
    vi.useRealTimers()
  }
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
  expect(bubble.style.opacity).toBe('')
  expect(settled).toHaveBeenCalledTimes(1)
})

test('stop mid-flight cancels the animation and reveals the bubble', () => {
  const { field, bubble } = mount()
  const stop = startContactSendFlight(captureContactSendFlightSource(field)!, bubble)
  flushFrame()
  stop()
  expect(animations[0].cancel).toHaveBeenCalled()
  expect(overlay()).toBeNull()
  expect(bubble.style.opacity).toBe('')
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
  expect(animations[0].keyframes[1].transform).toBe('translateY(402px)')
  flushFrame()
  expect(animations[0].keyframes[1].transform).toBe('translateY(402px)')
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

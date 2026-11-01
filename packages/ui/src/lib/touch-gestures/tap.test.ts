import { afterEach, describe, expect, test } from 'vitest'
import { DOUBLE_TAP_DISTANCE_PX, DOUBLE_TAP_MS, TAP_MAX_MS, TAP_SLOP_PX, bindDoubleTap, createTapRecognizer, isDoubleTap } from './tap'
import { lockNativeTouchPan } from './nativePan'

const pointer = (type: string, x: number, y: number, timeStamp: number, target: Element, pointerType = 'touch') => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    clientX: { value: x }, clientY: { value: y }, pointerType: { value: pointerType }, timeStamp: { value: timeStamp },
  })
  target.dispatchEvent(event)
  return event
}

describe('tap timing', () => {
  test('double tap needs a quick nearby second tap', () => {
    const first = { x: 100, y: 100, time: 0 }
    expect(isDoubleTap(first, { x: 110, y: 104, time: DOUBLE_TAP_MS - 10 })).toBe(true)
    expect(isDoubleTap(first, { x: 110, y: 104, time: DOUBLE_TAP_MS + 10 })).toBe(false)
    expect(isDoubleTap(first, { x: 100 + DOUBLE_TAP_DISTANCE_PX + 5, y: 100, time: 100 })).toBe(false)
    expect(isDoubleTap(null, first)).toBe(false)
  })

  test('a hold or a drag is not a tap, a mouse is ignored', () => {
    const recognizer = createTapRecognizer()
    const at = (x: number, y: number, timeStamp: number, pointerType = 'touch') => ({ clientX: x, clientY: y, timeStamp, pointerType })
    recognizer.down(at(10, 10, 0))
    expect(recognizer.up(at(10, 10, TAP_MAX_MS + 1))).toBe('none')
    recognizer.down(at(10, 10, 1000))
    expect(recognizer.up(at(10 + TAP_SLOP_PX + 4, 10, 1050))).toBe('none')
    recognizer.down(at(10, 10, 2000, 'mouse'))
    expect(recognizer.up(at(10, 10, 2050, 'mouse'))).toBe('none')
    recognizer.down(at(10, 10, 3000))
    expect(recognizer.up(at(10, 10, 3050))).toBe('tap')
    recognizer.down(at(12, 12, 3150))
    expect(recognizer.up(at(12, 12, 3200))).toBe('double-tap')
    recognizer.down(at(12, 12, 3250))
    expect(recognizer.up(at(12, 12, 3300))).toBe('tap')
  })
})

describe('bindDoubleTap', () => {
  let root: HTMLElement | null = null
  let dispose: (() => void) | null = null
  afterEach(() => { dispose?.(); root?.remove(); root = null; dispose = null })

  const setup = () => {
    root = document.createElement('div')
    root.innerHTML = '<p data-item="a">alpha</p><p data-item="b">beta</p><a data-item="x" href="/x">skip</a>'
    document.body.append(root)
    const hits: string[] = []
    dispose = bindDoubleTap(root, {
      resolve: (target) => (target instanceof Element ? target.closest<HTMLElement>('p[data-item]') : null),
      onDoubleTap: (el) => hits.push(el.dataset.item!),
    })
    const item = (name: string) => root!.querySelector<HTMLElement>(`[data-item="${name}"]`)!
    const tap = (el: Element, time: number, x = 20, y = 20) => {
      pointer('pointerdown', x, y, time, el)
      pointer('pointerup', x, y, time + 40, el)
    }
    return { hits, item, tap }
  }

  test('two quick taps on one element open it once', () => {
    const { hits, item, tap } = setup()
    tap(item('a'), 0)
    tap(item('a'), 150)
    expect(hits).toEqual(['a'])
  })

  test('taps on different elements, too slowly, or on skipped targets never fire', () => {
    const { hits, item, tap } = setup()
    tap(item('a'), 0)
    tap(item('b'), 150)
    tap(item('a'), 1000)
    tap(item('a'), 1000 + DOUBLE_TAP_MS + 100)
    tap(item('x'), 3000)
    tap(item('x'), 3100)
    expect(hits).toEqual([])
  })

  test('Android may pointercancel mid-tap; the native dblclick still opens it exactly once', () => {
    const { hits, item } = setup()
    pointer('pointerdown', 20, 20, 0, item('a'))
    pointer('pointercancel', 20, 20, 30, item('a'))
    const dbl = new MouseEvent('dblclick', { bubbles: true, cancelable: true })
    item('a').dispatchEvent(dbl)
    expect(dbl.defaultPrevented).toBe(true)
    expect(hits).toEqual(['a'])
  })

  test('the pointer path and the following native dblclick never double-fire', () => {
    const { hits, item, tap } = setup()
    tap(item('a'), 0)
    tap(item('a'), 150)
    item('a').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(hits).toEqual(['a'])
  })

  test('cleanup removes every listener', () => {
    const { hits, item, tap } = setup()
    dispose!()
    dispose = null
    tap(item('a'), 0)
    tap(item('a'), 150)
    item('a').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(hits).toEqual([])
  })
})

describe('lockNativeTouchPan', () => {
  test('cancels native touch panning only while bound', () => {
    const element = document.createElement('div')
    const dispose = lockNativeTouchPan(element)
    const move = new Event('touchmove', { cancelable: true })
    element.dispatchEvent(move)
    expect(move.defaultPrevented).toBe(true)
    expect(() => element.dispatchEvent(new Event('touchmove', { cancelable: false }))).not.toThrow()
    dispose()
    const after = new Event('touchmove', { cancelable: true })
    element.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })
})

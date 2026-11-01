import { describe, expect, test } from 'vitest'
import {
  CONTACT_DOUBLE_TAP_MS,
  CONTACT_TAP_SLOP_PX,
  createContactDoubleTapDetector,
  isContactReadingTapTarget,
} from './contactMessageGesture'

const bubble = (html: string) => {
  const node = document.createElement('div')
  node.setAttribute('data-assistant-contact-text', '')
  node.innerHTML = html
  document.body.append(node)
  return node
}

describe('contact reading gestures', () => {
  test('a tap only reads ordinary bubble text', () => {
    const node = bubble('<p>hello <a href="https://example.com">link</a></p><code>x</code><img alt=""></div>')
    const paragraph = node.querySelector('p')!
    expect(isContactReadingTapTarget(paragraph)).toBe(true)
    expect(isContactReadingTapTarget(node.querySelector('a'))).toBe(false)
    expect(isContactReadingTapTarget(node.querySelector('code'))).toBe(false)
    expect(isContactReadingTapTarget(node.querySelector('img'))).toBe(false)
    expect(isContactReadingTapTarget(document.body)).toBe(false)
  })

  test('image-only bubbles never qualify', () => {
    const node = bubble('<p>caption</p>')
    node.setAttribute('data-assistant-contact-media', '')
    expect(isContactReadingTapTarget(node.querySelector('p'))).toBe(false)
  })

  test('double tap needs two nearby taps on the same code path', () => {
    const node = bubble('<p>read me</p>')
    const target = node.querySelector('p')!
    const opened: HTMLElement[] = []
    const detector = createContactDoubleTapDetector((b) => opened.push(b))
    expect(detector.register({ x: 10, y: 10, t: 0 }, target)).toBe(false)
    expect(detector.register({ x: 12, y: 14, t: CONTACT_DOUBLE_TAP_MS - 20 }, target)).toBe(true)
    expect(opened).toEqual([node])
    // The counter resets, so a third quick tap does not open again.
    expect(detector.register({ x: 12, y: 14, t: CONTACT_DOUBLE_TAP_MS }, target)).toBe(false)
  })

  test('slow, distant or non-text taps do not open the reader', () => {
    const node = bubble('<p>read me</p><a href="/x">link</a>')
    const paragraph = node.querySelector('p')!
    const opened: HTMLElement[] = []
    const detector = createContactDoubleTapDetector((b) => opened.push(b))
    detector.register({ x: 10, y: 10, t: 0 }, paragraph)
    expect(detector.register({ x: 10, y: 10, t: CONTACT_DOUBLE_TAP_MS + 100 }, paragraph)).toBe(false)
    detector.register({ x: 10, y: 10, t: 1000 }, paragraph)
    expect(detector.register({ x: 10 + CONTACT_TAP_SLOP_PX + 5, y: 10, t: 1050 }, paragraph)).toBe(false)
    detector.register({ x: 10, y: 10, t: 2000 }, node.querySelector('a'))
    expect(detector.register({ x: 10, y: 10, t: 2050 }, node.querySelector('a'))).toBe(false)
    expect(opened).toEqual([])
  })
})

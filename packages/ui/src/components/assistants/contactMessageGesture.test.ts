import { describe, expect, test } from 'vitest'
import { resolveContactReadingBubble } from './contactMessageGesture'

const bubble = (html: string, media = false) => {
  const node = document.createElement('div')
  node.setAttribute('data-assistant-contact-text', '')
  if (media) node.setAttribute('data-assistant-contact-media', '')
  node.innerHTML = html
  document.body.append(node)
  return node
}

describe('contact reading eligibility', () => {
  test('ordinary text resolves to its bubble', () => {
    const node = bubble('<p>hello</p>')
    expect(resolveContactReadingBubble(node.querySelector('p'))).toBe(node)
    expect(resolveContactReadingBubble(node)).toBe(node)
  })

  test('links, code, images, video and non-bubble targets keep their own behavior', () => {
    const node = bubble('<a href="/x">link</a><code>x</code><img alt=""><video></video>')
    for (const selector of ['a', 'code', 'img', 'video']) expect(resolveContactReadingBubble(node.querySelector(selector))).toBeNull()
    expect(resolveContactReadingBubble(document.body)).toBeNull()
    expect(resolveContactReadingBubble(null)).toBeNull()
  })

  test('image-only bubbles never open the reader', () => {
    const node = bubble('<p>caption</p>', true)
    expect(resolveContactReadingBubble(node.querySelector('p'))).toBeNull()
  })
})

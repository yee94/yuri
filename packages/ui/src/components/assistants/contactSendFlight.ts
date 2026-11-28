/**
 * Send transition after Telegram-iOS `ChatMessageTransitionNode` (text input →
 * bubble, default bezier parameters): the bubble starts with its text over the
 * composer's typed text and travels to its transcript slot, with horizontal and
 * vertical motion on separate curves.
 *
 * The moving element is a fixed-size snapshot of the real bubble animated with
 * a compositor-only Web Animation (transform + opacity). No frame reads layout
 * or writes size, so a busy main thread cannot drop flight frames, and the
 * landing frame is the real bubble at its integer layout position.
 */
export const CONTACT_SEND_FLIGHT_DURATION_S = 0.35
export const CONTACT_SEND_FLIGHT_VERTICAL_EASE = [0.19919472913616398, 0.010644531250000006, 0.27920937042459737, 0.91025390625] as const
const HORIZONTAL_EASE = 'cubic-bezier(0.23, 1, 0.32, 1)'
const VERTICAL_EASE = `cubic-bezier(${CONTACT_SEND_FLIGHT_VERTICAL_EASE.join(', ')})`
const LANDING_WAIT_MS = 600

type Box = { left: number; top: number; width: number; height: number }

/** Composer text geometry and plain text, captured synchronously before the draft clears. */
export type ContactSendFlightSource = {
  textBox: Box
  text: string
}

const px = (value: string) => Number.parseFloat(value) || 0
const contentBox = (element: HTMLElement, rect = element.getBoundingClientRect()): Box => {
  const style = window.getComputedStyle(element)
  const left = rect.left + px(style.borderLeftWidth) + px(style.paddingLeft)
  const top = rect.top + px(style.borderTopWidth) + px(style.paddingTop)
  return {
    left,
    top,
    width: rect.right - px(style.borderRightWidth) - px(style.paddingRight) - left,
    height: rect.bottom - px(style.borderBottomWidth) - px(style.paddingBottom) - top,
  }
}

export const captureContactSendFlightSource = (field: HTMLTextAreaElement): ContactSendFlightSource | null => {
  if (!field.value.trim()) return null
  const textBox = contentBox(field)
  // Reference composers paint chips as labels in a highlight overlay; that is the text the user saw.
  const painted = field.closest('[data-composer-input-shell]')?.querySelector<HTMLElement>('[data-composer-highlight]')
  const text = (painted?.textContent?.trim() ? painted.textContent : field.value).trim()
  // The field's own scroll offset (Telegram `scrollOffset`) shifts its visible text up.
  return { textBox: { ...textBox, top: textBox.top - field.scrollTop }, text }
}

/** Source for text painted by an ordinary element, such as a queued-message chip. */
export const captureTextSendFlightSource = (element: HTMLElement): ContactSendFlightSource | null => {
  if (!element.isConnected || !element.textContent?.trim()) return null
  const textBox = contentBox(element)
  return textBox.width > 0 && textBox.height > 0 ? { textBox, text: element.textContent.trim() } : null
}

const BOX_STYLES = [
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
] as const
const TEXT_STYLES = ['color', 'font-family', 'font-size', 'font-weight', 'font-feature-settings', 'letter-spacing', 'line-height'] as const

/**
 * A plain stand-in for the bubble: one div with its shape, fill and type, and
 * the sent text as a single text node. Nothing Markdown, chip or measurement
 * related travels, so the flight element costs one paint.
 */
const proxy = (bubble: HTMLElement, rect: DOMRect, text: string): HTMLElement => {
  const style = window.getComputedStyle(bubble)
  // Contact bubbles paint their fill through an SVG outline; session bubbles use background-color.
  const outline = bubble.querySelector('.yuri-contact-bubble-outline path')
  const fill = outline ? window.getComputedStyle(outline).fill : style.backgroundColor
  // Rendered bodies can set their own type scale below the bubble.
  const firstText = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  }).nextNode()
  const typeStyle = window.getComputedStyle(firstText?.parentElement ?? bubble)
  const clone = document.createElement('div')
  for (const name of BOX_STYLES) clone.style.setProperty(name, style.getPropertyValue(name))
  for (const name of TEXT_STYLES) clone.style.setProperty(name, typeStyle.getPropertyValue(name))
  clone.textContent = text
  Object.assign(clone.style, {
    backgroundColor: fill,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    overflow: 'hidden',
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0px',
    maxWidth: 'none',
    boxSizing: 'border-box',
    zIndex: '60',
    pointerEvents: 'none',
    visibility: 'visible',
    willChange: 'transform',
  })
  clone.setAttribute('aria-hidden', 'true')
  clone.setAttribute('inert', '')
  clone.setAttribute('data-assistant-contact-send-flight', '')
  return clone
}

// Separate transform properties let the browser ease each axis on one shared clock.
const flightKeyframes = (dx: number, dy: number, landingY = 0): Keyframe[] => [
  { offset: 0, translate: `${dx}px 0px`, easing: HORIZONTAL_EASE },
  { offset: 0, transform: `translateY(${dy}px)`, easing: VERTICAL_EASE },
  { offset: 1, translate: '0px 0px', transform: `translateY(${landingY}px)` },
]

/**
 * Flies `bubble` out of the captured composer text. The real bubble keeps its
 * layout and stays hidden while its snapshot travels, so the transcript scroll
 * owner remains the only scroll writer. The opaque snapshot covers the typed
 * text in the mount frame; the clock starts on the next frame, after re-aiming
 * at wherever the scroll owner settled the bubble. Later transcript scrolls
 * retarget the destination without shifting the whole flight path.
 * Returns an idempotent stop that removes the snapshot and reveals the bubble.
 */
export const startContactSendFlight = (
  source: ContactSendFlightSource,
  bubble: HTMLElement,
  hidden: HTMLElement = bubble,
  onSettled?: () => void,
): (() => void) => {
  let stopped = false
  let playing = false
  let startFrame = 0
  let landingWait: ReturnType<typeof setTimeout> | undefined
  let clone: HTMLElement | null = null
  let animation: Animation | null = null
  let origin: { top: number; dx: number; dy: number } | null = null
  let landingY = 0
  const stop = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(startFrame)
    clearTimeout(landingWait)
    window.removeEventListener('scroll', follow, true)
    animation?.cancel()
    clone?.remove()
    hidden.style.opacity = ''
    onSettled?.()
  }
  // Anchor the clone on the bubble's current slot and start the path on the
  // composer text. Returns false when there is nowhere to fly.
  const aim = (): boolean => {
    const rect = bubble.getBoundingClientRect()
    const target = contentBox(bubble, rect)
    const dx = source.textBox.left - target.left
    const dy = source.textBox.top - target.top
    if (!dx && !dy) return false
    origin = { top: rect.top, dx, dy }
    clone!.style.left = `${rect.left}px`
    clone!.style.top = `${rect.top}px`
    const keyframes = flightKeyframes(dx, dy)
    const effect = animation?.effect as KeyframeEffect | null | undefined
    if (effect?.setKeyframes) effect.setKeyframes(keyframes)
    else {
      animation?.cancel()
      animation = clone!.animate(keyframes, {
        duration: CONTACT_SEND_FLIGHT_DURATION_S * 1000,
        easing: 'linear',
        fill: 'both',
      })
      animation.finished.then(stop, () => undefined)
    }
    return true
  }

  const startWhenReachable = () => {
    if (stopped) return
    if (!bubble.isConnected || !aim()) { stop(); return }
    // A send from history can mount the destination below the composer.
    // Hold at the source until scrolling can carry the flight upward.
    if (source.textBox.top >= 0 && origin!.dy < 0) {
      landingWait ??= setTimeout(stop, LANDING_WAIT_MS)
      return
    }
    clearTimeout(landingWait)
    landingWait = undefined
    playing = true
    const flight = animation!
    flight.play()
    // Scroll can update keyframes again before a deferred play task commits.
    // Start on the timeline now so those updates cannot postpone lift-off.
    const time = flight.timeline?.currentTime
    if (typeof time === 'number') flight.startTime = time
  }

  // A moving destination contributes only in proportion to the flight's progress.
  // Moving the fixed layer itself would apply the entire scroll delta even at t=0.
  function follow(event: Event) {
    if (event.target instanceof Node && !event.target.contains(bubble)) return
    if (!playing) {
      if (landingWait === undefined) aim()
      else startWhenReachable()
      return
    }
    const effect = animation?.effect as KeyframeEffect | null | undefined
    if (!origin || !effect?.setKeyframes) return
    const nextLandingY = bubble.getBoundingClientRect().top - origin.top
    if (nextLandingY === landingY) return
    landingY = nextLandingY
    effect.setKeyframes(flightKeyframes(origin.dx, origin.dy, landingY))
  }

  // Not `visibility`: iOS WebKit repaints a bubble revealed that way as an unpadded,
  // square box for about a second after landing.
  hidden.style.opacity = '0'
  if (!bubble.isConnected || typeof bubble.animate !== 'function') {
    stop()
    return stop
  }
  // The clone replaces the cleared field text in the mount frame, fully opaque,
  // so the bubble is visibly leaving the composer rather than appearing mid-air.
  clone = proxy(bubble, bubble.getBoundingClientRect(), source.text)
  document.body.appendChild(clone)
  if (!aim()) {
    stop()
    return stop
  }
  animation!.pause()
  window.addEventListener('scroll', follow, { capture: true, passive: true })
  // The send commit that mounted the bubble usually stalls the next frame; start
  // the clock there so the stall cannot consume progress. Re-aim first: the
  // send-park scroll may have moved the landing slot since mount.
  startFrame = requestAnimationFrame(startWhenReachable)
  return stop
}

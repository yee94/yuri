import React from 'react'
import { useEvent, useResizeObserver } from '@reactuses/core'
import { cn } from '@/lib/utils'
import './contact-message-bubble.css'

type ContactMessageBubbleProps = {
  children: React.ReactNode
  outgoing: boolean
  joinedBefore: boolean
  joinedAfter: boolean
  createdAt: number
  time: string
  media?: boolean
  mobile: boolean
  hidden?: boolean
  colors?: { background: string; foreground: string }
  label?: string
}

export function ContactMessageBubble({ children, outgoing, joinedBefore, joinedAfter, createdAt, time, media, mobile, hidden, colors, label }: ContactMessageBubbleProps) {
  const bubbleRef = React.useRef<HTMLDivElement>(null)
  const outlineRef = React.useRef<SVGSVGElement>(null)
  const pathRef = React.useRef<SVGPathElement>(null)
  const drawOutline = useEvent(() => {
    const bubble = bubbleRef.current
    const outline = outlineRef.current
    const path = pathRef.current
    if (!bubble || !outline || !path || media) return
    const { width: w, height: h } = bubble.getBoundingClientRect()
    if (!w || !h) return
    const style = window.getComputedStyle(bubble)
    const radius = (value: string) => Math.min(Number.parseFloat(value) || 0, w / 2, h / 2)
    const tl = radius(style.borderTopLeftRadius)
    const tr = radius(style.borderTopRightRadius)
    const bl = radius(style.borderBottomLeftRadius)
    const br = radius(style.borderBottomRightRadius)
    const x = 8
    const right = x + w
    const bottomRight = outgoing && !joinedAfter
      ? `V ${h - 10} C ${right} ${h - 5} ${right + 3} ${h - 1} ${right + 8} ${h}`
      : `V ${h - br} A ${br} ${br} 0 0 1 ${right - br} ${h}`
    const bottomLeft = !outgoing && !joinedAfter
      ? `H 0 C 5 ${h - 1} ${x} ${h - 5} ${x} ${h - 10}`
      : `H ${x + bl} A ${bl} ${bl} 0 0 1 ${x} ${h - bl}`
    outline.setAttribute('viewBox', `0 0 ${w + 16} ${h}`)
    // Body and tail are one closed silhouette, with no overlapping seam.
    path.setAttribute('d', `M ${x + tl} 0 H ${right - tr} A ${tr} ${tr} 0 0 1 ${right} ${tr} ${bottomRight} ${bottomLeft} V ${tl} A ${tl} ${tl} 0 0 1 ${x + tl} 0 Z`)
  })
  React.useLayoutEffect(() => {
    drawOutline()
  }, [outgoing, joinedBefore, joinedAfter, mobile, media, drawOutline])
  useResizeObserver(typeof ResizeObserver !== 'undefined' && !media ? bubbleRef : null, drawOutline)
  return (
    <div
      ref={bubbleRef}
      aria-label={label}
      data-assistant-contact-text=""
      data-assistant-contact-media={media || undefined}
      data-contact-bubble-direction={outgoing ? 'outgoing' : 'incoming'}
      data-contact-bubble-joined-before={joinedBefore || undefined}
      data-contact-bubble-joined-after={joinedAfter || undefined}
      className={cn('yuri-contact-bubble min-w-0 max-w-full [overflow-wrap:anywhere]', mobile && !media && 'touch-manipulation [-webkit-user-select:all] [user-select:all]')}
      style={{ '--contact-bubble-fill': colors?.background, color: colors?.foreground, visibility: hidden ? 'hidden' : undefined } as React.CSSProperties}
    >
      {!media ? <svg ref={outlineRef} className="yuri-contact-bubble-outline" aria-hidden="true" preserveAspectRatio="none"><path ref={pathRef} /></svg> : null}
      <div className="yuri-contact-bubble-body" data-assistant-contact-body="">{children}</div>
      {!media ? <>
        <span aria-hidden="true" className="yuri-contact-bubble-time-space">{time}</span>
        <time className="yuri-contact-bubble-time" dateTime={new Date(createdAt).toISOString()}>{time}</time>
      </> : null}
    </div>
  )
}

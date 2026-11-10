import React from 'react';
import { animate } from 'motion/mini';
import { useReducedMotion } from 'motion/react';
import type { TextNode } from 'markstream-react';
import { cn } from '@/lib/utils';
import { useMarkstreamHostContext } from './markstreamHostContext';

const MAX_GROUPS = 24;
const GRAPHEMES_PER_GROUP = 4;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// This leaf owns its text DOM, like Markstream's TextNode. React keeps the
// initial child stable; token updates append only the new suffix in layout.
export function MotionStreamText({ node }: React.ComponentProps<typeof TextNode>) {
  const host = useMarkstreamHostContext();
  const reducedMotion = useReducedMotion();
  const enabled = host.isStreaming && !host.disableStreamAnimation && !reducedMotion;
  const content = node.content ?? '';
  const initial = React.useRef(content);
  const source = React.useRef(content);
  const element = React.useRef<HTMLSpanElement>(null);
  const pending = React.useRef(new Map<HTMLSpanElement, ReturnType<typeof animate>>());

  React.useLayoutEffect(() => {
    const root = element.current;
    if (!root) return;
    const finish = (span: HTMLSpanElement) => {
      pending.current.delete(span);
      if (span.parentNode !== root) return;
      span.replaceWith(document.createTextNode(span.textContent ?? ''));
      root.normalize();
    };
    const settle = () => {
      for (const [span, controls] of pending.current) {
        controls.stop();
        finish(span);
      }
    };
    if (!enabled || !content.startsWith(source.current)) {
      settle();
      root.textContent = content;
      source.current = content;
      return;
    }
    const delta = content.slice(source.current.length);
    source.current = content;
    if (!delta) return;

    // Bound animation work even when the provider delivers a large burst.
    // Settled text is never re-split or reanimated, and spans stay inline so
    // wrapping/kerning never changes when the stream finishes.
    const graphemes = Array.from(segmenter.segment(delta), (part) => part.segment);
    const animatedStart = Math.max(0, graphemes.length - MAX_GROUPS * GRAPHEMES_PER_GROUP);
    const groups: string[] = [];
    for (let index = animatedStart; index < graphemes.length; index += GRAPHEMES_PER_GROUP) {
      groups.push(graphemes.slice(index, index + GRAPHEMES_PER_GROUP).join(''));
    }
    if (pending.current.size + groups.length > MAX_GROUPS) settle();
    if (animatedStart > 0) root.appendChild(document.createTextNode(graphemes.slice(0, animatedStart).join('')));
    groups.forEach((text, index) => {
      const span = document.createElement('span');
      span.dataset.motionStreamChunk = '';
      span.textContent = text;
      span.style.opacity = '0';
      root.appendChild(span);
      const controls = animate([span], { opacity: [0, 1] }, {
        duration: 0.16,
        delay: Math.min(index * 0.008, 0.08),
        ease: 'easeOut',
      });
      pending.current.set(span, controls);
      void controls.then(() => finish(span));
    });
  }, [content, enabled]);

  React.useLayoutEffect(() => {
    const animations = pending.current;
    return () => {
      for (const controls of animations.values()) controls.stop();
      animations.clear();
    };
  }, []);

  return <span ref={element} className={cn('text-node whitespace-pre-wrap break-words', node.center && 'text-node-center')}>{initial.current}</span>;
}

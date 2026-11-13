import React from 'react';
import { animate, useReducedMotion } from 'motion/react';
import { useResizeObserver } from '@reactuses/core';
import { cn } from '@/lib/utils';

type ChatComposerSurfaceProps = React.HTMLAttributes<HTMLDivElement> & {
  expanded?: boolean;
  animateResize?: boolean;
};

const materialClassName = 'border border-[color-mix(in_srgb,var(--interactive-border)_50%,transparent)] dark:border-transparent bg-[var(--surface-background)] shadow-[0_2px_6px_-3px_color-mix(in_srgb,var(--surface-foreground)_4%,transparent),inset_0_1px_0_var(--yuri-mobile-glass-highlight)] transition-colors duration-150 motion-reduce:transition-none dark:bg-[color-mix(in_srgb,var(--surface-background),var(--surface-foreground)_8%)] dark:shadow-none';

const ComposerResizeMaterial = React.memo(function ComposerResizeMaterial() {
  const ref = React.useRef<HTMLDivElement>(null);
  const heightRef = React.useRef(0);
  const animationsRef = React.useRef<Array<{ stop: () => void }>>([]);
  const reduced = useReducedMotion();
  const target = React.useMemo(() => () => ref.current?.parentElement, []);
  useResizeObserver(typeof ResizeObserver !== 'undefined' ? target : null, () => {
    const paint = ref.current;
    const surface = paint?.parentElement;
    if (!paint || !surface) return;
    const height = surface.getBoundingClientRect().height;
    const previous = heightRef.current;
    if (!height || Math.abs(height - previous) < 0.5) return;
    heightRef.current = height;
    const input = surface.querySelector<HTMLElement>('[data-composer-input-shell]');
    const scale = new DOMMatrixReadOnly(window.getComputedStyle(paint).transform).m22;
    const offset = input ? new DOMMatrixReadOnly(window.getComputedStyle(input).transform).m42 : 0;
    animationsRef.current.forEach((animation) => animation.stop());
    animationsRef.current = [];
    if (!previous || reduced) {
      paint.style.transform = '';
      if (input) input.style.transform = '';
      return;
    }
    // FLIP only the paint and translate the text: no per-frame height layout,
    // scaled glyphs, React state, or motion on the bottom-aligned action rails.
    const options = { duration: 0.2, ease: 'easeOut' as const };
    animationsRef.current.push(animate(paint, { scaleY: [previous * scale / height, 1] }, options));
    if (input) animationsRef.current.push(animate(input, { y: [height - previous + offset, 0] }, options));
  });
  React.useLayoutEffect(() => {
    const paint = ref.current;
    const surface = paint?.parentElement;
    heightRef.current = surface?.getBoundingClientRect().height ?? 0;
    return () => {
      animationsRef.current.forEach((animation) => animation.stop());
      if (paint) paint.style.transform = '';
      const input = surface?.querySelector<HTMLElement>('[data-composer-input-shell]');
      if (input) input.style.transform = '';
    };
  }, []);
  React.useLayoutEffect(() => {
    if (!reduced) return;
    animationsRef.current.forEach((animation) => animation.stop());
    animationsRef.current = [];
    if (ref.current) ref.current.style.transform = '';
    const input = ref.current?.parentElement?.querySelector<HTMLElement>('[data-composer-input-shell]');
    if (input) input.style.transform = '';
  }, [reduced]);
  return <div ref={ref} aria-hidden="true" data-composer-material=""
    className={cn('pointer-events-none absolute -inset-px -z-10', materialClassName, 'dark:group-hover/composer:bg-[color-mix(in_srgb,var(--surface-background),var(--surface-foreground)_11%)] dark:group-focus-within/composer:bg-[color-mix(in_srgb,var(--surface-background),var(--surface-foreground)_11%)]')}
    style={{ borderRadius: 'inherit', transformOrigin: '50% 100%' }} />;
});

export const ChatComposerSurface = React.forwardRef<HTMLDivElement, ChatComposerSurfaceProps>(({
  children,
  className,
  expanded = false,
  animateResize = false,
  style,
  ...props
}, ref) => (
  <div
    ref={ref}
    className={cn(
      'relative flex flex-col overflow-visible',
      animateResize ? 'group/composer isolate border border-transparent' : cn(materialClassName, 'dark:hover:bg-[color-mix(in_srgb,var(--surface-background),var(--surface-foreground)_11%)] dark:focus-within:bg-[color-mix(in_srgb,var(--surface-background),var(--surface-foreground)_11%)]'),
      expanded && 'min-h-0 flex-1',
      className,
    )}
    style={{
      borderRadius: 'var(--radius-xl)',
      ...style,
    }}
    {...props}
    data-composer-animated-resize={animateResize || undefined}
  >
    {animateResize ? <ComposerResizeMaterial /> : null}
    {children}
  </div>
));

ChatComposerSurface.displayName = 'ChatComposerSurface';

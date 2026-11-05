import React from 'react';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

interface CommitInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  hasTouchInput?: boolean;
  isMobile?: boolean;
  compact?: boolean;
}

const MIN_HEIGHT = 38; // Single line height
const DESKTOP_MIN_HEIGHT = 68; // Larger baseline for the desktop commit box
const MAX_HEIGHT = 200;

export const CommitInput: React.FC<CommitInputProps> = ({
  value,
  onChange,
  placeholder,
  disabled = false,
  hasTouchInput = false,
  isMobile = false,
  compact = false,
}) => {
  const { t } = useI18n();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const dragRef = React.useRef<{ pointerId: number; startY: number; height: number } | null>(null);
  const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);
  const minimumHeight = !isMobile && !compact ? DESKTOP_MIN_HEIGHT : MIN_HEIGHT;

  // Auto-resize based on content (layout phase to avoid mount flicker)
  React.useLayoutEffect(() => {
    if (!isMobile) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const hadFocus = document.activeElement === textarea;

    const resize = () => {
      // Reset to baseline to measure content height from a stable line.
      textarea.style.height = `${minimumHeight}px`;
      const contentHeight = textarea.scrollHeight;
      const newHeight = Math.min(Math.max(contentHeight, minimumHeight), MAX_HEIGHT);
      textarea.style.height = `${newHeight}px`;
      textarea.style.overflowY = contentHeight > MAX_HEIGHT ? 'auto' : 'hidden';

      if (contentHeight > MAX_HEIGHT && !hadFocus) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    };

    resize();
    const frameId = window.requestAnimationFrame(resize);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isMobile, minimumHeight, value]);

  const finishResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizeTo = (height: number, handle: HTMLDivElement) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const nextHeight = Math.max(minimumHeight, height);
    textarea.style.height = `${nextHeight}px`;
    handle.setAttribute('aria-valuenow', String(Math.round(nextHeight)));
  };

  const input = (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? t('gitView.commit.messagePlaceholder')}
      rows={1}
      disabled={disabled}
      autoCorrect={hasTouchInput ? 'on' : 'off'}
      autoCapitalize={hasTouchInput ? 'sentences' : 'off'}
      spellCheck={isMobile || inputSpellcheckEnabled}
      className={cn(
        'block w-full resize-none outline-none text-foreground placeholder:text-muted-foreground',
        compact ? [
          'appearance-none rounded-md px-2 py-1.5 text-xs leading-4',
          'bg-[color-mix(in_srgb,var(--surface-foreground)_2%,var(--background))]',
          'ring-1 ring-inset ring-border/60 transition-[background-color,box-shadow] duration-200 ease-out',
          'hover:[&:not(:focus)]:bg-[color-mix(in_srgb,var(--surface-foreground)_4%,var(--background))] hover:[&:not(:focus)]:ring-transparent',
          'focus:ring-1 focus:ring-[var(--interactive-focus-ring)] focus-visible:outline-none',
        ] : [
          'border border-border/60 bg-surface-elevated rounded-lg px-3 py-2 typography-ui-label',
          'transition-[border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
        ],
        disabled && 'opacity-50'
      )}
      style={{
        height: isMobile ? undefined : minimumHeight,
        minHeight: minimumHeight,
        maxHeight: isMobile ? MAX_HEIGHT : undefined,
        overflowY: isMobile ? undefined : 'auto',
      }}
    />
  );

  if (isMobile) return input;

  return (
    <div className="relative min-w-0">
      {input}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('textarea.resizeHandleAria')}
        aria-valuemin={minimumHeight}
        aria-valuenow={minimumHeight}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        className={cn(
          'absolute inset-x-0 top-0 z-10 h-2 -translate-y-1/2 cursor-ns-resize touch-none select-none rounded-sm',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)]',
          disabled && 'pointer-events-none'
        )}
        onPointerDown={(event) => {
          if (disabled || dragRef.current || !event.isPrimary || event.button !== 0) return;
          const textarea = textareaRef.current;
          if (!textarea) return;
          dragRef.current = {
            pointerId: event.pointerId,
            startY: event.clientY,
            height: textarea.getBoundingClientRect().height,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (disabled || !drag || drag.pointerId !== event.pointerId) return;
          resizeTo(drag.height + drag.startY - event.clientY, event.currentTarget);
        }}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onKeyDown={(event) => {
          if (disabled || !['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
          event.preventDefault();
          const height = parseFloat(textareaRef.current?.style.height ?? '') || minimumHeight;
          resizeTo(event.key === 'Home' ? minimumHeight : height + (event.key === 'ArrowUp' ? 10 : -10), event.currentTarget);
        }}
      />
    </div>
  );
};

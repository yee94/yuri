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
  const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);
  const minimumHeight = compact ? 64 : MIN_HEIGHT;

  // Auto-resize based on content (layout phase to avoid mount flicker)
  React.useLayoutEffect(() => {
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
  }, [minimumHeight, value]);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? t('gitView.commit.messagePlaceholder')}
      rows={compact ? 3 : 1}
      disabled={disabled}
      autoCorrect={hasTouchInput ? 'on' : 'off'}
      autoCapitalize={hasTouchInput ? 'sentences' : 'off'}
      spellCheck={isMobile || inputSpellcheckEnabled}
      className={cn(
        'w-full resize-none outline-none text-foreground placeholder:text-muted-foreground',
        compact ? [
          'appearance-none rounded-md px-2 py-1.5 text-xs leading-4',
          'bg-[color-mix(in_srgb,var(--surface-foreground)_2%,var(--background))]',
          'ring-1 ring-inset ring-border/60 transition duration-200 ease-out',
          'hover:[&:not(:focus)]:bg-[color-mix(in_srgb,var(--surface-foreground)_4%,var(--background))] hover:[&:not(:focus)]:ring-transparent',
          'focus:ring-1 focus:ring-[var(--interactive-focus-ring)] focus-visible:outline-none',
        ] : [
          'border border-border/60 bg-surface-elevated rounded-lg px-3 py-2 typography-ui-label',
          'transition-[border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
        ],
        disabled && 'opacity-50'
      )}
      style={{ minHeight: minimumHeight, maxHeight: MAX_HEIGHT }}
    />
  );
};

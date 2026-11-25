import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useLeaderKeyStore } from '@/stores/useLeaderKeyStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';
import { Kbd, ShortcutKbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';

const LEADER_ACTIONS = [
  { key: 'M', labelKey: 'chat.leaderKey.action.model' as const },
  { key: 'A', labelKey: 'chat.leaderKey.action.agent' as const },
  { key: 'N', labelKey: 'chat.leaderKey.action.newSession' as const },
  { key: 'C', labelKey: 'chat.leaderKey.action.compact' as const },
] as const;

/**
 * Subtle pending-state chrome for the Ctrl+X leader chord.
 * Renders above the composer while waiting for M / A / N / C (plus P / B on new-session drafts).
 */
export const LeaderKeyHint: React.FC<{
  className?: string;
  showProjectAction?: boolean;
  showBranchAction?: boolean;
}> = ({ className, showProjectAction = false, showBranchAction = false }) => {
  const { t } = useI18n();
  const pending = useLeaderKeyStore((state) => state.pending);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const leaderLabel = formatShortcutForDisplay(
    getEffectiveShortcutCombo('leader_key', shortcutOverrides) || 'ctrl+x',
  );

  if (!pending) {
    return null;
  }

  const actions = [
    ...LEADER_ACTIONS,
    ...(showProjectAction ? [{ key: 'P', labelKey: 'chat.leaderKey.action.project' as const }] : []),
    ...(showBranchAction ? [{ key: 'B', labelKey: 'chat.leaderKey.action.branch' as const }] : []),
  ];

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t('chat.leaderKey.pendingAria')}
      className={cn(
        'pointer-events-none absolute left-1/2 top-0 z-20 -translate-x-1/2 -translate-y-[calc(100%+0.4rem)]',
        'inline-flex max-w-[calc(100cqw-1rem)] items-center gap-2 overflow-x-auto rounded-lg border px-2.5 py-1.5',
        'border-[var(--interactive-border)] bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)]',
        'shadow-sm animate-in fade-in-0 zoom-in-95 duration-150 whitespace-nowrap',
        className,
      )}
    >
      <ShortcutKbd
        shortcut={leaderLabel}
        className="opacity-[0.35] [&_[data-slot=kbd]]:rounded-md [&_[data-slot=kbd]]:border-0 [&_[data-slot=kbd]]:bg-[color-mix(in_srgb,var(--surface-foreground)_6%,transparent)] [&_[data-slot=kbd]]:text-muted-foreground/65 [&_[data-slot=kbd]]:shadow-none"
      />
      <span className="typography-micro text-[var(--surface-muted-foreground)]">·</span>
      {actions.map((action, index) => (
        <React.Fragment key={action.key}>
          {index > 0 ? (
            <span className="typography-micro text-[var(--surface-muted-foreground)]">·</span>
          ) : null}
          <span className="inline-flex items-center gap-1 typography-micro">
            <Kbd className="rounded-md border-0 bg-[color-mix(in_srgb,var(--surface-foreground)_6%,transparent)] text-muted-foreground/65 shadow-none">
              {action.key}
            </Kbd>
            <span className="text-[var(--surface-muted-foreground)]">{t(action.labelKey)}</span>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
};

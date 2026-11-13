import React from 'react';
import { loadBrandDisplayFont } from '@/lib/fontLoader';
import { useSidebarBrandStore } from '@/stores/useSidebarBrandStore';
import { cn } from '@/lib/utils';
import { YuriWordmark } from '@/components/ui/YuriWordmark';
import { YuriLogo } from '@/components/ui/YuriLogo';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

/**
 * Left-sidebar wordmark.
 *
 * Placement:
 * - Web: titlebar control row while the sidebar is open
 * - Electron (configured brand): fixed header above the sidebar scroll region,
 *   so the mark does not scroll with sessions
 * - Electron (empty brand): not rendered; no empty slot is reserved
 * - Mobile: leading sidebar content (scrollable)
 *
 * Each standalone Yuri word uses the approved SVG with its 12-unit padding
 * compensated so the visible 256-unit artwork matches the text's cap height.
 * Custom text retains the Syne display face and its original tracking.
 *
 * The configured text is split on whitespace. Names containing a Yuri wordmark use
 * one foreground color; other names accent trailing words with the theme primary.
 * Brand copy is user content, so it is intentionally not localized.
 *
 * An empty (whitespace-only) config hides the mark entirely — no default
 * fallback — so that logo slot stays vacant.
 */
interface SidebarBrandMarkProps {
  className?: string;
}

export const SidebarBrandMark: React.FC<SidebarBrandMarkProps> = ({ className }) => {
  const { t } = useI18n();
  const openSettingsAtItem = useUIStore(state => state.openSettingsAtItem);
  const sidebarBrandName = useSidebarBrandStore((state) => state.sidebarBrandName);
  const brandName = sidebarBrandName.trim();
  const brandWords = brandName.split(/\s+/).filter(Boolean);
  const hasYuriWordmark = brandWords.includes('Yuri');
  const usesDisplayFont = brandWords.some((word) => word !== 'Yuri');

  React.useEffect(() => {
    if (usesDisplayFont) void loadBrandDisplayFont();
  }, [usesDisplayFont]);

  // Empty config → no custom logo; leave the sidebar brand slot empty.
  if (brandWords.length === 0) {
    return null;
  }

  return (
    <div className={cn('flex min-w-0 items-center overflow-hidden pb-2 pt-1', className)}>
      <Button
        variant="ghost"
        size="xs"
        className="app-region-no-drag min-w-0 max-w-full justify-start"
        aria-label={t('layout.brand.editName')}
        title={t('layout.brand.editName')}
        onClick={() => openSettingsAtItem('appearance', 'appearance.sidebar-brand')}
      >
        <span
          role="img"
          aria-label={brandWords.join(' ')}
          className={cn('inline-flex min-w-0 gap-[0.28em] overflow-hidden whitespace-nowrap text-foreground', brandName.includes('Yuri') ? 'items-center' : 'items-baseline')}
          style={{
            fontFamily: '"Syne", var(--font-sans, system-ui, sans-serif)',
            fontSize: '1.0625rem',
            fontWeight: 700,
            letterSpacing: '0.08em',
            lineHeight: 1,
          }}
        >
          {brandName.includes('Yuri') ? (
            <span aria-hidden="true" className="inline-flex shrink-0 self-center">
              <YuriLogo width={24} height={24} className="size-6" />
            </span>
          ) : null}
          {brandWords.map((word, index) => (
            <span
              key={index}
              aria-hidden="true"
              className={cn('inline-flex shrink-0 items-baseline', !hasYuriWordmark && index > 0 && 'text-primary')}
            >
              {word === 'Yuri' ? <YuriWordmark width="2.44814cap" /> : word}
            </span>
          ))}
        </span>
      </Button>
    </div>
  );
};

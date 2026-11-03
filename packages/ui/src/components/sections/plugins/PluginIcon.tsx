import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import './plugin-settings.css';

interface PluginIconProps {
  /** Package or file name; its first letter stands in when there is no picture. */
  name: string;
  /** The package.json top-level `icon`: an https URL or a data:image URI, already vetted by the server. */
  src?: string;
  /** Used for local files and paths, which have no package to take a picture from. */
  fallback?: IconName;
  size?: number;
  className?: string;
  /** An operation is running on this plugin: a small spinner sits on the picture's corner. */
  busy?: boolean;
  marker?: React.ReactNode;
}

const initialOf = (name: string): string => {
  const match = name.replace(/^@/, '').match(/[A-Za-z0-9]/);
  return (match?.[0] ?? '?').toUpperCase();
};

/** A plugin's picture. A picture that fails to load falls back to the same placeholder as having none. */
export const PluginIcon: React.FC<PluginIconProps> = ({ name, src, fallback, size = 20, className, busy = false, marker }) => {
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const showImage = Boolean(src) && failedSrc !== src;
  const useMask = Boolean(src && (/^data:image\/svg\+xml[;,]/i.test(src) || /^https:\/\/[^?#]+\.svg(?:[?#]|$)/i.test(src)));
  const box: React.CSSProperties = {
    width: size,
    height: size,
    minWidth: size,
    flexShrink: 0,
    borderRadius: Math.round(size * 0.3),
  };

  const picture = showImage ? (
    <>
      <img
        key={src}
        src={src}
        alt=""
        draggable={false}
        referrerPolicy="no-referrer"
        loading="lazy"
        crossOrigin={useMask ? 'anonymous' : undefined}
        style={{ ...box, opacity: useMask ? 0 : undefined }}
        className="object-contain"
        onError={() => setFailedSrc(src ?? null)}
      />
      {useMask ? <span
        data-plugin-icon-mask
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          ...box,
          backgroundColor: 'currentColor',
          maskImage: `url(${JSON.stringify(src)})`,
          WebkitMaskImage: `url(${JSON.stringify(src)})`,
          maskMode: 'alpha',
          maskSize: 'contain',
          WebkitMaskSize: 'contain',
          maskPosition: 'center',
          WebkitMaskPosition: 'center',
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
        }}
      /> : null}
    </>
  ) : fallback ? (
    <span className="yuri-plugin-icon-placeholder" style={{ ...box, display: 'grid', placeItems: 'center', color: 'var(--surface-muted-foreground)' }} aria-hidden>
      <Icon name={fallback} style={{ width: size * 0.65, height: size * 0.65 }} />
    </span>
  ) : (
    <span
      className="yuri-plugin-icon-placeholder"
      style={{
        ...box,
        display: 'grid',
        placeItems: 'center',
        color: 'var(--surface-muted-foreground)',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: Math.round(size * 0.5),
        fontWeight: 500,
        lineHeight: 1,
      }}
      aria-hidden
    >
      {initialOf(name)}
    </span>
  );

  return (
    <span className={cn('relative inline-flex shrink-0 align-middle', className)} style={box} data-plugin-icon data-plugin-busy={busy || undefined}>
      {picture}
      {busy || marker ? <span className="absolute -bottom-[3px] -right-[3px] inline-flex rounded-full bg-[var(--surface-background)] p-[1.5px]" aria-hidden>
        {busy ? <Icon name="loader-4" className="size-2.5 animate-spin text-[var(--status-info)]" /> : marker}
      </span> : null}
    </span>
  );
};

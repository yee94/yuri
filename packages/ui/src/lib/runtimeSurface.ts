import { isDesktopShell } from '@/lib/desktop';

export type HostedSurface = 'desktop' | 'mobile';

declare global {
  interface Window {
    __YURI_SURFACE__?: HostedSurface;
  }
}

const MOBILE_SURFACE_MAX_WIDTH = 768;

const isTouchOrCoarsePointer = (): boolean => {
  if (typeof window === 'undefined') return false;

  const coarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches
    : false;
  const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;
  return coarsePointer || touchPoints > 0;
};

// Render paths ask this many times per commit. The viewport/pointer probe reads
// layout-dependent state, so it runs once per viewport, pointer or URL change
// instead of once per caller. An unmeasured (0) viewport is never cached.
let probed: { search: string; surface: HostedSurface } | null = null;
let probeInvalidationInstalled = false;

const invalidateProbe = () => {
  probed = null;
};

const installProbeInvalidation = () => {
  if (probeInvalidationInstalled) return;
  probeInvalidationInstalled = true;
  window.addEventListener('resize', invalidateProbe);
  if (typeof window.matchMedia !== 'function') return;
  for (const query of ['(pointer: coarse)', '(hover: none)']) {
    window.matchMedia(query).addEventListener?.('change', invalidateProbe);
  }
};

const detectHostedSurface = (): HostedSurface => {
  if (typeof window === 'undefined') return 'desktop';

  const explicitSurface = window.__YURI_SURFACE__;
  if (explicitSurface === 'mobile' || explicitSurface === 'desktop') {
    return explicitSurface;
  }

  const search = window.location.search;
  if (probed?.search === search) return probed.surface;

  const override = new URLSearchParams(search).get('surface');
  if (override === 'mobile' || override === 'desktop') {
    return override;
  }

  if (isDesktopShell()) return 'desktop';

  const width = window.innerWidth || window.screen?.width || 0;
  const surface = width > 0 && width <= MOBILE_SURFACE_MAX_WIDTH && isTouchOrCoarsePointer()
    ? 'mobile'
    : 'desktop';
  if (width > 0) {
    installProbeInvalidation();
    probed = { search, surface };
  }
  return surface;
};

export const isMobileSurfaceRuntime = (): boolean => detectHostedSurface() === 'mobile';

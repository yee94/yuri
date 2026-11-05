import React from 'react';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { applyDesignPtScaleToRoot, readCachedDesignPtScale } from '@/lib/designPtScale';
import { isCapacitorApp } from '@/lib/platform';

type DeviceType = 'desktop' | 'mobile' | 'tablet';

export interface DeviceInfo {
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  deviceType: DeviceType;
  screenWidth: number;
  breakpoint: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  hasTouchInput: boolean;
  hasTouchOnlyPointer: boolean;
}

type DeviceLayoutInfo = Omit<DeviceInfo, 'screenWidth'>;

const toDeviceLayoutInfo = ({ screenWidth: _screenWidth, ...layout }: DeviceInfo): DeviceLayoutInfo => layout;

const BREAKPOINTS = {
  xs: 0,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const;

const DEFAULT_DEVICE_INFO: DeviceInfo = {
  isMobile: false,
  isTablet: false,
  isDesktop: true,
  deviceType: 'desktop',
  screenWidth: 1024,
  breakpoint: 'lg',
  hasTouchInput: false,
  hasTouchOnlyPointer: false,
};

const DEFAULT_DEVICE_LAYOUT_INFO = toDeviceLayoutInfo(DEFAULT_DEVICE_INFO);

const hasDesktopSurfaceOverride = (): boolean => {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('surface') === 'desktop';
};

const getNavigatorDeviceHints = (maxTouchPoints: number) => {
  if (typeof navigator === 'undefined') {
    return { isExplicitTablet: false };
  }

  const userAgent = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const isIPad = /iPad/i.test(userAgent)
    || ((/Macintosh|MacIntel/i.test(userAgent) || /MacIntel/i.test(platform)) && maxTouchPoints > 1);
  const isAndroidTablet = /Android/i.test(userAgent) && !/Mobile/i.test(userAgent);
  const isGenericTablet = /Tablet/i.test(userAgent);

  return { isExplicitTablet: isIPad || isAndroidTablet || isGenericTablet };
};

const setRootDeviceAttributes = (
  isDesktopShellRuntime: boolean,
  deviceType: DeviceType,
  hasTouchInput: boolean,
) => {
  if (typeof window === 'undefined') {
    return;
  }

  const root = document.documentElement;
  const isMobile = deviceType === 'mobile';
  const isTablet = deviceType === 'tablet';

  const toggleClass = (name: string, enabled: boolean) => {
    if (root.classList.contains(name) !== enabled) root.classList.toggle(name, enabled);
  };
  const setProperty = (name: string, value: string) => {
    if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
  };

  toggleClass('device-mobile', isMobile);
  toggleClass('device-tablet', isTablet);
  toggleClass('device-desktop', deviceType === 'desktop');
  toggleClass('desktop-runtime', isDesktopShellRuntime);
  toggleClass('mobile-pointer', !isDesktopShellRuntime && hasTouchInput);

  if (isDesktopShellRuntime) {
    setProperty('--is-mobile', '0');
    setProperty('--device-type', 'desktop');
    setProperty('--font-scale', '1');
    setProperty('--has-coarse-pointer', '0');
    setProperty('--has-touch-input', '0');
  } else {
    setProperty('--is-mobile', isMobile ? '1' : '0');
    setProperty('--device-type', deviceType);
    setProperty('--font-scale', isMobile ? '0.9' : isTablet ? '0.95' : '1');
    setProperty('--has-coarse-pointer', hasTouchInput ? '1' : '0');
    setProperty('--has-touch-input', hasTouchInput ? '1' : '0');
  }

  const scale = isDesktopShellRuntime ? 1 : readCachedDesignPtScale();
  if (root.style.getPropertyValue('--dpt') !== `${scale}px` || root.style.getPropertyValue('--dpt-n') !== String(scale)) {
    applyDesignPtScaleToRoot(scale, root);
  }
};

export function getDeviceInfo(): DeviceInfo {
  const width = window.innerWidth;
  const supportsMatchMedia = typeof window.matchMedia === 'function';
  const pointerQuery = supportsMatchMedia ? window.matchMedia('(pointer: coarse)') : null;
  const hoverQuery = supportsMatchMedia ? window.matchMedia('(hover: none)') : null;
  const prefersCoarsePointer = pointerQuery?.matches ?? false;
  const noHover = hoverQuery?.matches ?? false;
  const maxTouchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;
  // Desktop panels are desktop surfaces even when their viewport is narrow.
  const isDesktopShellRuntime = isDesktopShell() || isVSCodeRuntime() || hasDesktopSurfaceOverride();
  const { isExplicitTablet } = getNavigatorDeviceHints(maxTouchPoints);

  const hasTouchInput = prefersCoarsePointer || noHover || maxTouchPoints > 0;
  const hasTouchOnlyPointer = prefersCoarsePointer || noHover;

  const isTabletWidth = width > BREAKPOINTS.md && width <= BREAKPOINTS.lg;
  const isMobileWidth = width <= BREAKPOINTS.md;

  let isMobile = hasTouchInput && isMobileWidth;
  let isTablet = hasTouchInput && !isMobile && (isTabletWidth || isExplicitTablet);
  let isDesktop = !hasTouchInput || (!isTablet && width > BREAKPOINTS.lg);
  let deviceType: DeviceType = 'desktop';

  if (isDesktopShellRuntime) {
    isMobile = false;
    isTablet = false;
    isDesktop = true;
    deviceType = 'desktop';
  } else if (isCapacitorApp()) {
    // The Capacitor shell IS the phone UI: every surface in that bundle is
    // built mobile-first, so wide devices (iPad, Android tablets) must not
    // fall into tablet/desktop branches scattered across shared components.
    // iPad-specific layout upgrades gate on isIPadApp()/orientation instead.
    isMobile = true;
    isTablet = false;
    isDesktop = false;
    deviceType = 'mobile';
  } else if (isMobile) {
    deviceType = 'mobile';
  } else if (isTablet) {
    deviceType = 'tablet';
  } else {
    isDesktop = true;
    deviceType = 'desktop';
  }

  setRootDeviceAttributes(isDesktopShellRuntime, deviceType, hasTouchInput);

  let breakpoint: keyof typeof BREAKPOINTS = 'xs';
  for (const [key, value] of Object.entries(BREAKPOINTS)) {
    if (width >= value) {
      breakpoint = key as keyof typeof BREAKPOINTS;
    }
  }

  return {
    isMobile,
    isTablet,
    isDesktop,
    deviceType,
    screenWidth: width,
    breakpoint,
    hasTouchInput,
    hasTouchOnlyPointer,
  };
}

const isSameDeviceLayout = (left: DeviceLayoutInfo, right: DeviceLayoutInfo): boolean => (
  left.isMobile === right.isMobile
  && left.isTablet === right.isTablet
  && left.isDesktop === right.isDesktop
  && left.deviceType === right.deviceType
  && left.breakpoint === right.breakpoint
  && left.hasTouchInput === right.hasTouchInput
  && left.hasTouchOnlyPointer === right.hasTouchOnlyPointer
);

const deviceInfoSubscribers = new Set<() => void>();
const deviceLayoutSubscribers = new Set<() => void>();
let deviceInfoSnapshot: DeviceInfo | null = null;
let deviceLayoutSnapshot: DeviceLayoutInfo | null = null;
let deviceInfoFrameId: number | undefined;
let cleanupDeviceInfoSource: (() => void) | null = null;

const readDeviceInfoSnapshot = (): DeviceInfo => {
  if (typeof window === 'undefined') {
    return DEFAULT_DEVICE_INFO;
  }

  if (!deviceInfoSnapshot) {
    deviceInfoSnapshot = getDeviceInfo();
  }

  return deviceInfoSnapshot;
};

const readDeviceLayoutSnapshot = (): DeviceLayoutInfo => {
  if (typeof window === 'undefined') return DEFAULT_DEVICE_LAYOUT_INFO;
  if (!deviceLayoutSnapshot) deviceLayoutSnapshot = toDeviceLayoutInfo(readDeviceInfoSnapshot());
  return deviceLayoutSnapshot;
};

const updateDeviceInfoSnapshot = () => {
  deviceInfoFrameId = undefined;
  const next = getDeviceInfo();
  const layoutChanged = !deviceLayoutSnapshot || !isSameDeviceLayout(deviceLayoutSnapshot, next);
  if (!layoutChanged && deviceInfoSnapshot?.screenWidth === next.screenWidth) {
    return;
  }

  deviceInfoSnapshot = next;
  if (layoutChanged) {
    deviceLayoutSnapshot = toDeviceLayoutInfo(next);
    for (const listener of deviceLayoutSubscribers) listener();
  }
  for (const listener of deviceInfoSubscribers) listener();
};

const scheduleDeviceInfoUpdate = () => {
  if (typeof window === 'undefined' || deviceInfoFrameId !== undefined) {
    return;
  }

  deviceInfoFrameId = window.requestAnimationFrame(updateDeviceInfoSnapshot);
};

const attachMediaQueryListener = (query: MediaQueryList | null, listener: () => void): (() => void) => {
  if (!query) {
    return () => {};
  }

  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }

  if (typeof query.addListener === 'function') {
    query.addListener(listener);
    return () => query.removeListener(listener);
  }

  return () => {};
};

const startDeviceInfoSource = (): (() => void) => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  updateDeviceInfoSnapshot();
  window.addEventListener('resize', scheduleDeviceInfoUpdate);

  const pointerQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)')
    : null;
  const hoverQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(hover: none)')
    : null;
  const cleanupPointer = attachMediaQueryListener(pointerQuery, scheduleDeviceInfoUpdate);
  const cleanupHover = attachMediaQueryListener(hoverQuery, scheduleDeviceInfoUpdate);

  return () => {
    window.removeEventListener('resize', scheduleDeviceInfoUpdate);
    cleanupPointer();
    cleanupHover();
    if (deviceInfoFrameId !== undefined) {
      window.cancelAnimationFrame(deviceInfoFrameId);
      deviceInfoFrameId = undefined;
    }
  };
};

const subscribeToDeviceSource = (subscribers: Set<() => void>, listener: () => void): (() => void) => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  subscribers.add(listener);
  if (!cleanupDeviceInfoSource) {
    cleanupDeviceInfoSource = startDeviceInfoSource();
  }

  return () => {
    subscribers.delete(listener);
    if (deviceInfoSubscribers.size === 0 && deviceLayoutSubscribers.size === 0 && cleanupDeviceInfoSource) {
      cleanupDeviceInfoSource();
      cleanupDeviceInfoSource = null;
      deviceInfoSnapshot = null;
      deviceLayoutSnapshot = null;
    }
  };
};

const subscribeDeviceInfo = (listener: () => void) => subscribeToDeviceSource(deviceInfoSubscribers, listener);
const subscribeDeviceLayout = (listener: () => void) => subscribeToDeviceSource(deviceLayoutSubscribers, listener);

export function isMobileDeviceViaCSS(): boolean {
  if (typeof window === 'undefined') return false;

  if (typeof window !== 'undefined' && isDesktopShell()) {
    return false;
  }

  const root = document.documentElement;
  const isMobileValue = root.style.getPropertyValue('--is-mobile') ||
                        getComputedStyle(root).getPropertyValue('--is-mobile');

  return isMobileValue === '1' || isMobileValue === 'true';
}

const isStandalonePwaRuntime = (): boolean => {
  if (typeof window === 'undefined') return false;

  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return Boolean(
    standaloneNavigator.standalone === true
    || window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.matchMedia?.('(display-mode: fullscreen)')?.matches
  );
};

const isTabletStandalonePwaRuntime = (): boolean => {
  if (typeof window === 'undefined' || isDesktopShell()) return false;

  const maxTouchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;
  return isStandalonePwaRuntime() && maxTouchPoints > 0 && window.innerWidth > BREAKPOINTS.md;
};

export function useTabletStandalonePwaRuntime(): boolean {
  const [value, setValue] = React.useState<boolean>(() => isTabletStandalonePwaRuntime());

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const update = () => setValue(isTabletStandalonePwaRuntime());
    const standaloneQuery = window.matchMedia?.('(display-mode: standalone)');
    const fullscreenQuery = window.matchMedia?.('(display-mode: fullscreen)');

    update();
    window.addEventListener('resize', update);
    window.addEventListener('focus', update);

    const addQueryListener = (query: MediaQueryList | undefined) => {
      if (!query) return;
      if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', update);
      } else if (typeof query.addListener === 'function') {
        query.addListener(update);
      }
    };
    const removeQueryListener = (query: MediaQueryList | undefined) => {
      if (!query) return;
      if (typeof query.removeEventListener === 'function') {
        query.removeEventListener('change', update);
      } else if (typeof query.removeListener === 'function') {
        query.removeListener(update);
      }
    };

    addQueryListener(standaloneQuery);
    addQueryListener(fullscreenQuery);

    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('focus', update);
      removeQueryListener(standaloneQuery);
      removeQueryListener(fullscreenQuery);
    };
  }, []);

  return value;
}

export type Orientation = 'portrait' | 'landscape';

const getOrientation = (): Orientation => {
  if (typeof window === 'undefined') return 'portrait';
  return window.matchMedia?.('(orientation: landscape)')?.matches ? 'landscape' : 'portrait';
};

export function useOrientation(): Orientation {
  const [orientation, setOrientation] = React.useState<Orientation>(getOrientation);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(orientation: landscape)');
    const update = () => setOrientation(query.matches ? 'landscape' : 'portrait');
    update();
    return attachMediaQueryListener(query, update);
  }, []);

  return orientation;
}

export function useDeviceInfo(options: { includeScreenWidth: true }): DeviceInfo;
export function useDeviceInfo(options?: { includeScreenWidth?: false }): DeviceLayoutInfo;
export function useDeviceInfo(options: { includeScreenWidth: boolean }): DeviceLayoutInfo | DeviceInfo;
export function useDeviceInfo(options?: { includeScreenWidth?: boolean }): DeviceLayoutInfo | DeviceInfo {
  return React.useSyncExternalStore(
    options?.includeScreenWidth ? subscribeDeviceInfo : subscribeDeviceLayout,
    options?.includeScreenWidth ? readDeviceInfoSnapshot : readDeviceLayoutSnapshot,
    () => options?.includeScreenWidth ? DEFAULT_DEVICE_INFO : DEFAULT_DEVICE_LAYOUT_INFO,
  );
}

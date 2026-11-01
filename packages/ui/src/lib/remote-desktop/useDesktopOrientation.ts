import { useEffect, useState } from 'react';
import { useResizeObserver } from '@reactuses/core';
import type { DesktopOrientation } from './orientation';
import { lockNativeOrientation, nativeOrientationAvailable } from './nativeOrientation';

export function useDesktopOrientation(pageRef: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [initialOrientation] = useState<DesktopOrientation>(() => window.innerWidth > window.innerHeight ? 'landscape' : 'portrait');
  const [orientation, setOrientation] = useState(initialOrientation);
  // Shells with the native plugin rotate the real window (so the IME rotates too); older shells keep the CSS rotation.
  const [native] = useState(nativeOrientationAvailable);
  useResizeObserver(pageRef, ([entry]) => {
    if (!entry) return;
    const { width, height } = entry.contentRect;
    if (width > 0 && height > 0) setSize(previous => previous.width === width && previous.height === height ? previous
      : { width, height });
  });
  useEffect(() => {
    if (!native) return;
    void lockNativeOrientation(orientation).catch(() => undefined);
  }, [native, orientation]);
  useEffect(() => {
    if (!native) return;
    return () => { void lockNativeOrientation('portrait').catch(() => undefined); };
  }, [native]);
  // Resizing (including IME and OS viewport changes) must never choose a rotation.
  const rotated = !native && orientation !== initialOrientation;
  return {
    orientation, rotation: rotated ? 90 : 0,
    width: rotated ? size.height : size.width,
    height: rotated ? size.width : size.height,
    toggle: () => setOrientation(value => value === 'portrait' ? 'landscape' : 'portrait'),
  };
}

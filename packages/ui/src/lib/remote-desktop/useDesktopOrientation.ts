import { useState } from 'react';
import { useResizeObserver } from '@reactuses/core';
import type { DesktopOrientation } from './orientation';

export function useDesktopOrientation(pageRef: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [initialOrientation] = useState<DesktopOrientation>(() => window.innerWidth > window.innerHeight ? 'landscape' : 'portrait');
  const [orientation, setOrientation] = useState(initialOrientation);
  useResizeObserver(pageRef, ([entry]) => {
    if (!entry) return;
    const { width, height } = entry.contentRect;
    if (width > 0 && height > 0) setSize(previous => previous.width === width && previous.height === height ? previous
      : { width, height });
  });
  // Resizing (including IME and OS viewport changes) must never choose a rotation.
  const rotated = orientation !== initialOrientation;
  return {
    orientation, rotation: rotated ? 90 : 0,
    width: rotated ? size.height : size.width,
    height: rotated ? size.width : size.height,
    toggle: () => setOrientation(value => value === 'portrait' ? 'landscape' : 'portrait'),
  };
}

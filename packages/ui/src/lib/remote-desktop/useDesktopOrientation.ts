import { useState } from 'react';
import { useResizeObserver } from '@reactuses/core';
import type { DesktopOrientation } from './orientation';

export function useDesktopOrientation(pageRef: React.RefObject<HTMLElement | null>, keyboardOpen: boolean) {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight,
    viewport: (window.innerWidth > window.innerHeight ? 'landscape' : 'portrait') as DesktopOrientation }));
  const [orientation, setOrientation] = useState(size.viewport);
  useResizeObserver(pageRef, ([entry]) => {
    if (!entry) return;
    const { width, height } = entry.contentRect;
    if (width > 0 && height > 0) setSize(previous => previous.width === width && previous.height === height ? previous
      : { width, height, viewport: keyboardOpen ? previous.viewport : width > height ? 'landscape' : 'portrait' });
  });
  const rotated = orientation !== size.viewport;
  return {
    orientation, rotation: rotated ? 90 : 0,
    width: rotated ? size.height : size.width,
    height: rotated ? size.width : size.height,
    toggle: () => setOrientation(value => value === 'portrait' ? 'landscape' : 'portrait'),
  };
}

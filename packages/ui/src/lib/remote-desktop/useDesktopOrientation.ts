import { useRef, useState } from 'react';
import { useEventListener, useResizeObserver } from '@reactuses/core';
import { desktopOrientationFromTilt, type DesktopOrientation } from './orientation';

export function useDesktopOrientation(pageRef: React.RefObject<HTMLElement | null>, keyboardOpen: boolean) {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight,
    viewport: (window.innerWidth > window.innerHeight ? 'landscape' : 'portrait') as DesktopOrientation }));
  const [sensor, setSensor] = useState<{ orientation: DesktopOrientation; angle: 90 | -90 } | null>(null);
  const lastSensor = useRef('');
  const [manual, setManual] = useState<DesktopOrientation | null>(null);
  useResizeObserver(pageRef, ([entry]) => {
    if (!entry) return;
    const { width, height } = entry.contentRect;
    if (width > 0 && height > 0) setSize(previous => previous.width === width && previous.height === height ? previous
      : { width, height, viewport: keyboardOpen ? previous.viewport : width > height ? 'landscape' : 'portrait' });
  });
  useEventListener('deviceorientation', event => {
    const next = desktopOrientationFromTilt(event.beta, event.gamma);
    if (!next) return;
    const angle = next === 'landscape' && event.gamma! < 0 ? -90 : 90;
    const key = `${next}:${angle}`;
    if (key === lastSensor.current) return;
    const previous = lastSensor.current;
    lastSensor.current = key;
    setSensor({ orientation: next, angle });
    if (previous) setManual(null);
  }, () => window);
  const orientation = manual ?? sensor?.orientation ?? size.viewport;
  const rotated = orientation !== size.viewport;
  return {
    orientation, rotation: rotated ? sensor?.angle ?? 90 : 0,
    width: rotated ? size.height : size.width,
    height: rotated ? size.width : size.height,
    toggle: () => setManual(orientation === 'portrait' ? 'landscape' : 'portrait'),
  };
}

export type DesktopOrientation = 'portrait' | 'landscape';

export function desktopLocalPoint(point: { x: number; y: number }, rect: { left: number; top: number; right: number; bottom: number }, rotation: number) {
  if (rotation === 90) return { x: point.y - rect.top, y: rect.right - point.x };
  if (rotation === -90) return { x: rect.bottom - point.y, y: point.x - rect.left };
  return { x: point.x - rect.left, y: point.y - rect.top };
}

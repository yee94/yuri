export type DesktopOrientation = 'portrait' | 'landscape';

export async function requestDesktopOrientationPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (typeof window === 'undefined' || typeof DeviceOrientationEvent === 'undefined') return 'unsupported';
  const sensor = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
    requestPermission?: () => Promise<'granted' | 'denied'>;
  };
  if (!sensor.requestPermission) return 'granted';
  try { return await sensor.requestPermission(); } catch { return 'denied'; }
}

export function desktopOrientationFromTilt(beta: number | null, gamma: number | null): DesktopOrientation | null {
  if (beta === null || gamma === null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const radians = Math.PI / 180;
  const x = Math.abs(Math.cos(beta * radians) * Math.sin(gamma * radians));
  const y = Math.abs(Math.sin(beta * radians));
  if (Math.hypot(x, y) < 0.55) return null;
  if (x > y * 1.35) return 'landscape';
  if (y > x * 1.35) return 'portrait';
  return null;
}

export function desktopLocalPoint(point: { x: number; y: number }, rect: { left: number; top: number; right: number; bottom: number }, rotation: number) {
  if (rotation === 90) return { x: point.y - rect.top, y: rect.right - point.x };
  if (rotation === -90) return { x: rect.bottom - point.y, y: point.x - rect.left };
  return { x: point.x - rect.left, y: point.y - rect.top };
}

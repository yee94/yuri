export type RemoteDesktopPoint = { x: number; y: number };
export type RemoteDesktopBounds = { x: number; y: number; width: number; height: number };

/** Surface points are not transformed by NSH's measure(); invert only this page's rotation. */
export function remoteDesktopLocalPoint(point: RemoteDesktopPoint, bounds: RemoteDesktopBounds, rotation: number): RemoteDesktopPoint {
  if (rotation === 90) return { x: point.y - bounds.y, y: bounds.x + bounds.width - point.x };
  if (rotation === -90) return { x: bounds.y + bounds.height - point.y, y: point.x - bounds.x };
  return { x: point.x - bounds.x, y: point.y - bounds.y };
}

export function remoteDesktopPageSize(width: number, height: number, rotation: number) {
  return rotation ? { width: height, height: width } : { width, height };
}

export function remoteDesktopSafeArea(safe: { top: number; right: number; bottom: number; left: number }, rotation: number) {
  if (rotation === 90) return { top: safe.right, right: safe.bottom, bottom: safe.left, left: safe.top };
  if (rotation === -90) return { top: safe.left, right: safe.top, bottom: safe.right, left: safe.bottom };
  return safe;
}

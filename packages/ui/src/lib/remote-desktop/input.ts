export type DesktopInput =
  | { type: 'pointer'; action: 'down' | 'up' | 'move' | 'click' | 'right'; x: number; y: number }
  | { type: 'scroll'; dx: number; dy: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string }
  | { type: 'release' };

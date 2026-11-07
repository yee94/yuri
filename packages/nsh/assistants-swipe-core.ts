/** Same intent/settle contract as the mobile contact rail; native owns touch arbitration. */
export function createAssistantSwipe(options: {
  read: () => number;
  write: (offset: number) => void;
  enabled: () => boolean;
  reveal: () => void;
  width?: number;
}) {
  const width = options.width ?? 128;
  let start = 0, intent: 'pending' | 'horizontal' | 'vertical' = 'pending', suppressed = false;
  const clamp = (value: number) => Math.max(-width, Math.min(0, value));
  function begin() { start = options.read(); intent = 'pending'; suppressed = false; }
  function claim(dx: number, dy: number, touches = 1) {
    if (!options.enabled() || touches !== 1 || intent === 'vertical') return false;
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { intent = 'vertical'; return false; }
    return Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) && (start < 0 || dx < 0);
  }
  function grant() {
    if (!options.enabled()) return;
    intent = 'horizontal'; suppressed = true; options.reveal();
  }
  function move(dx: number) { if (options.enabled() && intent === 'horizontal') options.write(clamp(start + dx)); }
  function release() {
    if (intent === 'horizontal') options.write(options.read() < -width * 0.35 ? -width : 0);
    intent = 'pending';
  }
  function cancel() {
    if (intent === 'horizontal') { options.write(start); suppressed = true; }
    intent = 'pending';
  }
  function close() { options.write(0); intent = 'pending'; }
  function select() {
    if (!options.enabled()) return false;
    if (suppressed) { suppressed = false; return false; }
    if (options.read() !== 0) { close(); return false; }
    options.reveal(); return true;
  }
  return { begin, claim, grant, move, release, cancel, close, select, suppress: () => { suppressed = true; } };
}

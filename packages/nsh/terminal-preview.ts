// Retained pure extraction from ui/src/lib/terminalPreview.ts. The parity test prevents owner drift.
const ANSI_ESCAPE_PREFIX = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE_PREFIX}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const LOOPBACK_URL_PATTERN = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[(?:::1|::)\])(?::\d{2,5})?(?:\/[^\s<>'"`]*)?)/gi;
const PREVIEW_OUTPUT_PATTERN = /(?:➜\s*(?:Local|Network):)|\b(?:local|network|loopback|serving|listening|available|ready|started|running|server|vite|webpack|next\.js|astro|sveltekit|nuxt)\b/i;
const PYTHON_HTTP_SERVER_PATTERN = /Serving HTTP on .*? port (\d{2,5})/i;
const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?']);
const trimUrlTrailingPunctuation = (url: string): string => {
  let result = url;
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (last === ')' || last === ']' || last === '}' || last === '>') {
      const opener = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : '<';
      const head = result.slice(0, -1);
      const opens = (head.match(new RegExp(`\\${opener}`, 'g')) || []).length;
      const closes = (head.match(new RegExp(`\\${last}`, 'g')) || []).length;
      if (opens > closes) break;
      result = head;
      continue;
    }
    if (TRAILING_PUNCT.has(last)) { result = result.slice(0, -1); continue; }
    break;
  }
  return result;
};
const normalizeLoopbackUrl = (url: string): string => trimUrlTrailingPunctuation(url).replace('0.0.0.0', '127.0.0.1').replace('[::1]', '127.0.0.1').replace('[::]', '127.0.0.1');
export function extractTerminalPreviewUrl(text: string): string | null {
  if (!text) return null;
  const cleaned = text.replace(ANSI_ESCAPE_PATTERN, ''), pythonMatch = cleaned.match(PYTHON_HTTP_SERVER_PATTERN);
  if (pythonMatch?.[1]) { const port = Number.parseInt(pythonMatch[1], 10); if (Number.isFinite(port) && port > 0 && port <= 65535) return `http://127.0.0.1:${port}/`; }
  for (const line of cleaned.split('\n')) {
    if (!PREVIEW_OUTPUT_PATTERN.test(line)) continue;
    const matches = Array.from(line.matchAll(LOOPBACK_URL_PATTERN)); if (!matches.length) continue;
    const withPort = matches.find(match => {
      const parsed = /^(https?):\/\/(?:\[[^\]]+\]|[^/:]+):([0-9]+)(?:\/|$)/i.exec(normalizeLoopbackUrl(match[1]));
      return !!parsed && +parsed[2] > 0 && +parsed[2] <= 65535 && +parsed[2] !== (parsed[1] === 'https' ? 443 : 80);
    });
    return normalizeLoopbackUrl((withPort ?? matches[0])[1]);
  }
  return null;
}
/** No URL global needed in QuickJS; security admission is repeated by Swift/resource owner. */
export function terminalPreviewURL(value: string): string | null {
  const raw = /^https?:\/\//i.test(value.trim()) ? value.trim() : `http://${value.trim()}`;
  const match = /^(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(?::([0-9]{1,5}))?([/?#][^\s\\]*)?$/i.exec(raw);
  if (!match || match[3] && (+match[3] < 1 || +match[3] > 65535) || /(?:token|authorization|password|secret)=/i.test(raw)) return null;
  return normalizeLoopbackUrl(raw);
}
/** Explicit Action custom URLs may be external. Only the existing preview/external
 * resource owner decides presentation, never terminal WK navigation or a direct fetch. */
export function terminalActionURL(value: string): string | null {
  const raw = /^https?:\/\//i.test(value.trim()) ? value.trim() : `http://${value.trim()}`;
  if (raw.length > 8192 || /[\s\\\x00-\x1f\x7f]/.test(raw) || /(?:token|authorization|password|secret)=/i.test(raw)) return null;
  const match = /^(https?):\/\/(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?([/?#].*)?$/i.exec(raw);
  if (!match || match[3] && (+match[3] < 1 || +match[3] > 65535)) return null;
  return terminalPreviewURL(raw) ?? raw;
}
/** ProjectActionsButton.extractBestUrl retained without importing React/browser APIs. */
export function extractTerminalActionURL(value: string): string | null {
  const matches = value.replace(ANSI_ESCAPE_PATTERN, '').match(/https?:\/\/[^\s<>'"`]+/gi);
  const normalized = (matches ?? []).map(entry => entry.replace(/[),.;]+$/, '')).filter(Boolean);
  const candidates: { origin: string; score: number }[] = [];
  for (const raw of normalized) {
    const match = /^(https?):\/\/(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?([^\s]*)$/i.exec(raw);
    if (!match || !terminalActionURL(raw)) continue;
    const port = match[3] ? +match[3] : 0;
    if (!port || port === (match[1] === 'https' ? 443 : 80)) continue;
    const pathname = (match[4] || '/').split(/[?#]/, 1)[0] || '/', segments = pathname.split('/').filter(Boolean).length;
    const local = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(match[2].toLowerCase());
    candidates.push({ origin: `${match[1]}://${match[2]}:${port}`, score: (local ? 50 : 0) + (pathname === '/' ? 30 : 0) - Math.min(segments * 5, 20) - (/[?#]/.test(match[4]) ? 10 : 0) });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.origin ?? (normalized[0] && terminalActionURL(normalized[0]) ? normalized[0] : null);
}
export function createTerminalPreviewScanner() {
  let tail = '';
  return { push(data: string) {
    const combined = `${tail}${data}`.replace(/\r\n|\r/g, '\n'), lines = combined.split('\n');
    const complete = combined.endsWith('\n') ? lines.join('\n') : lines.slice(0, -1).join('\n');
    tail = combined.endsWith('\n') ? '' : (lines.at(-1) ?? '').slice(-1024);
    const candidate = extractTerminalPreviewUrl(complete); return candidate ? terminalPreviewURL(candidate) : null;
  } };
}

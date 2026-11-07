import type { App } from '../.nsh/types/nsh/test';

/** Only mounted rows are searchable. Use the real List's public test scroll API, not row-height offsets. */
export async function revealSearchResult(app: Pick<App, 'shows' | 'scroll' | 'waitFor' | 'texts'>, selector: string, direction: 1 | -1 = 1): Promise<void> {
  const list = 'id:projects-search-results';
  if (app.shows(selector)) { await app.waitFor(selector); return; }
  // Bound both sweeps for this synthetic fixture. A miss remains a failure, never a skipped assertion.
  for (const sign of [direction, -direction]) {
    for (let step = 0; step < 18; step++) {
      await app.scroll(list, sign * 240);
      if (app.shows(selector)) { await app.waitFor(selector); return; }
    }
  }
  throw new Error(`Search result not mounted after bounded bidirectional List scroll: ${selector}\nMounted texts: ${app.texts().join('\n')}`);
}

/** The exact same helper is exercised in the VM and supplied to the NSH stdin test driver. */
export function searchNavigationScript(): string {
  return `const revealSearchResult = ${revealSearchResult.toString()};`;
}

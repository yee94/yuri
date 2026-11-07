// PREPARED ONLY. Main may feed this to `nsh test history-terminal-fixture.tsx --target ios`.
// Never auto-discovered by Vitest. This is plumbing coverage, not released UIKit geometry acceptance.
await app.waitFor('id:terminal-counters');
await app.press('id:terminal-toggle-metadata');
await app.press('id:terminal-probe');
await app.waitFor('text:加载中…');
await app.press('id:terminal-commit');
await app.waitFor('text:已处理');
expect(app.texts().some(text => text.includes('p1/20 n20 req0 adopt0'))).toBe(true);
expect(app.texts().some(text => text.includes('more:false loading:false'))).toBe(true);
// Full native measurements and monotonic evidence are emitted only by the independent Swift App.
// The CLI engine does not install TerminalObserver.swift. Do not infer UIKit PASS from this script.

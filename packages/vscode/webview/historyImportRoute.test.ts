import fs from 'node:fs/promises';
import { expect, test } from 'vitest';

test('standalone history import is refused before the generic OpenCode proxy', async () => {
  const source = await fs.readFile(new URL('./main.tsx', import.meta.url), 'utf8');
  const guard = source.indexOf("if (normalizedPathname.startsWith('/api/yuri/history-import/'))");
  const refusal = source.indexOf("return jsonResponse({ code: 'history_import_unsupported' }, 501)", guard);
  expect(guard).toBeGreaterThan(-1);
  expect(refusal).toBeGreaterThan(guard);
  expect(source.indexOf('await proxyApiRequest(')).toBeGreaterThan(refusal);
});

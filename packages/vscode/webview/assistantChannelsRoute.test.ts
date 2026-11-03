import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('standalone assistant channel route refusal', () => {
  it('refuses Host-owned enterprise configuration before proxying to OpenCode', async () => {
    const source = await fs.readFile(new URL('./main.tsx', import.meta.url), 'utf8');
    const guard = source.indexOf("return jsonResponse({ error: 'channels_unsupported' }, 501)");
    expect(guard).toBeGreaterThan(-1);
    expect(source.indexOf('await proxyApiRequest(')).toBeGreaterThan(guard);
    const match = source.match(/if \((\/\^.*channels.*\/)\.test\(normalizedPathname\)\)/);
    expect(match).not.toBeNull();
    const route = new RegExp(match![1].slice(1, -1));
    expect(route.test('/api/yuri/assistants/bot/channels/wecom')).toBe(true);
    expect(route.test('/api/yuri/assistants/bot/channels/feishu/retry')).toBe(true);
    expect(route.test('/api/yuri/assistants/bot/channels-other')).toBe(false);
  });
});

import { expect, it } from 'vitest';
import { isGuiPluginUiUrl } from './gui-plugin-origin.mjs';

it('accepts exact desktop UI origins and routed application pages', () => {
  for (const url of ['yuri-ui://app/', 'yuri-ui://app/session/example', 'http://127.0.0.1:5173/settings/plugins', 'http://127.0.0.1:5173/mini-chat.html',
    'yuri-ui://app/plugins/example/board', 'http://127.0.0.1:5173/plugins/example/board']) {
    expect(isGuiPluginUiUrl(url, ['http://127.0.0.1:5173'])).toBe(true);
  }
});
it('rejects same-origin preview/API documents, lookalike origins and non-app protocols', () => {
  for (const url of ['http://127.0.0.1:5173/api/preview/proxy/3000/', 'http://127.0.0.1:5173/api/fs/raw',
    'http://127.0.0.1:5174/', 'http://localhost.remote.example/', 'yuri-ui://app:123/',
    'yuri-ui://foreign/', 'file:///index.html', 'about:blank', 'data:text/html,test', 'https://remote.example/',
    'yuri-ui://app/plugins-preview/example/board', 'http://127.0.0.1:5174/plugins/example/board', 'https://remote.example/plugins/example/board']) {
    expect(isGuiPluginUiUrl(url, ['http://127.0.0.1:5173'])).toBe(false);
  }
});

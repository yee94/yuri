import { describe, expect, it } from 'vitest';
import { encodeWeixinTOON } from './toon.js';

describe('WeChat bounded TOON metadata', () => {
  it('encodes objects, primitive arrays, tables and nested mixed lists using TOON syntax', () => {
    expect(encodeWeixinTOON({ title: '中文文章', tags: ['微信', 'AI'], rows: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }] }))
      .toBe('title: 中文文章\ntags[2]: 微信,AI\nrows[2]{id,title}:\n  1,a\n  2,b');
    expect(encodeWeixinTOON({ items: [1, { meta: { title: '文章' }, url: 'https://example.com' }, ['a', 'b']] }))
      .toBe('items[3]:\n  - 1\n  - meta:\n      title: 文章\n    url: "https://example.com"\n  - [2]: a,b');
  });

  it('quotes literal-like strings, hostile keys, delimiters, controls and backslashes without changing their values', () => {
    expect(encodeWeixinTOON({ values: ['true', '05', '-x', '#comment', 'hello, world', '', ' padded ', 'a\nb', '\\bar', '\b\f'] }))
      .toBe('values[10]: "true","05","-x","#comment","hello, world",""," padded ","a\\nb","\\\\bar","\\u0008\\u000c"');
    expect(encodeWeixinTOON({ 'field name': 'value', 'items[9]:\n#': 'payload' }))
      .toBe('"field name": value\n"items[9]:\\u000a#": payload');
    expect(encodeWeixinTOON({ empty: [], obj: {} })).toBe('empty: []\nobj:');
    expect(encodeWeixinTOON({ items: [[], {}] })).toBe('items[2]:\n  - [0]:\n  -');
  });

  it('does not claim universal savings; avoids repeated keys in a representative flat card list', () => {
    const data = { articles: Array.from({ length: 20 }, (_, i) => ({ title: `文章${i}`, description: '分享内容摘要', source: '公众号' })) };
    expect(encodeWeixinTOON(data).length).toBeLessThan(JSON.stringify(data).length);
  });
});

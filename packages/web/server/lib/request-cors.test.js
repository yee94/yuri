import { describe, expect, it } from 'vitest';

import { applyRuntimeCorsHeaders } from './request-cors.js';

describe('applyRuntimeCorsHeaders', () => {
  it.each(['yuri-ui://app', 'capacitor://localhost', 'http://localhost:5180'])(
    'allows assistant attachment upload preflights from %s', (origin) => {
      const headers = new Map();
      applyRuntimeCorsHeaders({ origin, setHeader: (name, value) => headers.set(name, value) });
      const allowed = headers.get('Access-Control-Allow-Headers').toLowerCase().split(',').map((name) => name.trim());
      expect(headers.get('Access-Control-Allow-Methods').split(',')).toContain('PUT');
      for (const name of ['content-type', 'authorization', 'x-content-sha256', 'x-content-size', 'x-attachment-filename']) {
        expect(allowed, `Browser blocks assistant attachment upload header: ${name}`).toContain(name);
      }
    },
  );

  it('gives packaged clients a reusable preflight cache window', () => {
    const headers = new Map();
    applyRuntimeCorsHeaders({
      origin: 'yuri-ui://app',
      setHeader: (name, value) => headers.set(name, value),
    });
    expect(headers.get('Access-Control-Max-Age')).toBe('600');
    expect(headers.get('Access-Control-Allow-Origin')).toBe('yuri-ui://app');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Message-Queue-Upload-Token');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Message-Queue-Sha256');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Message-Queue-Content-Length');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Yuri-Mime');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Yuri-Sha256');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Yuri-Content-Length');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Yuri-Filename');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Yuri-Gui-Revision');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Yuri-Target-Instance');
    expect(headers.get('Access-Control-Expose-Headers')).toContain('x-yuri-gui-revision');
    expect(headers.get('Access-Control-Expose-Headers')).toContain('x-yuri-gui-code');
    expect(headers.get('Access-Control-Expose-Headers')).toContain('x-next-cursor');
    expect(headers.get('Access-Control-Expose-Headers')).toContain('x-yuri-file-exists');
  });
});

import { fileURLToPath } from 'node:url';
import base from './vitest.config';

export default {
  ...base,
  resolve: { alias: { '@/lib/path-utils': fileURLToPath(new URL('../ui/src/lib/path-utils.ts', import.meta.url)) } },
  test: { ...base.test, include: ['packages/nsh/desktop-content-link*.test.ts'] },
};

import { fileURLToPath } from 'node:url';

export default {
  root: fileURLToPath(new URL('../../../../', import.meta.url)),
  test: { name: 'history-uikit-fixture', environment: 'node', include: ['packages/nsh/tests/history-uikit/*.test.ts'] },
};

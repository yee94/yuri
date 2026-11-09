import { fileURLToPath } from 'node:url';
export default { root: fileURLToPath(new URL('../../../../', import.meta.url)), test: { name: 'history-production-uikit-pure', environment: 'node', include: ['packages/nsh/tests/history-production-uikit/*.test.ts'], fileParallelism: false, testTimeout: 20000, hookTimeout: 120000 } };

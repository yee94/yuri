import { fileURLToPath } from 'node:url';

// Pure unit contracts only. Never discovers the engine test/production App.
export default {
  root: fileURLToPath(new URL('../../../../', import.meta.url)),
  test: { name: 'history-terminal', environment: 'node', include: ['packages/nsh/tests/history-terminal/*.test.ts'], fileParallelism: false },
};

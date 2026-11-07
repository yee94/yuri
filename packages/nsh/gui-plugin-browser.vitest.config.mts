import { fileURLToPath } from 'node:url';
import ui from '../ui/vitest.config.ts';

/** Isolated real browser SDK/host tests; never starts an NSH engine or network. */
export default {
  ...ui,
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    ...ui.test,
    name: '@yuriai/nsh-gui-plugin',
    include: ['packages/nsh/gui-plugin-browser.test.tsx', 'packages/nsh/gui-plugin-artifact.test.tsx'],
  },
  resolve: {
    ...ui.resolve,
    alias: {
      ...ui.resolve?.alias,
      '@tanstack/react-query': fileURLToPath(new URL('../ui/node_modules/@tanstack/react-query', import.meta.url)),
    },
  },
};

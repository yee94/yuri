import gui from './gui-plugin-browser.vitest.config.mts';
export default { ...gui, test: { ...gui.test, name: '@yuriai/nsh-gui-context', include: ['packages/nsh/gui-plugin-native-context.test.tsx', 'packages/nsh/appearance-core.test.ts'] } };

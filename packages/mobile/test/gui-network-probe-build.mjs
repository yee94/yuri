// Bundles the production transport; only the app's current-runtime selection is
// supplied by the fixture. The native bridge, E2EE and Host auth remain real.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const result = await Bun.build({
  entrypoints: [path.join(root, 'packages/mobile/test/gui-network-probe-entry.ts')],
  outdir: process.argv[2], target: 'browser', naming: 'probe.js',
  plugins: [{ name: 'probe-runtime', setup(build) {
    const mocks = new Set(['@/lib/runtime-switch', '@/lib/runtime-auth', '@/lib/runtime-url', '@/lib/runtime-fetch', '@/lib/relay/runtime-tunnel', '@/apps/mobileConnections']);
    build.onResolve({ filter: /^@\// }, args => ({ path: mocks.has(args.path)
      ? path.join(root, 'packages/mobile/test/gui-network-probe-runtime.ts')
      : path.join(root, 'packages/ui/src', args.path.slice(2) + '.ts') }));
  } }],
});
if (!result.success) throw new AggregateError(result.logs, 'probe build failed');

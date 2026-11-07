import { fileURLToPath } from 'node:url';
import base from './vitest.config.ts';

// The shared pure composer modules use Yuri's @ alias; do not load a React app.
export default { ...base, resolve: { alias: { '@': fileURLToPath(new URL('../ui/src', import.meta.url)) } } };

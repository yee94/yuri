import { main } from '../build.mjs';

// Main owns compilation/installation. This explicit entry never launches an app or enables pan.
await main([...process.argv.slice(2), '--observer-v4']);

import { main } from '../build.mjs';

// Build only. No device launch, Host connection, touch, or automatic pan.
await main([...process.argv.slice(2), '--observer-v4', '--identity-only']);

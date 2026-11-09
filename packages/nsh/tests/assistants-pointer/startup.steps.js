// Real synthetic-only headless engine startup and refresh loop; no Host module.
await app.waitUntil(() => app.texts().includes('fixed-binding') && app.texts().includes('Pointer fixture A'), { timeout: 5000 });
await app.press('Working');
await app.waitUntil(() => app.texts().includes('working-2500ms') && app.texts().some(text => text.includes('refresh') && text.includes('retire-binding')), { timeout: 6000 });
await app.press('Fixed');
await app.waitUntil(() => app.texts().includes('fixed-binding'), { timeout: 5000 });
console.log('POINTER_STARTUP_PASS fixed row mounted; working refresh retired binding; fixed restored');

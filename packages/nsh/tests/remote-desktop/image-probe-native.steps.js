// Real renderer probe only. Main must opt into a native --target; never use this
// script to inject a successful Image event or ACK into the headless fixture.
await app.waitFor('id:remote-desktop-image-probe');
await app.waitFor('text:png:detail=decoded:');
await app.waitFor('text:jpeg:detail=decoded:');
await app.waitFor('text:broken:detail=error:');
await app.press('id:probe-get-size');
await app.waitFor('text:getSize:success:');
console.log('[remote-image-native-probe] ' + JSON.stringify(app.texts()));
const png = app.texts().find(text => text.startsWith('png:detail=decoded:'));
const jpeg = app.texts().find(text => text.startsWith('jpeg:detail=decoded:'));
expect(JSON.parse(png.slice('png:detail=decoded:'.length))).toEqual({ width: 1, height: 1 });
expect(JSON.parse(jpeg.slice('jpeg:detail=decoded:'.length))).toEqual({ width: 16, height: 9 });
expect(app.texts().join('\n')).toMatch(/png:start=\d+;load=[1-9]\d*;error=0;/);
expect(app.texts().join('\n')).toMatch(/jpeg:start=\d+;load=[1-9]\d*;error=0;/);
expect(app.texts().join('\n')).toMatch(/broken:start=\d+;load=0;error=[1-9]\d*;/);

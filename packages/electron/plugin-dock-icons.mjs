/** One app-wide Dock owner; the newest active window selection wins. */
export function createPluginDockIcons({ decode, apply }) {
  const selections = new Map();
  const publish = () => apply([...selections.values()].at(-1) ?? null);
  return {
    set(lease, source) {
      if (source === null) { if (selections.delete(lease)) publish(); return; }
      if (typeof source !== 'string' || source.length > 2 * 1024 * 1024 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(source)) throw new Error('Invalid Dock PNG');
      const bytes = Buffer.from(source.slice('data:image/png;base64,'.length), 'base64');
      if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid Dock PNG');
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (!width || !height || width > 1024 || height > 1024) throw new Error('Dock PNG dimensions exceed 1024');
      const image = decode(source);
      if (image.isEmpty()) throw new Error('Invalid Dock PNG');
      // Decode and apply before committing, so a failure retains the previous icon.
      apply(image);
      selections.delete(lease);
      selections.set(lease, image);
    },
    remove(lease) { if (selections.delete(lease)) publish(); },
  };
}

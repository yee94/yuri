/** Synthetic test-only bytes: no captured desktop, user content or network source. */
export const remoteDesktopFixtureJPEG = {
  width: 16,
  height: 9,
  // Baseline grayscale, four zero-DCT blocks, single-symbol DC/AC Huffman tables.
  source: 'data:image/jpeg;base64,/9j/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAAJABABAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AAP/Z',
} as const;

// 1×1 RGBA PNG. CRCs and decompressed scanline are checked by a pure TS test.
export const remoteDesktopFixturePNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
export const remoteDesktopFixtureBrokenJPEG = 'data:image/jpeg;base64,bm90LWEtdmFsaWQtanBlZw==';

/** Standard QR byte-mode, versions 1–40-L, mask 0.
 * This path keeps native QR generation independent of Canvas/DOM and Node.
 * Oversized input is rejected rather than displaying an unscannable code.
 */
export function assistantQRMatrix(value: string): boolean[][] {
  const bytes: number[] = [];
  for (const character of value) {
    const n = character.codePointAt(0)!;
    if (n < 0x80) bytes.push(n);
    else if (n < 0x800) bytes.push(0xc0 | n >> 6, 0x80 | n & 63);
    else if (n < 0x10000) bytes.push(0xe0 | n >> 12, 0x80 | n >> 6 & 63, 0x80 | n & 63);
    else bytes.push(0xf0 | n >> 18, 0x80 | n >> 12 & 63, 0x80 | n >> 6 & 63, 0x80 | n & 63);
  }
  const blockCounts = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];
  const parityLengths = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
  function totalWords(version: number) {
    let modules = (16 * version + 128) * version + 64;
    if (version >= 2) { const alignments = Math.floor(version / 7) + 2; modules -= (25 * alignments - 10) * alignments - 55; }
    if (version >= 7) modules -= 36;
    return Math.floor(modules / 8);
  }
  let versionNumber = 1;
  const capacity = (version: number) => totalWords(version) - blockCounts[version - 1] * parityLengths[version - 1];
  while (versionNumber <= 40 && 4 + (versionNumber < 10 ? 8 : 16) + bytes.length * 8 > capacity(versionNumber) * 8) versionNumber++;
  if (!bytes.length || versionNumber > 40) throw new Error('qr_capacity');
  const dataWords = capacity(versionNumber), ecLength = parityLengths[versionNumber - 1], blockCount = blockCounts[versionNumber - 1];
  const bits: number[] = [];
  const push = (n: number, width: number) => { for (let i = width - 1; i >= 0; i--) bits.push(n >> i & 1); };
  push(4, 4); push(bytes.length, versionNumber < 10 ? 8 : 16); bytes.forEach(byte => push(byte, 8));
  push(0, Math.min(4, dataWords * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let index = 0; index < bits.length; index += 8) data.push(bits.slice(index, index + 8).reduce((result, bit) => result << 1 | bit, 0));
  for (let index = 0; data.length < dataWords; index++) data.push(index % 2 ? 0x11 : 0xec);
  const exp: number[] = [], log: number[] = [];
  let x = 1;
  for (let i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  const multiply = (a: number, b: number) => a && b ? exp[(log[a] + log[b]) % 255] : 0;
  let generator = [1];
  for (let i = 0; i < ecLength; i++) {
    const next = new Array<number>(generator.length + 1).fill(0);
    generator.forEach((coefficient, j) => { next[j] ^= coefficient; next[j + 1] ^= multiply(coefficient, exp[i]); });
    generator = next;
  }
  const blocks: number[][] = [], parity: number[][] = [];
  let offset = 0;
  const shortSize = Math.floor(dataWords / blockCount), longBlocks = dataWords % blockCount;
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    const size = shortSize + (blockIndex >= blockCount - longBlocks ? 1 : 0);
    const block = data.slice(offset, offset + size); offset += size;
    blocks.push(block);
    const remainder = [...block, ...new Array<number>(ecLength).fill(0)];
    for (let i = 0; i < size; i++) {
      const coefficient = remainder[i];
      for (let j = 0; j < generator.length; j++) remainder[i + j] ^= multiply(generator[j], coefficient);
    }
    parity.push(remainder.slice(size));
  }
  const wire: number[] = [];
  for (let i = 0; i <= shortSize; i++) for (const block of blocks) if (i < block.length) wire.push(block[i]);
  for (let i = 0; i < ecLength; i++) for (const block of parity) wire.push(block[i]);
  const size = versionNumber * 4 + 17;
  const matrix = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  const finder = (row: number, column: number) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      if (row + r < 0 || row + r >= size || column + c < 0 || column + c >= size) continue;
      matrix[row + r][column + c] = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || r >= 2 && r <= 4 && c >= 2 && c <= 4);
    }
  };
  finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
  const positions: number[] = [];
  if (versionNumber >= 2) {
    const count = Math.floor(versionNumber / 7) + 2;
    const step = versionNumber === 32 ? 26 : Math.floor((versionNumber * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
    positions.push(6);
    for (let position = size - 7; positions.length < count; position -= step) positions.splice(1, 0, position);
  }
  for (const row of positions) for (const column of positions) {
    if (matrix[row][column] !== null) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) matrix[row + r][column + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
  }
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6][i] === null) matrix[6][i] = i % 2 === 0;
    if (matrix[i][6] === null) matrix[i][6] = i % 2 === 0;
  }
  const degree = (n: number) => { let result = 0; while (n) { n >>>= 1; result++; } return result; };
  const bch = (n: number, polynomial: number) => { let result = n; while (degree(result) >= degree(polynomial)) result ^= polynomial << degree(result) - degree(polynomial); return result; };
  const format = (8 << 10 | bch(8 << 10, 0x537)) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const dark = !!(format >> i & 1);
    matrix[i < 6 ? i : i < 8 ? i + 1 : size - 15 + i][8] = dark;
    matrix[8][i < 8 ? size - i - 1 : i < 9 ? 15 - i : 15 - i - 1] = dark;
  }
  matrix[size - 8][8] = true;
  const version = versionNumber << 12 | bch(versionNumber << 12, 0x1f25);
  for (let i = 0; versionNumber >= 7 && i < 18; i++) {
    matrix[Math.floor(i / 3)][i % 3 + size - 11] = !!(version >> i & 1);
    matrix[i % 3 + size - 11][Math.floor(i / 3)] = !!(version >> i & 1);
  }
  let row = size - 1, direction = -1, bit = 0;
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column--;
    while (true) {
      for (let c = 0; c < 2; c++) {
        if (matrix[row][column - c] !== null) continue;
        const dark = bit < wire.length * 8 && !!(wire[Math.floor(bit / 8)] >> 7 - bit % 8 & 1);
        matrix[row][column - c] = (row + column - c) % 2 === 0 ? !dark : dark;
        bit++;
      }
      row += direction;
      if (row < 0 || row >= size) { row -= direction; direction = -direction; break; }
    }
  }
  return matrix.map(line => line.map(Boolean));
}

export function assistantQRSvg(value: string) {
  const matrix = assistantQRMatrix(value);
  const size = matrix.length + 8;
  const path: string[] = [];
  matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) path.push(`M${x + 4} ${y + 4}h1v1h-1z`); }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 4}" height="${size * 4}" viewBox="0 0 ${size} ${size}"><path fill="white" d="M0 0h${size}v${size}H0z"/><path fill="black" d="${path.join('')}"/></svg>`;
}

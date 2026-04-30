/**
 * Minimal hand-rolled QR code encoder — byte mode, error correction
 * level L (highest data capacity, ~7% recoverability — fine for the
 * short redirect URLs we generate, which are ~30–80 chars).
 *
 * Ported from project Nayuki's QR-Code-generator reference algorithm
 * (public domain). Trimmed to the cases we actually exercise:
 *   - byte mode only (UTF-8 of the input string)
 *   - error correction level L only
 *   - versions 1–10 (auto-selects smallest fitting version; up to 213
 *     bytes of data, more than enough for /q/<7chars>)
 *   - one fixed mask pattern (we evaluate all 8 and pick the lowest
 *     penalty score, which is the standard QR algorithm)
 *
 * Output: a self-contained SVG string with <rect> modules. No external
 * deps, no runtime fetches.
 *
 * IMPORTANT: This must produce a scannable QR code on a real phone.
 * The math is well-trodden; the test suite asserts the structural
 * invariants (finder patterns, timing patterns, format info bits).
 *
 * If you need to extend this beyond version 10 or beyond byte mode,
 * port the additional pieces from Nayuki's reference rather than
 * patching ad-hoc.
 */

/* ------------------------------------------------------------------ */
/* QR spec tables                                                      */
/* ------------------------------------------------------------------ */

/* Number of error-correction codewords per block at level L,
   indexed by version (1-based; versions 1–10 covered). */
const ECC_CODEWORDS_PER_BLOCK_L: number[] = [
  -1, // index 0 unused
  7,  // v1
  10, // v2
  15, // v3
  20, // v4
  26, // v5
  18, // v6
  20, // v7
  24, // v8
  30, // v9
  18, // v10
];

/* Number of error-correction blocks at level L, indexed by version. */
const NUM_ERROR_CORRECTION_BLOCKS_L: number[] = [
  -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4,
];

/* ------------------------------------------------------------------ */
/* Reed-Solomon (Galois Field 256) helpers                             */
/* ------------------------------------------------------------------ */

/* GF(2^8) multiplication, reducing modulo the QR primitive polynomial
   0x11D (x^8 + x^4 + x^3 + x^2 + 1). */
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/* Build the RS generator polynomial of given degree. */
function rsGenerator(degree: number): number[] {
  if (degree < 1) throw new Error("rs degree must be >= 1");
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/* Compute RS remainder for given data + generator. */
function rsRemainder(data: number[], generator: number[]): number[] {
  const result = new Array<number>(generator.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < generator.length; i += 1) {
      result[i] ^= gfMul(generator[i], factor);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* BitBuffer — append codewords bit-by-bit                             */
/* ------------------------------------------------------------------ */

class BitBuffer {
  private bits: number[] = [];

  append(value: number, len: number): void {
    if (len < 0 || len > 31 || value >>> len !== 0) {
      // QR fields are at most 16 bits in our subset; this is a safety net.
      if (len < 0 || len > 31) throw new Error("bad bitlength");
    }
    for (let i = len - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  length(): number {
    return this.bits.length;
  }

  toBytes(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8 && i + j < this.bits.length; j += 1) {
        b = (b << 1) | this.bits[i + j];
      }
      // Pad final partial byte left-aligned.
      if (i + 8 > this.bits.length) {
        b <<= 8 - (this.bits.length - i);
      }
      out.push(b & 0xff);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Capacity helpers                                                    */
/* ------------------------------------------------------------------ */

/* Total number of data modules in a QR code of given version. */
function getNumRawDataModules(version: number): number {
  const size = version * 4 + 17;
  let result = size * size;
  result -= 8 * 8 * 3; // three finder patterns + separators
  result -= 15 * 2 + 1; // format info
  result -= (size - 16) * 2; // timing patterns
  if (version >= 2) {
    /* Alignment patterns. For v2–v6 there's exactly one extra
       alignment pattern; the formula below covers v1–v6 only. We
       cap at v10, where the alignment count is 6. */
    const numAlign = Math.floor(version / 7) + 2;
    result -= (numAlign - 1) * (numAlign - 1) * 25;
    result -= (numAlign - 2) * 2 * 20;
    if (version >= 7) result -= 18 * 2; // version info
  }
  return result;
}

/* Total number of data codewords (8 bits each) at given version + ECC L. */
function getNumDataCodewords(version: number): number {
  return (
    Math.floor(getNumRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK_L[version] * NUM_ERROR_CORRECTION_BLOCKS_L[version]
  );
}

/* For byte-mode at version v, the character-count indicator is:
   - 8 bits  for v1–9
   - 16 bits for v10–v26
   - 16 bits for v27–v40 (we cap at 10 anyway) */
function byteModeCharCountBits(version: number): number {
  if (version < 1 || version > 40) throw new Error("bad version");
  if (version <= 9) return 8;
  return 16;
}

/* ------------------------------------------------------------------ */
/* Encoder                                                             */
/* ------------------------------------------------------------------ */

interface Encoded {
  version: number;
  size: number;
  codewords: number[]; // data + ECC interleaved per spec
}

function encode(data: Uint8Array): Encoded {
  /* Pick the smallest version (1–10) whose data capacity at level L
     fits the input + 4-bit mode + char-count + terminator. */
  let version = 1;
  for (; version <= 10; version += 1) {
    const charCountBits = byteModeCharCountBits(version);
    const totalBits = 4 + charCountBits + data.length * 8;
    const cap = getNumDataCodewords(version) * 8;
    if (totalBits <= cap) break;
  }
  if (version > 10) {
    throw new Error(
      `[qr/svg] Input too long for v1–v10 (${data.length} bytes). Bump support if needed.`,
    );
  }

  const bb = new BitBuffer();
  /* Mode indicator: byte mode = 0100. */
  bb.append(0b0100, 4);
  /* Character count. */
  bb.append(data.length, byteModeCharCountBits(version));
  /* Data bytes. */
  for (const b of data) bb.append(b, 8);

  /* Terminator (up to 4 zero bits). */
  const dataCap = getNumDataCodewords(version) * 8;
  const terminator = Math.min(4, dataCap - bb.length());
  bb.append(0, terminator);
  /* Pad to byte boundary. */
  while (bb.length() % 8 !== 0) bb.append(0, 1);

  /* Pad bytes 0xEC, 0x11 alternating until we fill the data capacity. */
  const dataBytes = bb.toBytes();
  while (dataBytes.length < dataCap / 8) {
    dataBytes.push(dataBytes.length % 2 === (dataCap / 8) % 2 ? 0xec : 0x11);
  }
  /* Normalize: spec says first pad byte is 0xEC, second 0x11. The
     loop above can flip them depending on starting parity; redo
     deterministically. */
  const numDataCodewords = dataCap / 8;
  while (dataBytes.length > numDataCodewords) dataBytes.pop();
  for (let i = bb.length() / 8; i < numDataCodewords; i += 1) {
    dataBytes[i] = (i - bb.length() / 8) % 2 === 0 ? 0xec : 0x11;
  }

  /* Split into blocks, compute per-block ECC, interleave. */
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_L[version];
  const totalEcc = ECC_CODEWORDS_PER_BLOCK_L[version] * numBlocks;
  const totalCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (totalCodewords % numBlocks);
  const shortBlockLen = Math.floor(totalCodewords / numBlocks);

  const blocks: number[][] = [];
  const generator = rsGenerator(ECC_CODEWORDS_PER_BLOCK_L[version]);
  let k = 0;
  for (let i = 0; i < numBlocks; i += 1) {
    const datLen =
      shortBlockLen - ECC_CODEWORDS_PER_BLOCK_L[version] +
      (i < numShortBlocks ? 0 : 1);
    const dat = dataBytes.slice(k, k + datLen);
    k += datLen;
    const ecc = rsRemainder(dat, generator);
    if (i < numShortBlocks) dat.push(0); // placeholder so all data arrays line up
    blocks.push(dat.concat(ecc));
  }
  void totalEcc;

  /* Interleave column-by-column. */
  const result: number[] = [];
  for (let col = 0; col < blocks[0].length; col += 1) {
    for (let row = 0; row < blocks.length; row += 1) {
      // Skip the placeholder zero we added to short blocks at the
      // last data-column index.
      if (
        col === shortBlockLen - ECC_CODEWORDS_PER_BLOCK_L[version] &&
        row < numShortBlocks
      ) {
        continue;
      }
      result.push(blocks[row][col]);
    }
  }

  return { version, size: version * 4 + 17, codewords: result };
}

/* ------------------------------------------------------------------ */
/* Module placement                                                    */
/* ------------------------------------------------------------------ */

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () =>
      new Array<boolean>(size).fill(false),
    );
    this.reserved = Array.from({ length: size }, () =>
      new Array<boolean>(size).fill(false),
    );
  }

  set(x: number, y: number, value: boolean, reserved = false): void {
    this.modules[y][x] = value;
    if (reserved) this.reserved[y][x] = true;
  }

  reserve(x: number, y: number): void {
    this.reserved[y][x] = true;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.size && y >= 0 && y < this.size;
  }
}

function placeFinderPattern(m: Matrix, x: number, y: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const xx = x + dx;
      const yy = y + dy;
      if (!m.inBounds(xx, yy)) continue;
      const inOuter =
        dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 &&
        (dx === 0 || dx === 6 || dy === 0 || dy === 6);
      const inInner = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      m.set(xx, yy, inOuter || inInner, true);
    }
  }
}

function placeTimingPatterns(m: Matrix): void {
  for (let i = 0; i < m.size; i += 1) {
    if (!m.reserved[6][i]) m.set(i, 6, i % 2 === 0, true);
    if (!m.reserved[i][6]) m.set(6, i, i % 2 === 0, true);
  }
}

const ALIGNMENT_PATTERN_POSITIONS: number[][] = [
  [], // v0 unused
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

function placeAlignmentPatterns(m: Matrix, version: number): void {
  const positions = ALIGNMENT_PATTERN_POSITIONS[version] ?? [];
  for (const cy of positions) {
    for (const cx of positions) {
      /* Skip the three corners that overlap finder patterns. */
      if ((cx === 6 && cy === 6) ||
          (cx === 6 && cy === m.size - 7) ||
          (cx === m.size - 7 && cy === 6)) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const xx = cx + dx;
          const yy = cy + dy;
          if (!m.inBounds(xx, yy)) continue;
          const inOuter = Math.max(Math.abs(dx), Math.abs(dy)) === 2;
          const center = dx === 0 && dy === 0;
          m.set(xx, yy, inOuter || center, true);
        }
      }
    }
  }
}

function reserveFormatInfoArea(m: Matrix): void {
  /* Format info is 15 bits, placed twice. We just reserve here; bits
     are written after we pick a mask. */
  for (let i = 0; i <= 8; i += 1) {
    m.reserve(8, i);
    m.reserve(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    m.reserve(8, m.size - 1 - i);
    m.reserve(m.size - 1 - i, 8);
  }
  /* Dark module — always set, always reserved. */
  m.set(8, m.size - 8, true, true);
}

function placeData(m: Matrix, codewords: number[]): boolean[] {
  /* Snake fill column-pair right-to-left, alternating up/down. */
  const dataBits: number[] = [];
  for (const b of codewords) {
    for (let i = 7; i >= 0; i -= 1) dataBits.push((b >>> i) & 1);
  }
  /* Track which data positions we filled (in placement order) so we
     can apply the mask to only the data modules. */
  const filledPositions: Array<{ x: number; y: number }> = [];
  let bitIdx = 0;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip vertical timing pattern
    for (let vert = 0; vert < m.size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;
        if (m.reserved[y][x]) continue;
        const bit = bitIdx < dataBits.length ? dataBits[bitIdx] : 0;
        m.set(x, y, bit === 1);
        filledPositions.push({ x, y });
        bitIdx += 1;
      }
    }
  }
  /* Return a parallel boolean[] for use during mask evaluation. */
  return filledPositions.map((p) => m.modules[p.y][p.x]);
}

/* ------------------------------------------------------------------ */
/* Mask + format info                                                  */
/* ------------------------------------------------------------------ */

function maskCondition(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error("bad mask");
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let y = 0; y < m.size; y += 1) {
    for (let x = 0; x < m.size; x += 1) {
      if (m.reserved[y][x]) continue;
      if (maskCondition(mask, x, y)) {
        m.modules[y][x] = !m.modules[y][x];
      }
    }
  }
}

/* Compute QR penalty for current matrix (lower is better). */
function computePenalty(m: Matrix): number {
  let penalty = 0;
  const size = m.size;

  /* Rule 1: runs of ≥ 5 same-color modules in row/column. */
  for (let y = 0; y < size; y += 1) {
    let runColor = m.modules[y][0];
    let runLen = 1;
    for (let x = 1; x < size; x += 1) {
      if (m.modules[y][x] === runColor) {
        runLen += 1;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = m.modules[y][x];
        runLen = 1;
      }
    }
  }
  for (let x = 0; x < size; x += 1) {
    let runColor = m.modules[0][x];
    let runLen = 1;
    for (let y = 1; y < size; y += 1) {
      if (m.modules[y][x] === runColor) {
        runLen += 1;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = m.modules[y][x];
        runLen = 1;
      }
    }
  }

  /* Rule 2: 2x2 blocks of same color. */
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = m.modules[y][x];
      if (
        m.modules[y][x + 1] === c &&
        m.modules[y + 1][x] === c &&
        m.modules[y + 1][x + 1] === c
      ) {
        penalty += 3;
      }
    }
  }

  /* Rule 3: 1011101 patterns. */
  const finderLike = (run: boolean[]): boolean => {
    if (run.length < 7) return false;
    return (
      run[0] && !run[1] && run[2] && run[3] && run[4] && !run[5] && run[6]
    );
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x <= size - 7; x += 1) {
      const seg = m.modules[y].slice(x, x + 7);
      if (finderLike(seg)) penalty += 40;
    }
  }
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y <= size - 7; y += 1) {
      const seg: boolean[] = [];
      for (let i = 0; i < 7; i += 1) seg.push(m.modules[y + i][x]);
      if (finderLike(seg)) penalty += 40;
    }
  }

  /* Rule 4: dark/light balance. */
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) if (m.modules[y][x]) dark += 1;
  }
  const ratio = (dark * 100) / (size * size);
  const k = Math.floor(Math.abs(ratio - 50) / 5);
  penalty += k * 10;

  return penalty;
}

/* Format-info bits for ECC level L + chosen mask, BCH(15,5)-encoded
   and XORed with the spec mask 0x5412. Lookup table is the spec's
   precomputed values for level L. */
const FORMAT_INFO_L: number[] = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];

function placeFormatBits(m: Matrix, mask: number): void {
  const bits = FORMAT_INFO_L[mask];
  /* Bits 0..14, MSB first. */
  for (let i = 0; i < 15; i += 1) {
    const bit = ((bits >>> (14 - i)) & 1) === 1;
    /* First copy: row 8 (top-left bottom-left, skipping timing col 6) */
    if (i < 6) m.set(8, i, bit, true);
    else if (i < 8) m.set(8, i + 1, bit, true);
    else if (i < 9) m.set(8, m.size - 7, bit, true); // matches spec pos
    else m.set(8, m.size - 15 + i, bit, true);
  }
  for (let i = 0; i < 15; i += 1) {
    const bit = ((bits >>> i) & 1) === 1;
    if (i < 8) m.set(m.size - 1 - i, 8, bit, true);
    else if (i < 9) m.set(15 - i + m.size - 7 - 1, 8, bit, true);
    else m.set(14 - i, 8, bit, true);
  }
  /* Dark module. */
  m.set(8, m.size - 8, true, true);
}

/* ------------------------------------------------------------------ */
/* Top-level render                                                    */
/* ------------------------------------------------------------------ */

function buildMatrix(text: string): Matrix {
  const utf8 = new TextEncoder().encode(text);
  const enc = encode(utf8);
  const m = new Matrix(enc.size);

  placeFinderPattern(m, 0, 0);
  placeFinderPattern(m, m.size - 7, 0);
  placeFinderPattern(m, 0, m.size - 7);
  placeAlignmentPatterns(m, enc.version);
  placeTimingPatterns(m);
  reserveFormatInfoArea(m);
  placeData(m, enc.codewords);

  /* Pick the mask with the lowest penalty score. */
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    /* Apply, score, unapply. */
    applyMask(m, mask);
    placeFormatBits(m, mask);
    const score = computePenalty(m);
    if (score < bestPenalty) {
      bestPenalty = score;
      bestMask = mask;
    }
    /* Undo: applyMask is its own inverse (XOR), and re-placing format
       bits is idempotent because the next iteration overwrites them. */
    applyMask(m, mask);
  }
  applyMask(m, bestMask);
  placeFormatBits(m, bestMask);
  return m;
}

export interface RenderOpts {
  size?: number;
  dark?: string;
  light?: string;
}

export function renderQrSvg(text: string, opts?: RenderOpts): string {
  if (!text) throw new Error("renderQrSvg: text is required");
  const size = Math.max(64, Math.floor(opts?.size ?? 256));
  const dark = opts?.dark ?? "#000";
  const light = opts?.light ?? "#fff";

  const matrix = buildMatrix(text);
  /* 1-module quiet zone is the spec minimum; QR scanners want 4. */
  const quiet = 4;
  const total = matrix.size + quiet * 2;
  const px = size / total;

  const rects: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.modules[y][x]) {
        const sx = (x + quiet) * px;
        const sy = (y + quiet) * px;
        /* +0.5 px width prevents hairline gaps between modules at
           non-integer pixel sizes when the SVG is rasterized. */
        rects.push(
          `<rect x="${sx.toFixed(3)}" y="${sy.toFixed(3)}" width="${(px + 0.5).toFixed(3)}" height="${(px + 0.5).toFixed(3)}"/>`,
        );
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`,
    `<rect width="${size}" height="${size}" fill="${light}"/>`,
    `<g fill="${dark}">${rects.join("")}</g>`,
    `</svg>`,
  ].join("");
}

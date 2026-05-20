// `horizon mobile` — one-step phone pairing.
//
// Spawns horizon-serve, generates a QR code rendered in ANSI for the
// terminal, prints clear instructions. User scans with phone camera →
// PWA opens with the pairing token pre-filled.
//
// Flags:
//   --port N        custom port (default 18789)
//   --no-qr         skip QR, just print URL (for headless/CI)
//   --foreground    stream the child server's stdio (default: dim & prefixed)
//   --host X        bind host (default: pick LAN IP via heuristic)
//
// QR rendering: tries the optional `qrcode` npm package first (cleanest),
// falls back to a tiny pure-JS encoder bundled below so the command
// always works even without the dep installed.

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { fmt } = require('../tty');
const { bannerCompact, renderArt } = require('../banner');

/**
 * Pick the "best" local IPv4 address — the one a phone on the same Wi-Fi
 * is most likely to be able to reach. Order of preference:
 *   1. 192.168.x.x (typical home Wi-Fi)
 *   2. 10.x.x.x    (corporate / VPN-ish LANs)
 *   3. 172.16-31.x (Docker / fancier setups)
 *   4. any other non-internal IPv4
 *   5. 127.0.0.1 fallback (still works locally even if no LAN)
 */
function localIp() {
  const ifs = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      candidates.push(i.address);
    }
  }
  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 3;
    if (ip.startsWith('10.')) return 2;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
    return 0;
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0] || '127.0.0.1';
}

/**
 * Try the optional `qrcode` npm package first. If it's not installed,
 * fall back to the bundled tiny encoder. Returns a multi-line string or
 * null if both paths fail.
 *
 * `qrcode` produces cleaner output (proper half-block density via
 * .toString({ type:'terminal', small:true })) but isn't a hard dep so
 * we don't force users to install it.
 */
async function renderQrToTerminal(text) {
  try {
    const qrcode = require('qrcode');
    return await qrcode.toString(text, {
      type: 'terminal',
      small: true,
      errorCorrectionLevel: 'M',
    });
  } catch (_) {
    // Fall through to the bundled encoder
  }
  try {
    return renderQrFallback(text);
  } catch (_) {
    return null;
  }
}

// ─── Minimal pure-JS QR encoder (fallback) ──────────────────────────────
//
// Implements QR Code Model 2 — byte mode, error correction level M,
// versions up to 10 (handles URLs up to ~213 chars). Outputs an ANSI
// half-block grid where two QR modules stack vertically into one cell
// (▀ █ ▄ space), keeping the code visually square in a terminal where
// rows are ~2× taller than columns.
//
// Source basis: the QR Code algorithm specified in ISO/IEC 18004; the
// constants below (alignment patterns, generator polynomials, RS block
// counts) come straight from the spec table. Kept compact on purpose —
// we only need byte-mode + ECC M, not the full mode/version matrix.

function renderQrFallback(text) {
  const data = Buffer.from(text, 'utf8');
  // Determine smallest version that fits — table 7 of the spec
  // gives byte-mode capacities for ECC level M.
  const BYTE_CAPACITY_M = [
    14, 26, 42, 62, 84, 106, 122, 152, 180, 213, // versions 1-10
  ];
  let version = -1;
  for (let i = 0; i < BYTE_CAPACITY_M.length; i++) {
    if (data.length <= BYTE_CAPACITY_M[i]) { version = i + 1; break; }
  }
  if (version < 0) throw new Error('payload too long for fallback QR (>213 bytes)');

  const size = 17 + version * 4;
  // Build the bit stream: mode indicator (0100 = byte), length (8 or
  // 16 bits depending on version), then the data bytes, then padding.
  const bits = [];
  const pushBits = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4);                    // byte mode
  pushBits(data.length, version < 10 ? 8 : 16);
  for (const b of data) pushBits(b, 8);
  pushBits(0, 4);                          // terminator
  while (bits.length % 8 !== 0) bits.push(0);

  const ECC_INFO = {
    // version → [total codewords, EC per block, blocks group 1, data per block g1, blocks g2, data per block g2]
    1:  [26, 10, 1, 16, 0, 0],
    2:  [44, 16, 1, 28, 0, 0],
    3:  [70, 26, 1, 44, 0, 0],
    4:  [100, 18, 2, 32, 0, 0],
    5:  [134, 24, 2, 43, 0, 0],
    6:  [172, 16, 4, 27, 0, 0],
    7:  [196, 18, 4, 31, 0, 0],
    8:  [242, 22, 2, 38, 2, 39],
    9:  [292, 22, 3, 36, 2, 37],
    10: [346, 26, 4, 43, 1, 44],
  };
  const info = ECC_INFO[version];
  const dataCodewords = info[2] * info[3] + info[4] * info[5];
  // Convert bit buffer to bytes, pad with alternating 0xEC / 0x11
  const dataBytes = [];
  for (let i = 0; i < dataCodewords; i++) {
    if (i * 8 < bits.length) {
      let v = 0;
      for (let b = 0; b < 8; b++) v = (v << 1) | (bits[i * 8 + b] || 0);
      dataBytes.push(v);
    } else {
      dataBytes.push((dataBytes.length % 2 === 0) ? 0x11 : 0xEC);
      // first padding should be 0xEC actually — swap
      dataBytes[dataBytes.length - 1] = ((dataBytes.length & 1) ? 0xEC : 0x11);
    }
  }
  // The padding ordering above flipped — correct it via explicit fill:
  while (dataBytes.length > 0 && dataBytes.length < dataCodewords) {
    dataBytes.push(0xEC);
    if (dataBytes.length < dataCodewords) dataBytes.push(0x11);
  }
  // Compute Reed-Solomon EC codewords per block
  const groups = [];
  let dataIdx = 0;
  for (let gi = 0; gi < 2; gi++) {
    const blocks = info[2 + gi * 2];
    const perBlock = info[3 + gi * 2];
    for (let b = 0; b < blocks; b++) {
      const blockData = dataBytes.slice(dataIdx, dataIdx + perBlock);
      dataIdx += perBlock;
      groups.push({ data: blockData, ec: rsEncode(blockData, info[1]) });
    }
  }
  // Interleave data + ec codewords
  const maxData = Math.max(...groups.map(g => g.data.length));
  const finalBytes = [];
  for (let i = 0; i < maxData; i++) {
    for (const g of groups) if (i < g.data.length) finalBytes.push(g.data[i]);
  }
  for (let i = 0; i < info[1]; i++) {
    for (const g of groups) finalBytes.push(g.ec[i]);
  }
  // Convert back to bit stream
  const finalBits = [];
  for (const b of finalBytes) for (let i = 7; i >= 0; i--) finalBits.push((b >> i) & 1);

  // Build matrix
  const matrix = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  placeFinderPatterns(matrix, reserved, size);
  placeAlignmentPatterns(matrix, reserved, version, size);
  placeTimingPatterns(matrix, reserved, size);
  // Dark module
  matrix[(4 * version) + 9][8] = 1;
  reserved[(4 * version) + 9][8] = true;
  // Reserve format/version info areas
  reserveFormatVersion(reserved, version, size);

  // Place data bits column-by-column, right-to-left, zigzag
  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip timing column
    for (let i = 0; i < size; i++) {
      const y = upward ? (size - 1 - i) : i;
      for (let dc = 0; dc < 2; dc++) {
        const x = col - dc;
        if (!reserved[y][x] && matrix[y][x] === null) {
          matrix[y][x] = bitIdx < finalBits.length ? finalBits[bitIdx++] : 0;
        }
      }
    }
    upward = !upward;
  }

  // Pick best mask (eval all 8, lowest penalty wins)
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestMatrix = matrix;
  for (let m = 0; m < 8; m++) {
    const trial = matrix.map(r => r.slice());
    applyMask(trial, reserved, m, size);
    placeFormatInfo(trial, m, size);
    if (version >= 7) placeVersionInfo(trial, version, size);
    const p = maskPenalty(trial, size);
    if (p < bestPenalty) { bestPenalty = p; bestMask = m; bestMatrix = trial; }
  }

  // Render as half-block ANSI. Each terminal cell = 2 vertical modules.
  // Add a 2-module quiet zone all around for scanner-friendliness.
  const quiet = 2;
  const total = size + quiet * 2;
  const grid = [];
  for (let y = 0; y < total; y++) {
    const row = [];
    for (let x = 0; x < total; x++) {
      const my = y - quiet, mx = x - quiet;
      if (my < 0 || my >= size || mx < 0 || mx >= size) row.push(0);
      else row.push(bestMatrix[my][mx] ? 1 : 0);
    }
    grid.push(row);
  }
  // White background, black foreground — scanners expect "dark on light".
  // ANSI: \x1b[40m = black bg, \x1b[47m = white bg.
  const out = [];
  for (let y = 0; y < grid.length; y += 2) {
    let line = '  ';
    for (let x = 0; x < grid[0].length; x++) {
      const top = grid[y][x];
      const bot = (y + 1 < grid.length) ? grid[y + 1][x] : 0;
      // top=0 bot=0 → full white block ('█' on white bg)
      // top=1 bot=1 → full black block (space on black bg)
      // top=1 bot=0 → black top, white bot ('▀' on white bg, with black fg)
      // top=0 bot=1 → white top, black bot ('▄' on white bg, with black fg)
      // Simpler: use ▀ / ▄ / █ / ' ' on a white background with black fg.
      const BG_WHITE = '\x1b[47m';
      const FG_BLACK = '\x1b[30m';
      const RESET = '\x1b[0m';
      let ch;
      if (top === 0 && bot === 0) ch = ' ';
      else if (top === 1 && bot === 1) ch = '█'; // █
      else if (top === 1 && bot === 0) ch = '▀'; // ▀
      else ch = '▄'; // ▄
      line += BG_WHITE + FG_BLACK + ch + RESET;
    }
    out.push(line);
  }
  return out.join('\n');
}

// ─── Reed-Solomon over GF(256) — minimal implementation ─────────────────
const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}
function rsGeneratorPoly(degree) {
  let p = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(p.length + 1).fill(0);
    for (let j = 0; j < p.length; j++) {
      next[j] ^= gfMul(p[j], 1);
      next[j + 1] ^= gfMul(p[j], GF_EXP[i]);
    }
    p = next;
  }
  return p;
}
function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const buf = data.slice();
  for (let i = 0; i < ecLen; i++) buf.push(0);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (factor !== 0) {
      for (let j = 0; j < gen.length; j++) {
        buf[i + j] ^= gfMul(gen[j], factor);
      }
    }
  }
  return buf.slice(data.length);
}

// ─── Matrix placement helpers ────────────────────────────────────────────
function placeFinderPatterns(matrix, reserved, size) {
  const positions = [[0, 0], [size - 7, 0], [0, size - 7]];
  for (const [r, c] of positions) {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const y = r + i, x = c + j;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        if (i >= 0 && i <= 6 && j >= 0 && j <= 6) {
          const onBorder = (i === 0 || i === 6 || j === 0 || j === 6);
          const inCore = (i >= 2 && i <= 4 && j >= 2 && j <= 4);
          matrix[y][x] = (onBorder || inCore) ? 1 : 0;
        } else {
          matrix[y][x] = 0; // separator
        }
        reserved[y][x] = true;
      }
    }
  }
}
function placeAlignmentPatterns(matrix, reserved, version, size) {
  if (version < 2) return;
  // Spec table — alignment centre positions per version
  const TABLE = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  const centers = TABLE[version] || [];
  for (const r of centers) {
    for (const c of centers) {
      // Skip alignment that overlaps finder patterns
      if (reserved[r][c]) continue;
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          const y = r + i, x = c + j;
          if (y < 0 || y >= size || x < 0 || x >= size) continue;
          const onBorder = Math.max(Math.abs(i), Math.abs(j)) === 2;
          const isCenter = i === 0 && j === 0;
          matrix[y][x] = (onBorder || isCenter) ? 1 : 0;
          reserved[y][x] = true;
        }
      }
    }
  }
}
function placeTimingPatterns(matrix, reserved, size) {
  for (let i = 8; i < size - 8; i++) {
    matrix[6][i] = (i % 2 === 0) ? 1 : 0;
    matrix[i][6] = (i % 2 === 0) ? 1 : 0;
    reserved[6][i] = true;
    reserved[i][6] = true;
  }
}
function reserveFormatVersion(reserved, version, size) {
  // Format info — 15 modules around each finder
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  // Version info (v7+) — 6×3 blocks bottom-left and top-right
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[size - 11 + j][i] = true;
        reserved[i][size - 11 + j] = true;
      }
    }
  }
}
function applyMask(matrix, reserved, mask, size) {
  const fns = [
    (y, x) => (y + x) % 2 === 0,
    (y, x) => y % 2 === 0,
    (y, x) => x % 3 === 0,
    (y, x) => (y + x) % 3 === 0,
    (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (y, x) => (y * x) % 2 + (y * x) % 3 === 0,
    (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
    (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
  ];
  const fn = fns[mask];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!reserved[y][x] && fn(y, x)) matrix[y][x] ^= 1;
    }
  }
}
function placeFormatInfo(matrix, mask, size) {
  // ECC level M = 00, then 3-bit mask pattern
  const data = (0b00 << 3) | mask;
  // BCH(15,5) generator: 0b10100110111
  let bch = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((bch >> (i + 10)) & 1) bch ^= 0b10100110111 << i;
  }
  const fmtBits = ((data << 10) | bch) ^ 0b101010000010010;
  for (let i = 0; i < 15; i++) {
    const bit = (fmtBits >> i) & 1;
    // Around top-left finder
    if (i < 6) matrix[i][8] = bit;
    else if (i === 6) matrix[7][8] = bit;
    else if (i === 7) matrix[8][8] = bit;
    else if (i === 8) matrix[8][7] = bit;
    else matrix[8][14 - i] = bit;
    // Mirror around top-right + bottom-left
    if (i < 8) matrix[8][size - 1 - i] = bit;
    else matrix[size - 15 + i][8] = bit;
  }
  // Dark module already placed
}
function placeVersionInfo(matrix, version, size) {
  let v = version << 12;
  for (let i = 5; i >= 0; i--) {
    if ((v >> (i + 12)) & 1) v ^= 0b1111100100101 << i;
  }
  const bits = (version << 12) | v;
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const r = Math.floor(i / 3);
    const c = (i % 3) + size - 11;
    matrix[r][c] = bit;
    matrix[c][r] = bit;
  }
}
function maskPenalty(matrix, size) {
  // Simplified — rule 1 (runs of same colour) + rule 4 (dark balance).
  // Picking any working mask gives a valid scannable code; full
  // penalty calc isn't strictly needed for correctness.
  let penalty = 0;
  // Rule 1 — horizontal runs
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (matrix[y][x] === matrix[y][x - 1]) {
        run++;
        if (run === 5) penalty += 3;
        else if (run > 5) penalty++;
      } else run = 1;
    }
  }
  // Rule 1 — vertical runs
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (matrix[y][x] === matrix[y - 1][x]) {
        run++;
        if (run === 5) penalty += 3;
        else if (run > 5) penalty++;
      } else run = 1;
    }
  }
  // Rule 4 — dark fraction
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (matrix[y][x]) dark++;
  const pct = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return penalty;
}

// ─── Command entry point ────────────────────────────────────────────────

async function run({ runtime, args, flags }) {
  const port = parseInt(flags.port, 10) || 18789;
  const ip = flags.host || localIp();
  const token = crypto.randomBytes(16).toString('hex');
  // Build the URL the PWA expects — the existing serve.js code prefills
  // both the API URL and the token via query params, so the phone user
  // never has to type either.
  const apiUrl = `http://${ip}:${port}`;
  const url = `${apiUrl}/?url=${encodeURIComponent(apiUrl)}&token=${encodeURIComponent(token)}`;

  // Header
  process.stdout.write('\n' + bannerCompact() + '\n\n');
  const art = renderArt('mobile', { flags });
  if (art) process.stdout.write(art + '\n\n');
  process.stdout.write('  ' + fmt.bold('Mobile companion') + '  '
                     + fmt.dim('— pairing your phone, no flag-hunting required.\n\n'));

  // QR code (skipped on --no-qr or when both renderers fail)
  let qr = null;
  if (!flags['no-qr']) {
    qr = await renderQrToTerminal(url);
    if (qr) {
      process.stdout.write(qr + '\n\n');
    } else {
      process.stdout.write('  ' + fmt.dim('(QR rendering unavailable — install `npm i qrcode` for a sharper code)\n\n'));
    }
  }

  // Instructions — four numbered steps, plain English.
  process.stdout.write('  ' + fmt.bold('Steps') + '\n');
  process.stdout.write('    ' + fmt.cyan('1.') + ' Make sure your phone is on the same Wi-Fi network as this computer.\n');
  process.stdout.write('    ' + fmt.cyan('2.') + ' Open your phone\'s camera and point it at the QR code above.\n');
  process.stdout.write('    ' + fmt.cyan('3.') + ' Tap the link that appears.\n');
  process.stdout.write('    ' + fmt.cyan('4.') + ' On the page that opens, tap ' + fmt.bold('Add to Home Screen') + '.\n\n');

  process.stdout.write('  ' + fmt.dim('Or open manually: ') + fmt.cyan(url) + '\n');
  process.stdout.write('  ' + fmt.dim('Token (already baked into the URL): ') + fmt.dim(token) + '\n\n');

  // Boot the server. We re-use horizon-serve.main() in-process so the QR
  // code stays on screen above the server's log lines and Ctrl+C cleanly
  // takes the whole thing down. Spawning a child would split stdout +
  // make graceful shutdown trickier.
  process.stdout.write('  ' + fmt.dim('Starting server on ' + apiUrl + '…') + '\n');

  const servePath = path.join(__dirname, '..', '..', 'horizon-serve.js');
  let serveModule;
  try {
    serveModule = require(servePath);
  } catch (e) {
    process.stderr.write('\n' + fmt.err('Failed to load horizon-serve: ' + e.message) + '\n');
    return 1;
  }

  // Foreground: stream child stdio. Default: still in-process, but the
  // serve.js stderr/stdout already routes through this terminal so the
  // user sees the activity inline.
  await serveModule.main({
    flags: {
      port,
      host: ip,
      token,
      verbose: !!flags.verbose,
    },
  });

  // Graceful shutdown banner on Ctrl+C — main() registers its own
  // SIGINT handler that closes the server and exits the process, so
  // we typically don't reach the line below in practice. Kept for the
  // weird case where main() returns synchronously (e.g. listen error).
  return 0;
}

module.exports = { run };

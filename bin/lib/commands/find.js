// `horizon find "<query>"` — OCR-find the first match on screen.
//
// Sprint 7D. Wrapper around src/main/ocr.findInImage. Output:
//   - human:  "Submit at (1240,860) 80x32 (conf 94)"
//   - --json: { ok, match: {...} | null }

const path = require('path');
const { fmt } = require('../tty');

function _ocrModule() {
  return require(path.join(__dirname, '..', '..', '..', 'src', 'main', 'ocr'));
}

async function run({ runtime, args, flags }) {
  const query = args.join(' ').trim();
  if (!query) {
    process.stderr.write(fmt.err('Usage: horizon find "<text>"') + '\n');
    return 2;
  }
  const ocr = _ocrModule();
  if (!ocr.isAvailable()) {
    process.stderr.write(fmt.err(ocr.unavailableMessage()) + '\n');
    return 1;
  }

  // Reuse the CLI screen grabber from ocr.js so we share platform branches.
  const { _grabScreenCLI } = require('./ocr');
  let buf;
  try { buf = await _grabScreenCLI(); }
  catch (e) {
    process.stderr.write(fmt.err('Screen capture failed: ' + e.message) + '\n');
    return 1;
  }

  const r = await ocr.findInImage(buf, query, {
    exact: !!flags.exact,
    caseSensitive: !!flags['case-sensitive'],
  });
  if (!r.ok) {
    process.stderr.write(fmt.err(r.error || 'OCR failed') + '\n');
    return 1;
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return r.match ? 0 : 1;
  }
  if (!r.match) {
    process.stdout.write(fmt.dim('(no match)') + '\n');
    return 1;
  }
  const m = r.match;
  process.stdout.write(
    fmt.cyan(m.text) +
    fmt.dim(` at (${m.x},${m.y}) ${m.w}x${m.h} (conf ${m.confidence})`) +
    '\n'
  );
  return 0;
}

module.exports = { run };

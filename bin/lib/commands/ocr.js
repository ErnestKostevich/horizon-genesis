// `horizon ocr <subcommand>` — run OCR on an image or the screen.
//
//   horizon ocr <imagepath>         — OCR a file, print extracted text
//   horizon ocr screen [--display N] — OCR the full screen (CLI uses
//                                     desktopCapturer only when inside
//                                     Electron; otherwise documents the
//                                     limitation cleanly)
//
// Sprint 7D. Tesseract.js is an optional dep — missing it returns a
// non-zero exit with a clear "install tesseract.js" message.

const fs = require('fs');
const path = require('path');
const { fmt } = require('../tty');

function _ocrModule() {
  return require(path.join(__dirname, '..', '..', '..', 'src', 'main', 'ocr'));
}

async function run({ runtime, args, flags }) {
  const target = (args[0] || '').trim();
  if (!target) {
    process.stderr.write(fmt.err('Usage: horizon ocr <imagepath> | horizon ocr screen') + '\n');
    return 2;
  }
  const ocr = _ocrModule();
  if (!ocr.isAvailable()) {
    process.stderr.write(fmt.err(ocr.unavailableMessage()) + '\n');
    process.stderr.write(fmt.dim('  Install:  npm i tesseract.js') + '\n');
    return 1;
  }

  let buf;
  if (target === 'screen') {
    // Outside of Electron, desktopCapturer doesn't exist — try platform
    // tools (screencapture on macOS, screenshot on Linux via scrot,
    // PrintScreen via PowerShell on Windows) to grab a PNG.
    try {
      buf = await _grabScreenCLI();
    } catch (e) {
      process.stderr.write(fmt.err('Cannot capture screen from CLI: ' + e.message) + '\n');
      process.stderr.write(fmt.dim('  Try the Electron app, or pass an image path.') + '\n');
      return 1;
    }
  } else {
    if (!fs.existsSync(target)) {
      process.stderr.write(fmt.err('File not found: ' + target) + '\n');
      return 1;
    }
    buf = fs.readFileSync(target);
  }

  const r = await ocr.runOcr(buf);
  if (!r.ok) {
    process.stderr.write(fmt.err(r.error || 'OCR failed') + '\n');
    return 1;
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(r.text || '');
  process.stdout.write('\n');
  if (flags.verbose) {
    process.stderr.write(fmt.dim(`  ${r.blocks.length} blocks\n`));
  }
  return 0;
}

function _grabScreenCLI() {
  const { exec } = require('child_process');
  const os = require('os');
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `horizon_cli_screen_${Date.now()}.png`);
    let cmd;
    if (process.platform === 'darwin')      cmd = `screencapture -x "${out}"`;
    else if (process.platform === 'linux')  cmd = `import -window root "${out}" 2>/dev/null || scrot "${out}"`;
    else if (process.platform === 'win32')  cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0,0,0,0,$bmp.Size); $bmp.Save('${out.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png)"`;
    else return reject(new Error('Unsupported platform'));
    exec(cmd, { timeout: 8000 }, (err) => {
      if (err) return reject(err);
      try { resolve(fs.readFileSync(out)); } catch (e) { reject(e); }
    });
  });
}

module.exports = { run, _grabScreenCLI };

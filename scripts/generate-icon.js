#!/usr/bin/env node
/**
 * Bake assets/icon.svg into the PNG and ICO assets that Electron + Windows
 * need at runtime.
 *
 *   assets/icon.png     — 512x512 RGBA, used by the tray (resized to 16x16
 *                         on construct), the Windows installer header, and
 *                         macOS dock when no .icns is provided.
 *   assets/icon.ico     — multi-resolution Windows icon (16/24/32/48/64/
 *                         128/256), used by electron-builder for the
 *                         packaged .exe.
 *
 * Run via:  npm run icon:generate
 *
 * The two NPM dependencies (sharp, png-to-ico) are devDependencies, so a
 * fresh `npm install` is enough — no global tools required.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico');

const SVG_PATH = path.join(__dirname, '..', 'assets', 'icon.svg');
const PNG_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const ICO_PATH = path.join(__dirname, '..', 'assets', 'icon.ico');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  const svg = fs.readFileSync(SVG_PATH);

  // Master 512x512 PNG — used for tray + macOS dock + installer header.
  await sharp(svg, { density: 1024 })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(PNG_PATH);
  console.log(`✓ wrote ${path.relative(process.cwd(), PNG_PATH)} (512x512)`);

  // Multi-resolution ICO — Windows decides which size to show by context.
  const pngBuffers = await Promise.all(
    ICO_SIZES.map((size) =>
      sharp(svg, { density: 1024 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer()
    )
  );
  const icoBuffer = await pngToIco(pngBuffers);
  fs.writeFileSync(ICO_PATH, icoBuffer);
  console.log(`✓ wrote ${path.relative(process.cwd(), ICO_PATH)} (sizes: ${ICO_SIZES.join(', ')})`);
}

main().catch((err) => {
  console.error('icon generation failed:', err && err.message || err);
  process.exit(1);
});

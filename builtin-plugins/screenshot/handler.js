'use strict';
/**
 * Screenshot — built-in Horizon plugin.
 * Uses Electron's `desktopCapturer` to grab the primary display, encodes
 * via the existing nativeImage API. No platform-specific shell calls.
 */
const { desktopCapturer, nativeImage, app, screen } = require('electron');
const fs = require('fs');
const path = require('path');

async function captureBuffer() {
  // Match the actual screen pixel size so the capture isn't downscaled.
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: width || 1920, height: height || 1080 },
  });
  if (!sources.length) throw new Error('No screen sources available');
  const src = sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) throw new Error('Captured screenshot is empty');
  return img.toPNG(); // returns Buffer
}

module.exports = {
  async execute(tool /* , args */) {
    if (tool === 'capture') {
      try {
        const buf = await captureBuffer();
        const dir = path.join(app.getPath('userData'), 'screenshots');
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
        // Filename matches the pattern handleWorkflowRunEffects sanitises
        // — `screenshot-<digits>.png` — so it can flow through the
        // workflow result rendering safely.
        const file = path.join(dir, `screenshot-${Date.now()}.png`);
        fs.writeFileSync(file, buf);
        return {
          ok: true,
          out: `Screenshot saved: ${file}`,
          path: file,
          bytes: buf.length,
        };
      } catch (e) { return { ok: false, error: e.message }; }
    }

    if (tool === 'capture_base64') {
      try {
        const buf = await captureBuffer();
        const b64 = buf.toString('base64');
        return {
          ok: true,
          out: `Captured ${buf.length} bytes`,
          base64: b64,
          dataUrl: `data:image/png;base64,${b64}`,
          bytes: buf.length,
        };
      } catch (e) { return { ok: false, error: e.message }; }
    }

    return { ok: false, error: `Unknown tool: ${tool}` };
  },
};

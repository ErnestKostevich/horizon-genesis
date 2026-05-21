'use strict';
/**
 * Horizon AI — Multi-monitor screenshot / click support
 *
 * Sprint 7D — agent tools previously assumed a single primary display. This
 * module enumerates Electron's `screen.getAllDisplays()`, maps display-relative
 * coordinates to global desktop coords, and routes screenshot / click ops to
 * the right physical screen.
 *
 * Exports:
 *   - listDisplays()                              — [{id,label,primary,bounds,scaleFactor}]
 *   - getDisplay(displayId)                       — single display record or null
 *   - captureDisplay(displayId, opts)             — { ok, base64, path, display }
 *   - captureAll(opts)                            — [{ ok, base64, path, display }, ...]
 *   - toGlobalCoords(displayId, x, y)             — { x, y } in absolute desktop coords
 *   - fromGlobalCoords(x, y)                      — { displayId, x, y } (relative)
 *
 * `displayId === null` everywhere means "use primary".
 *
 * Linux note: `xdotool` does NOT support multi-monitor display selection
 * by default. We accept this as a known limitation and document it in the
 * graceful-fallback path — `mouseClickOnDisplay` resolves to global
 * coordinates and calls plain `xdotool` which Just Works™ on most setups
 * because the global coordinate space spans all monitors.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Lazy-load Electron — this module is also exercised from the CLI/test
// path where Electron's `screen` is not available.
function _screen() {
  try { return require('electron').screen; } catch (_) { return null; }
}

function _desktopCapturer() {
  try { return require('electron').desktopCapturer; } catch (_) { return null; }
}

/**
 * Normalize an Electron Display object into our flat record.
 */
function _normalize(d, isPrimary) {
  const b = d.bounds || {};
  return {
    id: d.id,
    label: d.label || `Display ${d.id}`,
    primary: !!isPrimary,
    bounds: {
      x: b.x | 0,
      y: b.y | 0,
      w: (b.width  || b.w  || 0) | 0,
      h: (b.height || b.h  || 0) | 0,
    },
    scaleFactor: d.scaleFactor || 1,
    rotation: d.rotation || 0,
    internal: !!d.internal,
  };
}

function listDisplays() {
  const screen = _screen();
  if (!screen) return [];
  try {
    const primary = screen.getPrimaryDisplay();
    const all = screen.getAllDisplays();
    return all.map(d => _normalize(d, d.id === primary.id));
  } catch (_) {
    return [];
  }
}

function getDisplay(displayId) {
  const list = listDisplays();
  if (!list.length) return null;
  if (displayId == null) return list.find(d => d.primary) || list[0];
  return list.find(d => d.id === displayId) || null;
}

/**
 * desktopCapturer's source list isn't in the same order as
 * screen.getAllDisplays(), but each source's `display_id` (string) maps
 * back to Display.id. Some Electron versions only expose this on
 * `source.id` — we try a couple of strategies.
 */
function _sourceMatchesDisplay(source, displayId) {
  // Strategy 1: explicit display_id (set on Linux + recent versions)
  if (source.display_id && String(source.display_id) === String(displayId)) return true;
  // Strategy 2: source.id pattern "screen:<num>:<displayId>" on some builds
  if (typeof source.id === 'string' && source.id.endsWith(':' + displayId)) return true;
  return false;
}

/**
 * Capture a specific display. Falls back to "primary" when displayId is
 * null/unknown. opts.thumbWidth/thumbHeight let the caller down-sample
 * (useful for vision LLMs) but the OCR path wants full-resolution PNG so
 * we use the bounds when no thumb size is passed.
 */
async function captureDisplay(displayId, opts = {}) {
  const dc = _desktopCapturer();
  if (!dc) return { ok: false, error: 'desktopCapturer unavailable' };

  const display = getDisplay(displayId);
  if (!display) return { ok: false, error: 'No display found' };

  const w = Math.max(64, (opts.thumbWidth  || display.bounds.w || 1920) | 0);
  const h = Math.max(64, (opts.thumbHeight || display.bounds.h || 1080) | 0);

  try {
    const sources = await dc.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
    if (!sources.length) return { ok: false, error: 'No screen source' };

    // Try to find the source whose display_id matches; otherwise index-fallback.
    let src = sources.find(s => _sourceMatchesDisplay(s, display.id));
    if (!src) {
      // Index fallback — assume sources are in screen.getAllDisplays() order.
      const all = listDisplays();
      const idx = all.findIndex(d => d.id === display.id);
      if (idx >= 0 && sources[idx]) src = sources[idx];
    }
    if (!src) src = sources[0];

    const buf = src.thumbnail.toPNG();
    const tmpPath = opts.savePath || path.join(os.tmpdir(), `horizon_ss_${display.id}_${Date.now()}.png`);
    if (opts.savePath !== false) {
      try { fs.writeFileSync(tmpPath, buf); } catch (_) {}
    }
    return {
      ok: true,
      base64: buf.toString('base64'),
      buffer: buf,
      path: tmpPath,
      display,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Capture every display. Returns an array — empty array if Electron's
 * screen module isn't available (e.g. CLI context).
 */
async function captureAll(opts = {}) {
  const displays = listDisplays();
  if (!displays.length) return [];
  const out = [];
  for (const d of displays) {
    out.push(await captureDisplay(d.id, opts));
  }
  return out;
}

/**
 * Display-relative (x,y) → global desktop (x,y).
 * If displayId is null/unknown, we pass through (assume coords are already global).
 */
function toGlobalCoords(displayId, x, y) {
  const d = getDisplay(displayId);
  if (!d) return { x: x|0, y: y|0 };
  return { x: (d.bounds.x | 0) + (x | 0), y: (d.bounds.y | 0) + (y | 0) };
}

/**
 * Global desktop (x,y) → { displayId, x, y } (display-relative).
 * Useful when a click came back from `pcGetMousePos`.
 */
function fromGlobalCoords(x, y) {
  const list = listDisplays();
  for (const d of list) {
    const b = d.bounds;
    if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) {
      return { displayId: d.id, x: x - b.x, y: y - b.y, display: d };
    }
  }
  // No display contains this point — return as primary-relative for safety.
  const primary = getDisplay(null);
  return { displayId: primary?.id ?? null, x: x|0, y: y|0, display: primary };
}

module.exports = {
  listDisplays,
  getDisplay,
  captureDisplay,
  captureAll,
  toGlobalCoords,
  fromGlobalCoords,
  // exported for tests
  _normalize,
};

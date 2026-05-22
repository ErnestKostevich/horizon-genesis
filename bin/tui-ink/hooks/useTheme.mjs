// bin/tui-ink/hooks/useTheme.mjs
//
// Tiny hook that exposes the active CLI theme (read from runtime
// settingsStore) as a stable object with RGB tuples and helpers. Ink
// components consume the RGB tuples directly via the `color` prop on
// <Text> — but the prop wants either a named ANSI color OR a hex/rgb
// string. We coerce both ways.

import { useMemo } from 'react';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const themes = require('../../lib/themes.js');

export default function useTheme(runtime) {
  return useMemo(() => {
    const name = safeGet(runtime, 'settingsStore', 'cliTheme') || 'default';
    const theme = themes.getTheme(name);
    return {
      name,
      raw: theme,
      // Convenience getters for the common semantic colours.
      accent: rgbHex(theme.accent),
      success: rgbHex(theme.success),
      warn: rgbHex(theme.warn),
      err: rgbHex(theme.err),
      dim: rgbHex(theme.dim),
      cyan: rgbHex(theme.cyan),
      magenta: rgbHex(theme.magenta),
    };
  }, [runtime]);
}

function safeGet(runtime, store, key) {
  try { return runtime?.[store]?.get?.(key); } catch (_) { return undefined; }
}

function rgbHex([r, g, b]) {
  if (typeof r !== 'number') return undefined;
  const h = (n) => n.toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

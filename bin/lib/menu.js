// Inline interactive menu — Phase 20.3 polish, refined for the
// "premium" pass that gives the picker box-drawing borders, grouped
// headers, accent highlights, an aside column, and an in-place search
// filter.
//
// Used by the TUI when a slash command wants to offer a pickable list
// (e.g. /skill list, /persona-list, /model-list, /models). The engine
// is paused for the duration so the menu owns stdin; on resolve /
// cancel the engine resumes and the picked value gets returned to the
// caller.
//
// Behaviour:
//   ↑/↓ or k/j    move highlight (skips group headers + filtered rows)
//   PgUp / PgDn   jump by a page
//   Home / End    jump to first / last visible row
//   Enter         select highlighted row
//   /             open inline search filter (Esc to cancel filter only)
//   Mouse wheel   scroll the highlight up/down
//   Esc / q       cancel (resolves to null)
//
// The highlighted row uses reverse-video + an accent ▶ marker. Mouse
// clicks are intentionally a no-op (mouse leak history — see Sprint
// 2.6 notes); Enter is the only commit gesture.

const readline = require('readline');
const { fmt } = require('./tty');

const ANSI = {
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  mouseOn:  '\x1b[?1000h\x1b[?1006h',
  mouseOff: '\x1b[?1000l\x1b[?1006l',
  clearLine: '\x1b[2K',
  cursorUp:  (n) => `\x1b[${n}A`,
  cursorTo:  (col) => `\x1b[${col}G`,
};

// Sprint 2.6 — mouse-event guard. Same problem the main TUI engine has:
// SGR mouse reports (\x1b[<…M) can fragment across data events on Windows
// ConPTY. When that happens readline emits the payload bytes ("0;43;51M")
// as plain keypress events, which previously got interpreted as digit
// shortcuts inside the picker → AUTO-COMMITTED the wrong row before the
// user could press Enter. We strip mouse debris in both the data path
// AND the keypress path with a short post-mouse swallow window.
const SGR_PAYLOAD_RE = /^[0-9;]*[Mm]$|^[0-9;]+$|^[Mm]$/;

// Strip ANSI escape codes so we can measure rendered width accurately.
function _visibleLen(s) {
  return String(s == null ? '' : s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

// Pad a possibly-ANSI string out to `width` visible columns. If the
// visible content is already wider than `width`, return unchanged.
function _padRight(s, width) {
  const cur = _visibleLen(s);
  if (cur >= width) return String(s == null ? '' : s);
  return String(s) + ' '.repeat(width - cur);
}

// Truncate ANSI-aware to `width` visible columns. Cheap: assumes the
// string doesn't span escape sequences across the cut point. We only
// use this for stable, single-style fragments.
function _truncate(s, width) {
  if (_visibleLen(s) <= width) return s;
  // Strip all escapes and re-slice from scratch — safer than mid-escape.
  const plain = String(s).replace(/\x1b\[[0-9;]*m/g, '');
  return plain.slice(0, Math.max(0, width - 1)) + '…';
}

/**
 * Run an inline menu and return the picked item (or null on cancel).
 *
 * @param {object}   opts
 * @param {object}   opts.engine    TuiEngine instance (will be paused)
 * @param {string}   opts.title     Menu heading (rendered inside the top border)
 * @param {Array}    opts.items     [{label, sublabel?, aside?, value, disabled?, group?, header?}]
 *                                  - group: optional string. Items sharing a
 *                                    group string are rendered under a single
 *                                    header row (the first time the group is
 *                                    seen in order).
 *                                  - header: if true, this entry is a non-
 *                                    selectable group header (skipped by
 *                                    navigation). Auto-generated when caller
 *                                    uses {group:...}.
 *                                  - aside: optional right-aligned annotation
 *                                    (cost, tagline, etc) shown in dim grey.
 * @param {string=}  opts.footer    Optional hint line under the menu
 * @param {number=}  opts.initial   Initial cursor index (counting only items)
 * @param {boolean=} opts.search    If true, allow inline filtering with '/'
 * @param {string=}  opts.filterHint Placeholder text for the search prompt
 */
function interactiveMenu({ engine, title, items, footer, initial = 0, search = true, filterHint = 'search' }) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || items.length === 0) {
      return resolve(null);
    }

    if (engine && typeof engine.pause === 'function') engine.pause();

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    try { stdin.setRawMode(true); } catch (_) {}
    readline.emitKeypressEvents(stdin);
    stdin.resume();
    stdin.setEncoding('utf8');

    process.stdout.write(ANSI.hide + ANSI.mouseOn);

    // Build the flat row list with auto-inserted group headers. The
    // resulting `rows` array drives both rendering and navigation —
    // navigation just skips rows where `row.header || row.disabled`.
    function buildRows(rawItems) {
      const out = [];
      const seenGroups = new Set();
      for (const it of rawItems) {
        if (it.header) { out.push(it); continue; }
        if (it.group && !seenGroups.has(it.group)) {
          seenGroups.add(it.group);
          out.push({ header: true, label: it.group });
        }
        out.push(it);
      }
      return out;
    }

    let rows = buildRows(items);
    let filter = '';            // current search filter (lowercase)
    let searchOpen = false;     // is the inline / search prompt active?
    let firstDraw = true;
    let menuStartLine = 0;      // remember where we drew so we can erase

    function rowIsSelectable(r) {
      return r && !r.header && !r.disabled;
    }

    function rowMatchesFilter(r) {
      if (!filter) return true;
      if (r.header) return false; // headers visible only when their group has matches
      const hay = ((r.label || '') + ' ' + (r.sublabel || '') + ' ' + (r.aside || '')).toLowerCase();
      return hay.indexOf(filter) >= 0;
    }

    // Visible rows (after filter applied). Group headers are kept only
    // if at least one row beneath them matches.
    function visibleRows() {
      if (!filter) return rows;
      // Two-pass: first collect matching non-header rows by group, then
      // re-walk the original to preserve order and inject headers only
      // where their group has at least one match.
      const out = [];
      let lastHeader = null;
      let lastHeaderPushed = false;
      for (const r of rows) {
        if (r.header) {
          lastHeader = r;
          lastHeaderPushed = false;
          continue;
        }
        if (rowMatchesFilter(r)) {
          if (lastHeader && !lastHeaderPushed) {
            out.push(lastHeader);
            lastHeaderPushed = true;
          }
          out.push(r);
        }
      }
      return out;
    }

    // Cursor refers to index inside the CURRENTLY VISIBLE rows. We
    // re-normalise it any time the filter changes so it always points
    // at a selectable row.
    let visible = visibleRows();

    function findFirstSelectable(startIdx, dir = +1) {
      const n = visible.length;
      if (!n) return -1;
      let i = startIdx;
      for (let step = 0; step < n; step++) {
        if (i < 0) i = n - 1;
        if (i >= n) i = 0;
        if (rowIsSelectable(visible[i])) return i;
        i += dir;
      }
      return -1;
    }

    // Map caller's "initial" (index into raw items, ignoring auto-inserted
    // headers) to an index into the visible array.
    function initialVisibleIndex() {
      const sel = items.filter(rowIsSelectable);
      const want = sel[Math.max(0, Math.min(initial, sel.length - 1))];
      if (!want) return findFirstSelectable(0, +1);
      const at = visible.indexOf(want);
      if (at >= 0 && rowIsSelectable(visible[at])) return at;
      return findFirstSelectable(0, +1);
    }
    let cursor = initialVisibleIndex();

    function recomputeVisible(preserveItem) {
      visible = visibleRows();
      if (preserveItem) {
        const at = visible.indexOf(preserveItem);
        if (at >= 0) { cursor = at; return; }
      }
      cursor = findFirstSelectable(0, +1);
      if (cursor < 0) cursor = 0;
    }

    function selectableCount() {
      let n = 0;
      for (const r of visible) if (rowIsSelectable(r)) n++;
      return n;
    }

    function selectedRow() { return visible[cursor]; }

    // ── render helpers ─────────────────────────────────────────────────
    // Auto-fit width: column widths are derived from the longest visible
    // label/aside; capped so the box never exceeds the terminal width.
    function computeColumns() {
      const term = Math.max(40, (process.stdout.columns || 80));
      // Total content budget = term - 4 (outer "│ " gutters + room)
      const maxInner = Math.min(term - 4, 96);
      let labelW = 14;
      let asideW = 0;
      for (const r of visible) {
        if (r.header) continue;
        labelW = Math.max(labelW, _visibleLen(r.label || ''));
        if (r.aside) asideW = Math.max(asideW, _visibleLen(r.aside));
      }
      // Reserve a sublabel/tagline column when present. We compute the
      // longest tagline to right-size it but cap aggressively so we
      // don't push the aside off-screen on narrow terms.
      let subW = 0;
      for (const r of visible) {
        if (r.header) continue;
        if (r.sublabel) subW = Math.max(subW, _visibleLen(r.sublabel));
      }
      // Constants for prefix (▶ marker + key glyph), gutters, and the
      // gap between columns.
      const prefixW = 5;                    // " ▶ ✓ " | "   · " | "     "
      const gap = 2;
      // Initial proposal
      let proposed = prefixW + labelW + gap + subW + gap + asideW;
      // Shrink the longest dynamic column until we fit.
      while (proposed > maxInner) {
        if (subW >= asideW && subW > 12) subW--;
        else if (asideW > 8) asideW--;
        else if (labelW > 14) labelW--;
        else break;
        proposed = prefixW + labelW + gap + subW + gap + asideW;
      }
      const inner = Math.min(maxInner, proposed);
      return { inner, prefixW, labelW, subW, asideW, gap };
    }

    function drawTopBorder(width, titleText) {
      const t = ' ' + titleText + ' ';
      if (_visibleLen(t) >= width - 4) {
        return fmt.cyan('╭') + fmt.dim('─'.repeat(width - 2)) + fmt.cyan('╮');
      }
      const left = 2;
      const right = width - 2 - left - _visibleLen(t);
      return fmt.cyan('╭') + fmt.dim('─'.repeat(left)) + fmt.bold(t) + fmt.dim('─'.repeat(right)) + fmt.cyan('╮');
    }

    function drawBottomBorder(width, hintText) {
      if (!hintText) return fmt.cyan('╰') + fmt.dim('─'.repeat(width - 2)) + fmt.cyan('╯');
      const t = ' ' + hintText + ' ';
      if (_visibleLen(t) >= width - 4) {
        return fmt.cyan('╰') + fmt.dim('─'.repeat(width - 2)) + fmt.cyan('╯');
      }
      const left = 2;
      const right = width - 2 - left - _visibleLen(t);
      return fmt.cyan('╰') + fmt.dim('─'.repeat(left)) + fmt.dim(t) + fmt.dim('─'.repeat(right)) + fmt.cyan('╯');
    }

    function drawBlankLine(width) {
      return fmt.cyan('│') + ' '.repeat(width - 2) + fmt.cyan('│');
    }

    function drawContentLine(width, contentPlainWidth, contentAnsi) {
      // Visible width of inner = width - 2 (the two side borders).
      const innerW = width - 2;
      const padded = _padRight(contentAnsi, innerW);
      return fmt.cyan('│') + padded + fmt.cyan('│');
    }

    function drawHeaderRow(width, cols, label) {
      const innerW = width - 2;
      const text = ' ' + fmt.bold(fmt.cyan(String(label).toUpperCase())) + ' ' + fmt.dim('·'.repeat(Math.max(0, innerW - 2 - _visibleLen(label) - 2)));
      return fmt.cyan('│') + _padRight(text, innerW) + fmt.cyan('│');
    }

    function drawItemRow(width, cols, row, active) {
      const innerW = width - 2;
      // Selectable item marker — has-key / no-key / local — comes from
      // caller as row.marker. Fallback to blank.
      const marker = row.marker || ' ';
      // Build the row text: [arrow][marker] label  sublabel  aside
      const arrow = active ? fmt.cyan('▶') : ' ';
      const labelText = _padRight(row.label || '', cols.labelW);
      const subText   = cols.subW
        ? '  ' + _padRight(fmt.dim(_truncate(row.sublabel || '', cols.subW)), cols.subW)
        : '';
      const asideText = cols.asideW
        ? '  ' + (() => {
            const a = _truncate(row.aside || '', cols.asideW);
            return _padRight(active ? fmt.dim(a) : fmt.dim(a), cols.asideW);
          })()
        : '';
      // Compose
      let inner = ' ' + arrow + ' ' + marker + ' ' + labelText + subText + asideText;
      // Pad/truncate to innerW
      const cur = _visibleLen(inner);
      if (cur < innerW) inner = inner + ' '.repeat(innerW - cur);
      else if (cur > innerW) inner = _truncate(inner, innerW);

      if (active) {
        // Reverse-video for the entire inner content. We wrap the
        // visible text in \x1b[7m … \x1b[27m so we don't clobber the
        // already-coloured ANSI sequences inside (truecolor-safe).
        inner = '\x1b[7m' + inner + '\x1b[27m';
      }
      return fmt.cyan('│') + inner + fmt.cyan('│');
    }

    function drawSearchLine(width, label) {
      const innerW = width - 2;
      // Render: " ▌ search ▏ <filter>_   "
      const prefix = ' ' + fmt.cyan('▎') + ' ' + fmt.dim(label) + ' ' + fmt.dim('▏') + ' ';
      const caret = searchOpen ? fmt.cyan('▌') : '';
      let inner = prefix + (filter || fmt.dim('(type to filter)')) + caret;
      const cur = _visibleLen(inner);
      if (cur < innerW) inner = inner + ' '.repeat(innerW - cur);
      else inner = _truncate(inner, innerW);
      return fmt.cyan('│') + inner + fmt.cyan('│');
    }

    function draw() {
      const cols = computeColumns();
      const width = cols.inner + 2; // +2 borders
      const out = [];

      if (!firstDraw) {
        out.push(ANSI.cursorUp(menuStartLine));
        for (let i = 0; i < menuStartLine; i++) {
          out.push(ANSI.clearLine + '\n');
        }
        out.push(ANSI.cursorUp(menuStartLine));
      }

      out.push('\n');
      const headerCount = selectableCount();
      const titleLine = `${title}${headerCount > 0 ? '  (' + headerCount + ')' : ''}`;
      out.push(drawTopBorder(width, titleLine) + '\n');
      out.push(drawBlankLine(width) + '\n');

      // Render visible rows. If filter is on and nothing matches, show
      // a small placeholder. Cap to a reasonable maxRows to avoid
      // overflowing very small terminals; show a scroll-hint when more
      // rows exist than fit.
      const termH = Math.max(8, (process.stdout.rows || 24));
      // Reserve: top border (1) + blank (1) + bottom search line (2 if search) +
      //          blank (1) + bottom border (1) + footer (1) + breathing (3).
      const reserved = (search ? 3 : 1) + 7;
      const maxRows = Math.max(6, termH - reserved);

      if (!visible.length || (filter && !visible.some(rowIsSelectable))) {
        out.push(drawContentLine(width, cols.inner, '  ' + fmt.dim('no matches for "' + filter + '"')) + '\n');
      } else {
        // Scroll so cursor stays visible.
        let firstIdx = 0;
        if (visible.length > maxRows) {
          const half = Math.floor(maxRows / 2);
          firstIdx = Math.max(0, Math.min(visible.length - maxRows, cursor - half));
        }
        const lastIdx = Math.min(visible.length, firstIdx + maxRows);
        if (firstIdx > 0) {
          out.push(drawContentLine(width, cols.inner, '  ' + fmt.dim('· · · ' + firstIdx + ' more above · · ·')) + '\n');
        }
        for (let i = firstIdx; i < lastIdx; i++) {
          const r = visible[i];
          if (r.header) out.push(drawHeaderRow(width, cols, r.label) + '\n');
          else out.push(drawItemRow(width, cols, r, i === cursor) + '\n');
        }
        if (lastIdx < visible.length) {
          out.push(drawContentLine(width, cols.inner, '  ' + fmt.dim('· · · ' + (visible.length - lastIdx) + ' more below · · ·')) + '\n');
        }
      }

      // Inline search prompt — always present when search is enabled,
      // dim when inactive so user sees the affordance.
      if (search) {
        out.push(drawBlankLine(width) + '\n');
        const hint = searchOpen ? 'searching' : filterHint;
        out.push(drawSearchLine(width, hint) + '\n');
      }
      out.push(drawBlankLine(width) + '\n');

      // Bottom border doubles as a footer hint
      const defaultHint = searchOpen
        ? 'type to filter · Enter apply · Esc clear'
        : (footer || '↑/↓ move · Enter commit · / filter · Esc cancel');
      out.push(drawBottomBorder(width, defaultHint) + '\n');

      const text = out.join('');
      menuStartLine = (text.match(/\n/g) || []).length;
      process.stdout.write(text);
      firstDraw = false;
    }

    function cleanup() {
      stdin.removeListener('keypress', onKey);
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(wasRaw); } catch (_) {}
      process.stdout.write(ANSI.show + ANSI.mouseOff + '\n');
      stdin.pause();
      if (engine && typeof engine.resume === 'function') engine.resume();
      try {
        if (engine && typeof engine._forceRedraw === 'function') {
          engine._forceRedraw();
        }
      } catch (_) {}
    }

    function pick() {
      const r = selectedRow();
      if (!r || !rowIsSelectable(r)) return;
      cleanup();
      resolve(r.value !== undefined ? r.value : r);
    }

    function cancel() {
      cleanup();
      resolve(null);
    }

    // Sprint 2.6 — mouse-leak swallow window (mirrors tui-engine logic).
    let swallowUntil = 0;

    function onKey(ch, key) {
      if (!key) return;

      // Drop mouse-sequence noise BEFORE any other handling.
      if (key.sequence) {
        const isSgr    = key.sequence.indexOf('\x1b[<') >= 0;
        const isLegacy = /\x1b\[M.{3}/.test(key.sequence);
        if (isSgr || isLegacy) {
          swallowUntil = Date.now() + 250;
          return;
        }
      }
      if (swallowUntil && Date.now() < swallowUntil) {
        const c = (ch && typeof ch === 'string') ? ch : (key.sequence || '');
        if (c && SGR_PAYLOAD_RE.test(c)) {
          if (/[Mm]/.test(c)) swallowUntil = 0;
          return;
        }
        if (c && /^[0-9;]+$/.test(c) && c.length <= 16) return;
      }

      // ── Search mode: when searchOpen, most keys feed the filter ──
      if (searchOpen) {
        if (key.ctrl && key.name === 'c') return cancel();
        if (key.name === 'escape') {
          // Esc inside search → close search, clear filter.
          searchOpen = false;
          filter = '';
          recomputeVisible();
          draw();
          return;
        }
        if (key.name === 'return' || key.name === 'enter') {
          // Enter inside search → commit the filter; cursor stays on first match.
          searchOpen = false;
          draw();
          return;
        }
        if (key.name === 'backspace') {
          if (filter.length > 0) {
            const prev = selectedRow();
            filter = filter.slice(0, -1);
            recomputeVisible(prev && rowIsSelectable(prev) ? prev : null);
            draw();
          }
          return;
        }
        if (ch && ch.length === 1 && ch >= ' ') {
          filter += ch.toLowerCase();
          recomputeVisible();
          draw();
          return;
        }
        // Arrow keys still navigate even while search is open.
        if (key.name === 'up')   { cursor = findFirstSelectable(cursor - 1, -1); draw(); return; }
        if (key.name === 'down') { cursor = findFirstSelectable(cursor + 1, +1); draw(); return; }
        return;
      }

      if (key.ctrl && key.name === 'c') return cancel();
      if (key.name === 'escape' || key.name === 'q') return cancel();
      if (key.name === 'return' || key.name === 'enter') return pick();
      if (search && (ch === '/' || key.name === 'slash')) {
        searchOpen = true; draw(); return;
      }
      if (key.name === 'up'   || key.name === 'k') {
        const next = findFirstSelectable(cursor - 1, -1);
        if (next >= 0) cursor = next;
        draw(); return;
      }
      if (key.name === 'down' || key.name === 'j') {
        const next = findFirstSelectable(cursor + 1, +1);
        if (next >= 0) cursor = next;
        draw(); return;
      }
      if (key.name === 'pageup') {
        for (let i = 0; i < 6; i++) cursor = findFirstSelectable(cursor - 1, -1);
        draw(); return;
      }
      if (key.name === 'pagedown') {
        for (let i = 0; i < 6; i++) cursor = findFirstSelectable(cursor + 1, +1);
        draw(); return;
      }
      if (key.name === 'home') {
        cursor = findFirstSelectable(0, +1);
        draw(); return;
      }
      if (key.name === 'end')  {
        cursor = findFirstSelectable(visible.length - 1, -1);
        draw(); return;
      }
      // Letters / digits start incremental search when search is enabled.
      if (search && ch && ch.length === 1 && ch >= ' ' && ch !== '/') {
        searchOpen = true;
        filter = ch.toLowerCase();
        recomputeVisible();
        draw();
        return;
      }
    }

    function onData(buf) {
      const s = buf.toString();
      const m = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
      if (s.indexOf('\x1b[<') >= 0 || /\x1b\[M.{3}/.test(s)) {
        swallowUntil = Date.now() + 250;
      }
      if (!m) return;
      const button = parseInt(m[1], 10);
      const press  = m[4] === 'M';
      if (button === 64 && press) {
        cursor = findFirstSelectable(cursor - 1, -1); draw(); return;
      }
      if (button === 65 && press) {
        cursor = findFirstSelectable(cursor + 1, +1); draw(); return;
      }
      // Left-click is intentionally a no-op (mouse-leak history).
    }

    stdin.on('keypress', onKey);
    stdin.on('data', onData);
    draw();
  });
}

module.exports = { interactiveMenu };

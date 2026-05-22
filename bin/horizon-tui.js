#!/usr/bin/env node
// Horizon TUI v2 — keypress-based interactive shell.
//
// What's new vs v1 (readline-based):
//   - Multi-line composer (Shift+Enter inserts newline, Enter sends)
//   - In-chat search overlay (Ctrl+F, type query, Enter to jump,
//     Ctrl+N/P navigate, Esc cancel)
//   - Scrollback through past output (Page Up/Down, Ctrl+B/F, mouse
//     scroll wheel) — Esc returns to live view
//   - Mouse click anywhere in the scrollback view brings you back to live
//   - Ctrl+L clears screen, Ctrl+U clear line, Ctrl+W delete word back,
//     Ctrl+A/E start/end of line
//
// Same slash command surface as v1: /help /quit /clear /reset /skills
// /skill /skill-show /persona /persona-list /model /model-list /mem
// /agent /chat /stream on|off /markdown on|off /banner /verbose

const path = require('path');
const { createHorizonRuntime } = require('../src/main/runtime/headless');
const { fmt, isTTY, friendlyError } = require('./lib/tty');
const { renderMarkdown } = require('./lib/markdown');
const { bannerBig, bannerFramedBox, renderCollapsibleSection, GradientSpinner, welcomeReveal, renderArt, buildGreetingBase, timeOfDayArt } = require('./lib/banner');
const { TuiEngine } = require('./lib/tui-engine');
const { interactiveMenu } = require('./lib/menu');

const SLASH_LIST = ['/help','/quit','/clear','/reset','/skills','/skill','/skill-show',
                    '/persona','/persona-list','/model','/model-list','/models','/mem','/agent',
                    '/chat','/stream','/markdown','/banner','/verbose','/find','/mobile',
                    // Sprint 2.12 — Hermes-style upgrades.
                    '/altscreen','/sections',
                    // Sprint 2.3 — Easter-egg slash commands (discoverable via /help)
                    '/tea','/coffee','/whoami','/secret','/art'];

// Sprint 2.3 — Easter-egg trigger map. Keys are normalised user input (lower-cased + trimmed),
// values are the art-piece name to render. We deliberately list every variant
// the user might try (English + Russian); the agent isn't called for these.
const EASTER_EGGS = {
  '/tea': 'tea',
  'tea': 'tea',
  'чай': 'tea',
  '/coffee': 'coffee',
  'coffee': 'coffee',
  'кофе': 'coffee',
  '/whoami': 'whoami',           // special — renders persona card, handled separately
  'who am i': 'whoami',
  'кто я': 'whoami',
  '/secret': 'konami',
  'konami': 'konami',
  '↑↑↓↓←→←→ba': 'konami',
  '/art': '__gallery__',          // shorthand to dump the gallery
};

/**
 * Sprint 2.3 — try matching a user-typed line against the Easter-egg table.
 * Returns the art piece name (or '__gallery__' / 'whoami' sentinels) on hit,
 * else null. Caller is responsible for actually printing the art.
 */
function matchEasterEgg(line) {
  if (!line) return null;
  const key = String(line).toLowerCase().trim().replace(/[?.!]+$/, '');
  return EASTER_EGGS[key] || null;
}

function buildHelp() {
  // Small art header above the help table — feels premium without
  // dominating the screen. Falls back to empty string under --no-art.
  const header = renderArt('helpHeader');
  // Stylised group header — bold accent + a dim divider rule so groups
  // pop visually without a heavy box.
  const groupHead = (label) =>
    fmt.bold(fmt.cyan('▎ ' + label)) + '  ' + fmt.dim('─'.repeat(Math.max(1, 56 - label.length)));
  return [
    '',
    ...(header ? [header, ''] : []),
    groupHead('Slash commands · session'),
    '  /help                 show this list',
    '  /quit                 exit',
    '  /clear                clear screen',
    '  /reset                clear chat history (memory keeps everything)',
    '  /banner               re-print the welcome banner',
    '',
    groupHead('Slash commands · run'),
    '  /agent <task>         run the full agent loop (multi-step + tools)',
    '  /chat <message>       force single-turn chat',
    '  /stream on|off        toggle streaming',
    '  /markdown on|off      toggle markdown rendering',
    '',
    groupHead('Slash commands · skills + personas'),
    '  /skills               list installed skills (interactive picker)',
    '  /skill <id>           force-include a skill in the next turn',
    '  /skill-show <id>      print a skill\'s SKILL.md',
    '  /persona              show / switch persona (no arg or <id>)',
    '  /persona-list         list all personas (interactive picker)',
    '',
    groupHead('Slash commands · models'),
    '  /model                show / switch provider (no arg or <id>)',
    '  /model-list           pick provider, then drill into its models',
    '  /models [filter]      flat search across every provider/model pair',
    '',
    groupHead('Slash commands · misc'),
    '  /mem "query"          semantic memory search',
    '  /find <query>         same as Ctrl+F',
    '',
    groupHead('Keyboard shortcuts'),
    '  Enter                 send message',
    '  Shift+Enter           newline (multi-line composer)',
    '  Tab                   on empty composer: cycle banner sections (else autocomplete)',
    '  1 / 2 / 3 / 4         on empty composer: toggle Tools / Skills / Prompt / MCP',
    '  Up / Down             history navigation (when on first line)',
    '  ← / →                 move cursor within composer',
    '  Ctrl+A / Ctrl+E       jump start / end of line',
    '  Ctrl+U / Ctrl+K       cut to start / end of line',
    '  Ctrl+W                delete word backward',
    '  Ctrl+L                clear screen',
    '  Ctrl+F                search transcript',
    '  Page Up / Page Down   scroll through past output',
    '  Esc                   exit scrollback / search',
    '  Mouse wheel           scroll transcript (where supported)',
    '  Mouse click on ▸/▾    toggle that collapsible section (where mouse supported)',
    '  Ctrl+C / Ctrl+D       exit',
    '',
    fmt.dim('  Try also: /tea  /coffee  /whoami  /art  — a few hidden moments live in here.'),
    '',
  ].join('\n');
}

// v0.0.2 — does any provider have a key, OR is any local-provider URL
// set? Mirrors the same check bin/horizon.js uses for the no-args
// first-run trigger. Inlined here so horizon-tui can decide what hint
// to print without depending on a sibling module.
function _runtimeHasAnyKey(rt) {
  const KEYED = ['gemini','groq','cerebras','openai','claude','deepseek',
                 'deepinfra','fireworks','together','sambanova','nebius',
                 'openrouter','mistral','qwen','moonshot','zai','perplexity',
                 'cohere','grok','azure','custom'];
  try {
    for (const id of KEYED) {
      const v = rt.keysStore?.get?.(`k_${id}`);
      if (v && String(v).trim()) return true;
    }
    if (rt.settingsStore?.get?.('ollamaUrl')   ||
        rt.settingsStore?.get?.('lmStudioUrl') ||
        rt.settingsStore?.get?.('localAiUrl')) return true;
  } catch (_) {}
  return false;
}

// Sprint 2 — time-of-day + persona-aware greeting for the banner.
// Sprint 2.3 — base text is now a randomised rotation per-slot (see banner.js
// `buildGreetingBase`). Persona suffixes still apply.
function buildGreeting(persona) {
  const base = buildGreetingBase(new Date());
  const id = String(persona || '').toLowerCase();
  let suffix;
  switch (id) {
    case 'jarvis': suffix = ', sir.'; break;
    case 'alfred': suffix = ', master.'; break;
    case 'friday': suffix = '!'; break;
    case 'sage':   suffix = '. Ready to think.'; break;
    case 'pixel':  suffix = '! ✨'; break;
    default:       suffix = '.';
  }
  return base + suffix;
}

/**
 * Sprint 2.12 — Hermes-style banner header.
 * Renders the framed wordmark box, four collapsible startup sections
 * (Tools / Skills / System prompt / MCP servers), a persona greeting,
 * and a hint footer. Sections read their expanded state from the engine
 * when one is supplied (so /sections <id> toggles persist across reprints).
 */
function bannerHeader(rt, engine) {
  const provider = rt.settingsStore.get('provider') || 'gemini';
  const persona = rt.settingsStore.get('persona') || 'jarvis';
  const memCount = rt.agentMemory?._data?.memories?.length || 0;
  const skillCount = rt.skillsManager?.list().length || 0;
  const lang = rt.settingsStore.get('lang') || 'en';

  // Section summaries — short, factual, scannable.
  // Tools — best-effort count from runtime if available, else hardcoded baseline.
  let toolCount = 0, channelCount = 0, mcpCount = 0;
  try {
    if (rt.toolsRegistry && typeof rt.toolsRegistry.list === 'function') {
      toolCount = rt.toolsRegistry.list().length || 0;
    }
  } catch (_) {}
  try { channelCount = (rt.channels?.list?.() || []).length || 0; } catch (_) {}
  try {
    if (rt.mcpServers && typeof rt.mcpServers.list === 'function') {
      mcpCount = rt.mcpServers.list().length || 0;
    } else if (Array.isArray(rt.settingsStore.get('mcpServers'))) {
      mcpCount = rt.settingsStore.get('mcpServers').length || 0;
    }
  } catch (_) {}

  // Anthropic/Linear restraint: all sections start collapsed by default so
  // the first frame is calm. User can press Tab or click ▸ to expand any.
  // This keeps the startup banner under 8 lines instead of 14+.
  const sections = (engine && engine.getSections && engine.getSections())
    || {
      tools:  { expanded: false, name: 'Tools' },
      skills: { expanded: false, name: 'Skills' },
      prompt: { expanded: false, name: 'System prompt' },
      mcp:    { expanded: false, name: 'MCP servers' },
    };

  const todName = timeOfDayArt(new Date());
  const todArt = todName ? renderArt(todName) : '';

  // Section body (only rendered when expanded). Kept short — 1-3 lines.
  const toolsBody = sections.tools.expanded
    ? [
        `built-in: ${toolCount || '—'}  ·  channels: ${channelCount || '—'}  ·  mcp tools: ${mcpCount || '—'}`,
        'agent loop + tool calls available — /agent <task> to run',
      ]
    : null;
  const skillsBody = sections.skills.expanded
    ? [`${skillCount} installed · /skills to manage · /skill <id> to force-include`]
    : null;
  const promptBody = sections.prompt.expanded
    ? [`persona: ${persona} · lang: ${lang} · workspace: ${path.basename(rt.workspaceDir)}`]
    : null;
  const mcpBody = sections.mcp.expanded
    ? [`${mcpCount} configured · settings → mcpServers`]
    : null;

  // Build the section blocks with offset tracking so we can register click
  // regions with the engine. We need the row offset (within the rendered
  // banner) of EACH section header line — that's what the mouse handler
  // will compare clicks against.
  const sectionBlocks = [
    { id: 'tools', text: renderCollapsibleSection(
      sections.tools.name,
      `${toolCount || 'built-in'} built-in · ${channelCount} channels · ${mcpCount} MCP`,
      sections.tools.expanded, toolsBody) },
    { id: 'skills', text: renderCollapsibleSection(
      sections.skills.name,
      `${skillCount} enabled · /skills to manage`,
      sections.skills.expanded, skillsBody) },
    { id: 'prompt', text: renderCollapsibleSection(
      sections.prompt.name,
      `${persona} · workspace ${path.basename(rt.workspaceDir)}`,
      sections.prompt.expanded, promptBody) },
    { id: 'mcp', text: renderCollapsibleSection(
      sections.mcp.name,
      mcpCount > 0 ? `${mcpCount} connected` : 'none configured',
      sections.mcp.expanded, mcpBody) },
  ];

  const headLines = [bannerFramedBox(), ''];
  // Sprint 4 — Task 1: track which line-of-banner each section header sits
  // at. Each section block may render as 1 line (collapsed) or 1+N lines
  // (expanded, with body rows). The header is always the FIRST line.
  const sectionOffsets = [];
  let lineCursor = headLines.length;
  const sectionLines = [];
  for (const b of sectionBlocks) {
    sectionOffsets.push({ id: b.id, offset: lineCursor });
    const blockLines = b.text.split('\n');
    sectionLines.push(...blockLines);
    lineCursor += blockLines.length;
  }
  const tailLines = [
    '',
    '  ' + fmt.dim(buildGreeting(persona)),
    ...(todArt ? [todArt] : []),
    // Sprint 4 — Task 1: surface click + Tab in the help footer so the user
    // discovers the new interaction instead of guessing.
    // Concise help line — only the four most-used surfaces. Full keyboard
    // reference lives in `/help`. References: Claude Code, Linear, Cursor
    // all keep their startup hint under ~50 chars.
    fmt.dim('  ⏎ send  ·  ⇧⏎ newline  ·  /help  ·  Esc interrupt'),
    '',
  ];

  const lines = [...headLines, ...sectionLines, ...tailLines];
  const text = lines.join('\n');
  // Attach metadata so callers (horizon-tui main + /sections + /banner) can
  // register the click map with the engine in one place.
  // Returning a plain string keeps backward compatibility — anything that
  // doesn't read `.sectionOffsets` (tests, search) sees a normal string.
  /* eslint-disable no-new-wrappers */
  // String objects coerce to plain strings on concat/print yet still carry
  // properties. This is the cleanest way to slip metadata through without
  // touching every call site.
  const wrapped = new String(text);
  wrapped.sectionOffsets = sectionOffsets;
  wrapped.totalLines = lines.length;
  return wrapped;
  /* eslint-enable no-new-wrappers */
}

function fmtArgs(a) {
  if (!a) return '';
  try { const s = JSON.stringify(a); return s.length > 60 ? s.slice(0, 57) + '…' : s; }
  catch (_) { return ''; }
}

// Sprint 2 — render args inline if short, else collapse to "{ … N keys … }".
function fmtArgsInline(a) {
  if (!a || typeof a !== 'object') return '';
  let s;
  try { s = JSON.stringify(a); } catch (_) { return ''; }
  if (s.length <= 60) return s;
  const keys = Object.keys(a);
  if (keys.length === 0) return '{}';
  return `{ … ${keys.length} ${keys.length === 1 ? 'key' : 'keys'} … }`;
}

// Sprint 2 — humanise a millisecond duration: 234ms, 1.2s, 1m23s.
function fmtDuration(ms) {
  if (!ms || ms < 0) ms = 0;
  if (ms < 1000)   return `${Math.round(ms)}ms`;
  if (ms < 60000)  return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m${String(secs).padStart(2, '0')}s`;
}

// Sprint 2 — visually strip ANSI for length measurement when sizing
// box borders. Borders themselves are ANSI-free so the chars-rendered
// width is just .replace(/\x1b\[[0-9;]*m/g,'').length.
function visibleLen(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, '').length; }

// Per-tool category glyph. Themes that render Unicode geometrics cleanly get
// coloured single-cell glyphs (no color-emoji font dependency); mono / matrix
// / retro-amber stay ASCII-only to preserve their monochrome vibe.
const GLYPH_THEMES = new Set(['default', 'vapor', 'mocha', 'kawaii', 'light']);
function _toolGlyph(tool, themeName) {
  const t = String(tool || '');
  const theme = themeName || 'default';
  const useGlyph = GLYPH_THEMES.has(theme);
  const cat =
    /^web_|^fetch_/.test(t)                                       ? 'web'  :
    /^(run_code|run_shell|run_python)$|^exec_/.test(t)            ? 'exec' :
    /^(write_file|edit_file|read_file)$/.test(t)                  ? 'file' :
    /^(mouse_|keyboard_)|^(smart_click|screenshot)$/.test(t)      ? 'mouse':
    /^conn_/.test(t)                                              ? 'conn' :
    /^memory_|^recall_/.test(t)                                   ? 'mem'  :
    /^spawn_subagent$/.test(t)                                    ? 'agent':
                                                                    'other';
  if (useGlyph) {
    // Clean Unicode geometrics — render in every terminal without color-emoji.
    const glyphs = { web: '◇', exec: '▸', file: '▤', mouse: '▦', conn: '◈', mem: '◉', agent: '❖', other: '•' };
    const g = glyphs[cat];
    // Per-category colour. Each glyph gets a distinct hue so scanning the
    // transcript is fast. ASCII themes skip colouring (handled below).
    const colour = {
      web:   fmt.cyan,
      exec:  fmt.green,
      file:  fmt.yellow,
      mouse: fmt.magenta,
      conn:  fmt.blue,
      mem:   fmt.magenta,
      agent: fmt.green,
      other: fmt.dim,
    }[cat];
    return colour ? colour(g) : g;
  }
  return { web: 'W', exec: '>', file: 'F', mouse: 'M', conn: 'C', mem: 'K', agent: 'A', other: '·' }[cat];
}

// Live step rail (re-uses the engine's print so it appears in transcript).
// Uses GradientSpinner.setPhase() to swap glyph sets between phases.
class StepRail {
  constructor(engine, runtime) {
    this.engine = engine;
    this.runtime = runtime;
    this.spinner = null;
    this.lastTool = '';
    this._toolStartedAt = 0;
    this.themeName = (runtime && runtime.settingsStore && runtime.settingsStore.get('cliTheme')) || 'default';
  }
  _newSpinner(text, phase) {
    const s = new GradientSpinner(text);
    if (phase && typeof s.setPhase === 'function') s.setPhase(phase);
    return s.start();
  }
  startThinking(text = '⌁ thinking…') {
    if (this.spinner) this.spinner.stop();
    this.spinner = this._newSpinner(text, 'thinking');
  }
  showPlan(steps) {
    if (this.spinner) this.spinner.stop();
    this.engine.print('');
    // Small accent ribbon above the plan header — subtle, doesn't dominate.
    const ribbon = renderArt('planAccepted', { tag: `${steps.length} step${steps.length === 1 ? '' : 's'}` });
    if (ribbon) ribbon.split('\n').forEach(l => this.engine.print(l));
    this.engine.print(fmt.bold('plan'));
    steps.forEach((s, i) => {
      const txt = typeof s === 'string' ? s : (s.text || JSON.stringify(s));
      this.engine.print(`  ${fmt.dim((i + 1) + '.')} ${txt}`);
    });
    this.engine.print('');
    this.spinner = this._newSpinner('starting…', 'planning');
  }
  executing(tool, args) {
    this.lastTool = tool;
    this._toolStartedAt = Date.now();
    this._lastArgs = args;
    // Subagent-spawn moment — show a tiny accent inline before the spinner
    // resumes. Only fires for the actual spawn_subagent tool.
    if (tool === 'spawn_subagent') {
      if (this.spinner) this.spinner.stop();
      const n = (args && (args.count || args.n || (Array.isArray(args.tasks) ? args.tasks.length : 1))) || 1;
      const art = renderArt('subagentSpawn', { tag: `spawning ${n} subagent${n === 1 ? '' : 's'}` });
      if (art) art.split('\n').forEach(l => this.engine.print(l));
    }
    const cat = _toolGlyph(tool, this.themeName);
    if (!this.spinner) this.spinner = this._newSpinner('', 'executing');
    else if (typeof this.spinner.setPhase === 'function') this.spinner.setPhase('executing');
    this.spinner.update(`${cat} ${tool}(${fmtArgs(args)})`);
  }

  /**
   * Sprint 2 — render the tool result as a card.
   * Wide (≥100 cols) → bordered box with status glyph, args, output (≤6 lines).
   * Narrow (<100 cols) → fall back to the one-liner format.
   */
  result(tool, ok, result) {
    if (this.spinner) this.spinner.stop();
    const duration = this._toolStartedAt ? (Date.now() - this._toolStartedAt) : 0;
    const cols = process.stdout.columns || 80;
    const args = this._lastArgs || {};
    const isDenied = !ok && /permission|denied|not\s+approved|denied\s+by\s+user/i.test(
      String(result?.err || result?.error || '')
    );

    // Status glyph + colour
    let glyph;
    if (isDenied)   glyph = fmt.yellow('⊘');
    else if (ok)    glyph = fmt.green('✓');
    else            glyph = fmt.red('✗');
    // Per-tool category glyph (emoji for friendly themes, ASCII otherwise)
    const cat = _toolGlyph(tool, this.themeName);

    if (cols < 100) {
      // ── Narrow fallback (one-liner) ────────────────────────────────────
      const durStr = duration ? ' ' + fmt.cyan('⏱ ' + fmtDuration(duration)) : '';
      const argsStr = fmtArgsInline(args);
      const argsRender = argsStr ? ' ' + fmt.dim(argsStr) : '';
      if (ok) {
        this.engine.print(`  ${glyph} ${cat} ${fmt.cyan(tool)}${argsRender}${durStr}`);
        const out = String(result?.out || '');
        if (out && out.length < 400) {
          const lines = out.split('\n');
          for (const l of lines.slice(0, 4)) this.engine.print('    ' + fmt.dim(l));
          if (lines.length > 4) this.engine.print('    ' + fmt.dim(`(+ ${lines.length - 4} more lines)`));
        }
      } else {
        const err = result?.err || result?.error || 'failed';
        this.engine.print(`  ${glyph} ${cat} ${fmt.cyan(tool)}${argsRender} ${fmt.red(String(err).slice(0, 120))}${durStr}`);
      }
    } else {
      // ── Wide card with rounded Unicode borders ─────────────────────────
      const innerWidth = Math.min(cols - 4, 100); // leave 2-char gutter + closing safety
      const argsRendered = fmtArgsInline(args);
      const headerRaw = ` ${cat} ${tool} `;
      // Title row: ╭─ <tool> ─...─  <status> <duration>
      const trailingStatus = (duration ? fmt.cyan('⏱ ' + fmtDuration(duration)) : '');
      const statusTail = ' ' + glyph + (trailingStatus ? ' ' + trailingStatus : '');
      // Visible budget for the dashes between tool name and the trailing status
      const titlePrefixVis = 1 + 1 + headerRaw.length; // "╭" + "─" + " tool "
      const titleSuffixVis = visibleLen(statusTail);
      const dashCount = Math.max(2, innerWidth - titlePrefixVis - titleSuffixVis);
      const topLine = '  '
        + fmt.dim('╭─')
        + fmt.cyan(headerRaw)
        + fmt.dim('─'.repeat(dashCount))
        + statusTail;
      this.engine.print(topLine);

      // Body — "args:" then "out:"/"err:"
      const renderRow = (label, text) => {
        // Wrap text within the box; show up to 6 lines.
        const txt = String(text || '');
        const lines = txt.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '');
        const max = innerWidth - 2 - label.length - 1;
        const rendered = [];
        for (const raw of lines) {
          let rest = raw;
          let firstSlice = true;
          while (rest.length > 0 || firstSlice) {
            const slice = rest.slice(0, max);
            rest = rest.slice(max);
            rendered.push(slice);
            firstSlice = false;
            if (rest.length === 0) break;
          }
        }
        const totalRows = rendered.length || 1;
        const shown = rendered.slice(0, 6);
        const truncated = totalRows - shown.length;
        if (!shown.length) shown.push('');
        for (let i = 0; i < shown.length; i++) {
          // Label appears only on the first row of the whole block;
          // continuation rows are indented by the label's visible width.
          const lbl = (i === 0 ? fmt.dim(label) : ' '.repeat(visibleLen(label)));
          const body = i === 0 ? shown[i] : fmt.dim(shown[i]);
          this.engine.print('  ' + fmt.dim('│  ') + lbl + ' ' + body);
        }
        if (truncated > 0) {
          this.engine.print('  ' + fmt.dim('│  ') + ' '.repeat(visibleLen(label) + 1)
            + fmt.dim(`(+ ${truncated} more lines)`));
        }
      };

      if (argsRendered) renderRow('args:', argsRendered);

      if (ok) {
        const out = String(result?.out || '');
        if (out) renderRow('out: ', out);
      } else {
        const err = String(result?.err || result?.error || 'failed');
        renderRow('err: ', fmt.red(err));
      }

      this.engine.print('  ' + fmt.dim('╰' + '─'.repeat(innerWidth - 1)));
    }
    this.spinner = this._newSpinner('⌁ thinking…', 'thinking');
  }
  reflection(goalMet, confidence) {
    if (this.spinner) this.spinner.stop();
    const tag = goalMet === 'yes' ? fmt.green('● goal met')
              : goalMet === 'partial' ? fmt.yellow('● partial')
              : fmt.red('● not met');
    const conf = confidence ? fmt.dim(` confidence=${confidence}`) : '';
    this.engine.print(`  ${tag}${conf}`);
    this.spinner = this._newSpinner('finishing…', 'reflecting');
  }
  stop() { if (this.spinner) { this.spinner.stop(); this.spinner = null; } }
}

async function main({ flags } = {}) {
  // CRITICAL — global crash handlers. If anything in TUI startup throws
  // (e.g. a status-line render error or a runtime require fault), the
  // process must NOT vanish silently on the user. This was the v0.0.1
  // Windows splash-then-exit bug. Without these handlers, uncaught
  // exceptions from the TUI startup would print nothing visible and
  // the binary would just disappear back to the shell prompt.
  if (!process.__horizonTuiHandlersInstalled) {
    process.__horizonTuiHandlersInstalled = true;
    process.on('uncaughtException', (e) => {
      process.stderr.write('\n\x1b[31m[fatal]\x1b[0m ' + (e?.stack || e?.message || String(e)) + '\n');
      process.exit(1);
    });
    process.on('unhandledRejection', (r) => {
      process.stderr.write('\n\x1b[31m[reject]\x1b[0m ' + (r?.stack || r?.message || String(r)) + '\n');
    });
  }

  const runtime = createHorizonRuntime({
    userDataDir: flags?.['user-data-dir'],
    workspaceDir: flags?.workspace || process.cwd(),
    verbose: !!flags?.verbose,
  });

  // Experiment — Ink-based TUI prototype lives in bin/tui-ink/. Opt in
  // via --ink or HORIZON_INK_TUI=1. Ink 7 is ESM-only so we dynamic-import
  // the entry point from this CJS launcher. Under pkg-bundled builds the
  // import will fail and we fall back to the readline TUI with a notice.
  const wantInk = !!flags?.ink || process.env.HORIZON_INK_TUI === '1';
  if (wantInk) {
    try {
      const inkUrl = require('url').pathToFileURL(
        path.join(__dirname, 'tui-ink', 'index.mjs')
      ).href;
      const inkMod = await import(inkUrl);
      await inkMod.start({ runtime, flags });
      return;
    } catch (e) {
      process.stderr.write(
        fmt.warn('Ink TUI unavailable in this build — falling back to readline TUI.') + '\n' +
        fmt.dim('  reason: ' + (e?.message || String(e))) + '\n'
      );
      // Fall through to the readline path below.
    }
  }

  if (!isTTY) process.stderr.write(fmt.warn('TUI works best in an interactive terminal') + '\n');

  // Fix 2 — welcome reveal is now OPT-IN. Default first launch is silent.
  // Trigger the animated reveal only when:
  //   - HORIZON_REVEAL=1 environment variable is set, OR
  //   - --reveal flag is passed on the CLI
  // The forced persona picker is gone — persona stays default ('jarvis'),
  // user picks one later via `/persona` or `horizon persona <id>`.
  const FIRST_LAUNCH_FLAG = 'tui.welcomedAt';
  const isFirstLaunch = !runtime.settingsStore.get(FIRST_LAUNCH_FLAG)
                     && !(runtime.agentMemory?._data?.conversations?.length);
  const wantReveal = !!(flags?.reveal) || process.env.HORIZON_REVEAL === '1';
  if (wantReveal && isTTY) {
    await welcomeReveal({
      provider: runtime.settingsStore.get('provider'),
      persona: runtime.settingsStore.get('persona'),
      lang: runtime.settingsStore.get('lang'),
    });
  }
  if (isFirstLaunch) {
    try { runtime.settingsStore.set(FIRST_LAUNCH_FLAG, new Date().toISOString()); } catch (_) {}
  }

  const state = {
    history: [],
    mode: 'chat',
    stream: true,
    markdown: true,
  };

  // CRITICAL — hold the event loop until the engine exits.
  // Without this resolver, main() resolves the moment engine.start()
  // returns (which is immediately — start() is synchronous), the
  // awaiting dispatcher resolves too, and Node decides "nothing left
  // to do" and exits the process right after the banner renders.
  // This was the bug. The promise is resolved by the engine's onExit.
  let exitResolver;
  const exitPromise = new Promise((resolve) => { exitResolver = resolve; });

  const engine = new TuiEngine({
    runtime,  // Fix 3 — engine reads provider/persona/cost/etc. for the status line
    verbose: !!flags?.verbose,
    altScreen: !!flags?.['alt-screen'],  // /altscreen toggle (or --alt-screen)
    yolo: !!flags?.['auto-approve'] || process.env.HORIZON_YOLO === '1',
    onExit: () => { if (exitResolver) { const r = exitResolver; exitResolver = null; r(); } },
    completer: (line) => {
      if (!line.startsWith('/')) return [[], line];
      const hits = SLASH_LIST.filter(c => c.startsWith(line));
      return [hits, line];
    },
    onLine: async (raw) => {
      const line = raw.trim();
      if (!line) return;
      // Echo user line into transcript. Sprint 2.1 — captioned echo:
      //   ▌ you · 14:32
      //   | <message>
      // Uses an accent-coloured left-half-block bullet and a dim grey
      // timestamp so the eye can quickly find turn boundaries.
      const _now = new Date();
      const _ts = String(_now.getHours()).padStart(2, '0') + ':'
                + String(_now.getMinutes()).padStart(2, '0');
      engine.print(fmt.cyan('▌ ') + fmt.bold('you') + ' ' + fmt.dim('· ' + _ts));
      // Each content line gets a dim "| " gutter so multi-line input
      // visibly stays grouped under the caption.
      for (const _ln of line.split('\n')) {
        engine.print(fmt.dim('| ') + _ln);
      }
      try {
        // Sprint 2.3 — Easter eggs run before the slash dispatcher so they
        // intercept /tea, /coffee, /whoami, /secret, /art and plain text
        // like "coffee", "who am i". Falls through on miss.
        const egg = matchEasterEgg(line);
        if (egg) {
          await runEasterEgg(egg, runtime, engine);
          return;
        }
        if (line.startsWith('/')) await handleSlash(line, state, runtime, engine);
        else await runOne(runtime, state, engine, line);
      } catch (e) {
        engine.print(fmt.red('error: ' + e.message));
      }
    },
  });

  // Sprint 4 — Task 1: shared helper that toggles a section AND repaints
  // the banner in-place. Wired into the engine via setSectionToggleHook so
  // digit shortcuts (1/2/3/4), Tab cycling, and mouse clicks all share the
  // same repaint path. opts.force === 'expand' means "set this one to
  // expanded regardless of current state" (used by Tab cycling so the user
  // sees the cycled section open even if it was already expanded).
  const _toggleSectionAndRepaint = (id, opts = {}) => {
    if (!engine.getSections) return;
    const sect = engine.getSections()[id];
    if (!sect) return;
    if (opts.force === 'expand') sect.expanded = true;
    else sect.expanded = !sect.expanded;
    const fresh = bannerHeader(runtime, engine);
    engine.print(fresh);
    // Re-register the section click map. engine.print() appended the banner
    // to the transcript, so the base index of the banner top is exactly
    // (transcript.length - totalLines).
    if (fresh && fresh.sectionOffsets && typeof engine.registerSectionRows === 'function') {
      const base = engine.transcript.length - (fresh.totalLines || 0);
      const entries = fresh.sectionOffsets.map(s => ({
        transcriptIdx: base + s.offset,
        sectionId: s.id,
      }));
      engine.registerSectionRows(entries);
    }
  };
  if (typeof engine.setSectionToggleHook === 'function') {
    engine.setSectionToggleHook(_toggleSectionAndRepaint);
  }

  // Sprint 2.12 — print the Hermes-style banner header AFTER engine creation
  // so it can read the engine's collapsible-section state. Layout:
  //   - clear screen unless this is the first launch (welcomeReveal already
  //     painted there)
  //   - framed banner box
  //   - collapsible sections (Tools / Skills / System prompt / MCP)
  //   - greeting line
  //   - "▌ Type a message…" prompt hint
  const banner = bannerHeader(runtime, engine);
  process.stdout.write((isFirstLaunch ? '' : '\x1b[2J\x1b[H') + banner);

  const hasKey = _runtimeHasAnyKey(runtime);
  if (!hasKey) {
    process.stdout.write(
      '\n  \x1b[33m⚠\x1b[0m  \x1b[97mNo API key set yet.\x1b[0m  ' +
      '\x1b[90mType\x1b[0m \x1b[36m/quit\x1b[0m\x1b[90m, then run\x1b[0m \x1b[36mhorizon setup\x1b[0m \x1b[90mto add one.\x1b[0m\n'
    );
  } else {
    process.stdout.write(
      '\n  \x1b[90m▌ Type a message and press \x1b[97mEnter\x1b[90m to send.\x1b[0m  ' +
      '\x1b[90m\x1b[36m/help\x1b[90m for commands · \x1b[36m/quit\x1b[90m to exit.\x1b[0m\n'
    );
  }

  // Seed transcript with the banner so search/scroll see it
  String(banner).split('\n').forEach(l => engine.transcript.push(l));
  // Sprint 4 — Task 1: register section header click regions. The banner
  // was just appended to the transcript, so the absolute index of each
  // section header line is (transcript.length - totalLines + offset).
  if (banner && banner.sectionOffsets && typeof engine.registerSectionRows === 'function') {
    const base = engine.transcript.length - (banner.totalLines || 0);
    const entries = banner.sectionOffsets.map(s => ({
      transcriptIdx: base + s.offset,
      sectionId: s.id,
    }));
    engine.registerSectionRows(entries);
  }

  engine.start();

  // Block here forever — engine.close() / engine._exit() resolves this.
  return exitPromise;
}

/**
 * Sprint 2.3 — render an Easter-egg art piece into the engine transcript.
 * Two special sentinels: 'whoami' (renders persona card) and '__gallery__'
 * (dumps every art piece with its name). All others go through renderArt.
 */
async function runEasterEgg(eggName, runtime, engine) {
  if (eggName === 'whoami') {
    // Personalised "who am I" card — render the persona + memory snapshot
    // inside a tasteful Unicode frame. Falls back gracefully when memory
    // is empty.
    const persona = runtime.settingsStore?.get?.('persona') || 'jarvis';
    const memCount = runtime.agentMemory?._data?.memories?.length || 0;
    const provider = runtime.settingsStore?.get?.('provider') || 'gemini';
    const lang = runtime.settingsStore?.get?.('lang') || 'en';
    // Pull the top 3 most-recent / important facts the agent has stored
    // about the user. Cheap best-effort — we don't want any I/O failure to
    // break the egg.
    let topFacts = [];
    try {
      const mems = runtime.agentMemory?._data?.memories || [];
      const sorted = [...mems]
        .filter(m => m && (m.content || m.text))
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .slice(0, 3);
      topFacts = sorted.map(m => String(m.content || m.text || '').slice(0, 60));
    } catch (_) {}
    const lines = [
      '   ╭─ who you are ────────────╮',
      `   │  persona  ${fmt.cyan(persona.padEnd(14))} │`,
      `   │  provider ${fmt.cyan(provider.padEnd(14))} │`,
      `   │  lang     ${fmt.cyan(lang.padEnd(14))} │`,
      `   │  memory   ${fmt.green(String(memCount).padEnd(14))} │`,
      '   ╰──────────────────────────╯',
    ];
    engine.print('');
    for (const l of lines) engine.print(l);
    if (topFacts.length) {
      engine.print('');
      engine.print('   ' + fmt.dim('what I remember about you:'));
      for (const f of topFacts) engine.print('     ' + fmt.dim('· ' + f));
    }
    engine.print('');
    return;
  }

  if (eggName === '__gallery__') {
    // Quick gallery — print every art piece with its name as a tiny header.
    const { ART, renderArt } = require('./lib/banner');
    engine.print('');
    engine.print('  ' + fmt.bold('ascii art gallery'));
    engine.print('  ' + fmt.dim('opt out anytime with HORIZON_NO_ART=1 / --no-art'));
    for (const n of Object.keys(ART)) {
      engine.print('');
      engine.print('  ' + fmt.cyan(n));
      const out = renderArt(n);
      if (out) for (const l of out.split('\n')) engine.print(l);
    }
    engine.print('');
    return;
  }

  const art = renderArt(eggName);
  if (art) {
    engine.print('');
    for (const l of art.split('\n')) engine.print(l);
    engine.print('');
  } else {
    engine.print(fmt.dim('(art suppressed)'));
  }
}

// Sprint 4 — Task 1: shared "print banner + refresh click map" helper, used
// by /banner, /sections, and the section toggle hook. Keeps the click region
// registration in lock-step with whatever sections are currently expanded.
function _reprintBannerAndRegister(runtime, engine) {
  const fresh = bannerHeader(runtime, engine);
  engine.print(fresh);
  if (fresh && fresh.sectionOffsets && typeof engine.registerSectionRows === 'function') {
    const base = engine.transcript.length - (fresh.totalLines || 0);
    const entries = fresh.sectionOffsets.map(s => ({
      transcriptIdx: base + s.offset,
      sectionId: s.id,
    }));
    engine.registerSectionRows(entries);
  }
}

async function handleSlash(raw, state, runtime, engine) {
  const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const head = tokens[0];
  const rest = tokens.slice(1).map(t => t.replace(/^"|"$/g, ''));

  if (head === '/quit' || head === '/exit') { engine.close(); process.exit(0); return; }
  if (head === '/help') {
    // Sprint 2.12 — Hermes-style modal overlay. Help renders in the
    // alternate screen buffer; transcript / scrollback are preserved.
    // Falls back to inline print on non-TTY (modalOverlay handles that).
    // Sprint 4 — Task 2: pass a title so the bordered card shows "Help" in
    // the top edge gap.
    if (engine && typeof engine.modalOverlay === 'function') {
      await engine.modalOverlay(buildHelp(), { title: 'Horizon · Help' });
    } else {
      engine.print(buildHelp());
    }
    return;
  }
  if (head === '/clear') {
    process.stdout.write('\x1b[2J\x1b[H');
    engine.transcript = [];
    // Section row indexes referred into the now-empty transcript.
    if (typeof engine.registerSectionRows === 'function') engine.registerSectionRows([]);
    return;
  }
  if (head === '/banner') {
    _reprintBannerAndRegister(runtime, engine);
    return;
  }
  if (head === '/sections') {
    // Toggle one of the startup-banner collapsible sections.
    //   /sections          → list current state
    //   /sections tools    → toggle tools section
    const id = rest[0];
    const sections = engine.getSections ? engine.getSections() : {};
    if (!id) {
      engine.print(fmt.dim('sections:'));
      for (const [k, v] of Object.entries(sections)) {
        const chevron = v.expanded ? '▾' : '▸';
        engine.print(`  ${chevron} ${k.padEnd(10)} ${fmt.dim(v.expanded ? 'expanded' : 'collapsed')}`);
      }
      engine.print(fmt.dim('usage: /sections <tools|skills|prompt|mcp>'));
      return;
    }
    const result = engine.toggleSection(id);
    if (result === null) {
      engine.print(fmt.err('unknown section: ' + id));
      return;
    }
    engine.print(fmt.ok(`${id} → ${result ? 'expanded' : 'collapsed'}`));
    // Re-render the banner so the user sees the new layout. Use the shared
    // helper so the section click map stays in sync with the new headers.
    _reprintBannerAndRegister(runtime, engine);
    return;
  }
  if (head === '/altscreen') {
    // Toggle alternate-screen rendering for the live view.
    //   /altscreen on    → alt screen on (no scrollback pollution)
    //   /altscreen off   → alt screen off
    //   /altscreen       → toggle
    let want;
    if (rest[0] === 'on')  want = true;
    else if (rest[0] === 'off') want = false;
    else                   want = !engine._altScreen;
    if (typeof engine.setAltScreen === 'function') {
      engine.setAltScreen(want);
      engine.print(fmt.dim('alt-screen: ') + (want ? fmt.green('on') : fmt.red('off')));
    }
    return;
  }
  if (head === '/reset') {
    state.history.length = 0;
    engine.print(fmt.dim('chat history cleared (memory retained)'));
    return;
  }
  if (head === '/find') {
    const q = rest.join(' ');
    if (!q) { engine.print(fmt.dim('usage: /find <query>  (or press Ctrl+F)')); return; }
    engine.searchQuery = q;
    engine._refreshSearch();
    engine._jumpToMatch(0);
    return;
  }
  if (head === '/stream') {
    if (rest[0] === 'on')  state.stream = true;
    if (rest[0] === 'off') state.stream = false;
    engine.print(fmt.dim('streaming: ') + (state.stream ? fmt.green('on') : fmt.red('off')));
    return;
  }
  if (head === '/markdown') {
    if (rest[0] === 'on')  state.markdown = true;
    if (rest[0] === 'off') state.markdown = false;
    engine.print(fmt.dim('markdown: ') + (state.markdown ? fmt.green('on') : fmt.red('off')));
    return;
  }
  if (head === '/skills') {
    // Phase 20.3 — interactive picker. Highlighted row uses reverse-video
    // bg ("hover" effect), arrow keys / mouse wheel move the cursor,
    // Enter shows the picked skill, Esc cancels.
    //
    // Premium pass: group by enabled/disabled when a skill exposes
    // `.enabled`; description always visible as sublabel.
    const list = runtime.skillsManager?.list() || [];
    if (!list.length) { engine.print(fmt.dim('no skills installed')); return; }
    const sorted = list.slice().sort((a, b) => {
      const ea = a.enabled === false ? 1 : 0;
      const eb = b.enabled === false ? 1 : 0;
      if (ea !== eb) return ea - eb;
      return String(a.id).localeCompare(String(b.id));
    });
    const items = sorted.map((s) => ({
      label: s.id,
      sublabel: s.description || s.scope || '',
      aside: s.scope ? '(' + s.scope + ')' : '',
      value: s,
      group: s.enabled === false ? 'Disabled' : 'Enabled',
    }));
    const picked = await interactiveMenu({
      engine,
      title: 'Skills',
      items,
      footer: '↑/↓ move · Enter show SKILL.md · / filter · Esc cancel',
    });
    if (!picked) { engine.print(fmt.dim('cancelled')); return; }
    const src = runtime.skillsManager?.readSource(picked.id);
    if (!src) { engine.print(fmt.err('not found')); return; }
    engine.print(fmt.cyan(`── ${picked.id} ──`));
    engine.print(state.markdown ? renderMarkdown(src) : src);
    return;
  }
  if (head === '/skill-show') {
    const id = rest[0];
    if (!id) { engine.print(fmt.err('usage: /skill-show <id>')); return; }
    const src = runtime.skillsManager?.readSource(id);
    if (!src) { engine.print(fmt.err('not found')); return; }
    engine.print(state.markdown ? renderMarkdown(src) : src);
    return;
  }
  if (head === '/skill') {
    const id = rest[0];
    if (!id) { engine.print(fmt.err('usage: /skill <id> [task]')); return; }
    await runOne(runtime, state, engine, rest.slice(1).join(' ') || `Apply skill ${id}.`, 'agent');
    return;
  }
  if (head === '/agent') {
    const task = rest.join(' ');
    if (!task) { engine.print(fmt.err('usage: /agent <task>')); return; }
    await runOne(runtime, state, engine, task, 'agent');
    return;
  }
  if (head === '/chat') {
    const msg = rest.join(' ');
    if (!msg) { engine.print(fmt.err('usage: /chat <message>')); return; }
    await runOne(runtime, state, engine, msg, 'chat');
    return;
  }
  if (head === '/persona') {
    const id = rest[0];
    if (!id) engine.print(`${fmt.cyan(runtime.settingsStore.get('persona') || 'jarvis')}`);
    else {
      runtime.settingsStore.set('persona', id);
      engine.print(fmt.ok('persona → ' + fmt.cyan(id)));
    }
    return;
  }
  if (head === '/persona-list') {
    const list = runtime.personas?.getAllPersonas?.() || [];
    const active = runtime.settingsStore.get('persona') || 'jarvis';
    if (!list.length) { engine.print(fmt.dim('no personas')); return; }
    // Premium pass — group by personality archetype using a simple
    // id-based heuristic. Custom (non-built-in) personas land in
    // "Custom". The default `getAllPersonas()` doesn't ship taglines,
    // so we derive a short blurb from the localised greeting where
    // available.
    const FORMAL = new Set(['jarvis', 'alfred']);
    const CASUAL = new Set(['friday', 'pixel']);
    const ACADEMIC = new Set(['sage']);
    function archetype(p) {
      if (!p.builtin) return 'Custom';
      if (FORMAL.has(p.id))   return 'Formal';
      if (CASUAL.has(p.id))   return 'Casual';
      if (ACADEMIC.has(p.id)) return 'Academic';
      return 'Other';
    }
    const order = ['Formal', 'Casual', 'Academic', 'Other', 'Custom'];
    const sorted = list.slice().sort((a, b) => {
      const da = order.indexOf(archetype(a));
      const db = order.indexOf(archetype(b));
      if (da !== db) return da - db;
      return String(a.id).localeCompare(String(b.id));
    });
    const items = sorted.map((p) => ({
      label: (p.name || p.id) + (p.id === active ? '  (active)' : ''),
      sublabel: (p.greeting_en || '').trim().slice(0, 64),
      aside: p.id,
      value: p,
      group: archetype(p),
    }));
    const picked = await interactiveMenu({
      engine,
      title: 'Pick a persona',
      initial: Math.max(0, sorted.findIndex((p) => p.id === active)),
      items,
      footer: '↑/↓ move · Enter activate · / filter · Esc cancel',
    });
    if (!picked) { engine.print(fmt.dim('cancelled')); return; }
    runtime.settingsStore.set('persona', picked.id);
    engine.print(fmt.ok('persona → ' + fmt.cyan(picked.id)));
    return;
  }
  if (head === '/model') {
    const newProv = rest[0];
    if (!newProv) {
      const current = runtime.settingsStore.get('provider') || 'gemini';
      const m = runtime.settingsStore.get('model.' + current) || '';
      engine.print(`${fmt.cyan(current)} ${fmt.dim('(' + m + ')')}`);
    } else {
      runtime.settingsStore.set('provider', newProv);
      engine.print(fmt.ok('provider → ' + fmt.cyan(newProv)));
    }
    return;
  }
  if (head === '/model-list') {
    // Premium drill-down picker.
    //
    // 1. Pick a provider (grouped: Free tier / Local / Cheap paid /
    //    Premium / Specialised / Aggregators).
    // 2. Once a provider is chosen, immediately open a SECOND picker
    //    showing per-model options for that provider.
    // 3. Enter on a model commits BOTH provider AND `model.<provider>`.
    // 4. Esc in the model picker returns to the provider picker.
    // 5. Esc in the provider picker cancels the whole flow.
    const {
      DEFAULT_PROVIDER_MODELS, PROVIDER_GROUPS, PROVIDER_LABELS,
      modelsForProvider,
    } = require('../src/main/runtime/ai-providers');
    const active = runtime.settingsStore.get('provider') || 'gemini';

    // Build the provider list ordered by PROVIDER_GROUPS so the picker
    // can render meaningful section headers.
    function buildProviderItems() {
      const seen = new Set();
      const out = [];
      for (const [group, ids] of Object.entries(PROVIDER_GROUPS)) {
        for (const p of ids) {
          if (!DEFAULT_PROVIDER_MODELS[p]) continue;
          if (seen.has(p)) continue;
          seen.add(p);
          const isLocal = ['ollama','lmstudio','localai'].includes(p);
          const hasKey = isLocal ? null : !!runtime.keysStore.get('k_' + p);
          const marker = isLocal ? fmt.dim('—') : (hasKey ? fmt.green('✓') : fmt.dim('·'));
          const storedModel = runtime.settingsStore.get('model.' + p) || DEFAULT_PROVIDER_MODELS[p];
          const isActive = p === active;
          out.push({
            label: p + (isActive ? '  (active)' : ''),
            sublabel: PROVIDER_LABELS[p] || p,
            aside: storedModel,
            marker,
            value: { id: p },
            group,
          });
        }
      }
      // Anything in DEFAULT_PROVIDER_MODELS that didn't fit a group goes
      // under "Other" — keeps us robust if a provider gets added later.
      for (const p of Object.keys(DEFAULT_PROVIDER_MODELS)) {
        if (seen.has(p)) continue;
        const isLocal = ['ollama','lmstudio','localai'].includes(p);
        const hasKey = isLocal ? null : !!runtime.keysStore.get('k_' + p);
        const marker = isLocal ? fmt.dim('—') : (hasKey ? fmt.green('✓') : fmt.dim('·'));
        out.push({
          label: p,
          sublabel: PROVIDER_LABELS[p] || p,
          aside: DEFAULT_PROVIDER_MODELS[p],
          marker,
          value: { id: p },
          group: 'Other',
        });
      }
      return out;
    }

    // Drill loop — Esc inside the model picker reopens the provider picker.
    let providerItems = buildProviderItems();
    let initialProvider = Math.max(0,
      providerItems.findIndex((it) => it.value && it.value.id === active));

    while (true) {
      const pickedProv = await interactiveMenu({
        engine,
        title: 'Pick a provider',
        initial: initialProvider,
        items: providerItems,
        footer: '↑/↓ move · Enter drill into models · / filter · Esc cancel · ✓ = key set',
      });
      if (!pickedProv) { engine.print(fmt.dim('cancelled')); return; }

      const provId = pickedProv.id;
      const catalog = modelsForProvider(provId);
      if (!catalog.length) {
        // Provider has no catalog (shouldn't happen with the fallback)
        runtime.settingsStore.set('provider', provId);
        engine.print(fmt.ok('provider → ' + fmt.cyan(provId)));
        return;
      }

      const storedModel = runtime.settingsStore.get('model.' + provId) || catalog[0].id;
      const modelItems = catalog.map((m) => ({
        label: m.label || m.id,
        sublabel: m.tagline || '',
        aside: m.cost || m.id,
        marker: m.id === storedModel ? fmt.green('✓') : fmt.dim('·'),
        value: m,
      }));
      const initialModel = Math.max(0, catalog.findIndex((m) => m.id === storedModel));
      const pickedModel = await interactiveMenu({
        engine,
        title: (PROVIDER_LABELS[provId] || provId) + ' · models',
        initial: initialModel,
        items: modelItems,
        footer: '↑/↓ move · Enter commit · / filter · Esc back to providers',
      });
      if (!pickedModel) {
        // Esc inside model picker → re-enter provider picker.
        initialProvider = Math.max(0,
          providerItems.findIndex((it) => it.value && it.value.id === provId));
        continue;
      }

      runtime.settingsStore.set('provider', provId);
      runtime.settingsStore.set('model.' + provId, pickedModel.id);
      // Sprint 2.11 fix — the status bar reads provider/model from
      // settingsStore on each render, but the engine's input bar is
      // already painted with the OLD values. Force a redraw so the bar
      // reflects the new selection BEFORE we print the success line —
      // that way the user sees both update together.
      try {
        if (engine && typeof engine._forceRedraw === 'function') engine._forceRedraw();
      } catch (_) {}
      engine.print(fmt.ok(
        'provider → ' + fmt.cyan(provId) +
        fmt.dim(' · model → ') + fmt.cyan(pickedModel.id)
      ));
      return;
    }
  }
  if (head === '/models') {
    // Flat search across every (provider, model) pair — the Cursor /
    // Hermes pattern. User can pre-filter by typing after the slash:
    //   /models claude   → opens with "claude" already typed
    //   /models opus     → narrows to opus variants across providers
    const {
      DEFAULT_PROVIDER_MODELS, PROVIDER_LABELS, modelsForProvider,
    } = require('../src/main/runtime/ai-providers');
    const active = runtime.settingsStore.get('provider') || 'gemini';
    const items = [];
    for (const p of Object.keys(DEFAULT_PROVIDER_MODELS)) {
      const isLocal = ['ollama','lmstudio','localai'].includes(p);
      const hasKey = isLocal ? null : !!runtime.keysStore.get('k_' + p);
      const marker = isLocal ? fmt.dim('—') : (hasKey ? fmt.green('✓') : fmt.dim('·'));
      const storedModel = runtime.settingsStore.get('model.' + p) || DEFAULT_PROVIDER_MODELS[p];
      const catalog = modelsForProvider(p);
      for (const m of catalog) {
        const isActive = p === active && m.id === storedModel;
        items.push({
          label: p + fmt.dim(' / ') + (m.label || m.id),
          sublabel: m.tagline || (PROVIDER_LABELS[p] || ''),
          aside: m.cost || m.id,
          marker,
          value: { provider: p, model: m },
          // Group by provider so the flat list still has structure.
          group: PROVIDER_LABELS[p] || p,
        });
        if (isActive) items[items.length - 1].label += '  (active)';
      }
    }
    const preFilter = rest.join(' ').trim().toLowerCase();
    const picked = await interactiveMenu({
      engine,
      title: 'All models',
      items,
      // If the user typed `/models claude`, we don't yet auto-seed
      // the filter input — but a future helper could. For now we
      // document the workflow and rely on `/` to open search.
      footer: preFilter
        ? `↑/↓ move · Enter commit · / filter (try "${preFilter}") · Esc cancel`
        : '↑/↓ move · Enter commit · / filter · Esc cancel',
    });
    if (!picked) { engine.print(fmt.dim('cancelled')); return; }
    runtime.settingsStore.set('provider', picked.provider);
    runtime.settingsStore.set('model.' + picked.provider, picked.model.id);
    engine.print(fmt.ok(
      'provider → ' + fmt.cyan(picked.provider) +
      fmt.dim(' · model → ') + fmt.cyan(picked.model.id)
    ));
    return;
  }
  if (head === '/mem') {
    const q = rest.join(' ');
    if (!q) { engine.print(fmt.err('usage: /mem "query"')); return; }
    const results = await runtime.agentMemory.semanticRecall(q, 5, {});
    if (!results.length) engine.print(fmt.dim('no matches'));
    else for (const m of results) {
      const score = typeof m.score === 'number' ? fmt.dim(`(${m.score.toFixed(2)}) `) : '';
      engine.print(`${score}${m.content || m.text || ''}`);
    }
    return;
  }
  if (head === '/verbose') {
    engine.print(fmt.dim('verbose toggle: restart with --verbose'));
    return;
  }
  if (head === '/mobile') {
    // Pair a phone — same flow as `horizon mobile` from the shell.
    // The handler prints its own QR + instructions, then blocks on the
    // server until Ctrl+C. We can't host that long-running server inside
    // the TUI's event loop without confusing the renderer, so we point
    // the user at the standalone command.
    engine.print('');
    engine.print('  ' + fmt.bold('Phone pairing'));
    engine.print('  ' + fmt.dim('The mobile companion needs a long-running server, which would conflict'));
    engine.print('  ' + fmt.dim('with this TUI session. Open a second terminal and run:'));
    engine.print('');
    engine.print('    ' + fmt.cyan('horizon mobile'));
    engine.print('');
    engine.print('  ' + fmt.dim('That will show a QR code your phone\'s camera can scan.'));
    engine.print('');
    return;
  }
  engine.print(fmt.err('unknown slash command: ' + head));
}

async function runOne(runtime, state, engine, message, modeOverride) {
  const mode = modeOverride || state.mode;
  if (mode === 'agent') await runAgent(runtime, state, engine, message);
  else                  await runChat(runtime, state, engine, message);
}

// Hard wall-clock budget for any single provider call. If the network
// stalls or a provider silently drops a stream, we don't want the TUI
// locked forever — kick the promise after 5 minutes so the composer
// re-opens and the user can retry.
const PROVIDER_HARD_TIMEOUT_MS = 5 * 60 * 1000;

// Promise.race against an AbortController + wall-clock timer. Returns
// { value, aborted, timedOut } so callers can suppress post-abort UI
// writes without throwing through user code paths.
function _interruptibleRace(work, controller, signalAborted, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('provider timed out')), timeoutMs);
    if (timer.unref) timer.unref();
  });
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  return Promise.race([work, timeout, aborted])
    .then(v => ({ value: v, aborted: signalAborted(), timedOut: false }))
    .catch(err => {
      if (signalAborted()) return { value: null, aborted: true, timedOut: false };
      if (err && /timed out/i.test(err.message)) return { value: null, aborted: false, timedOut: true };
      throw err;
    })
    .finally(() => { if (timer) clearTimeout(timer); });
}

async function runChat(runtime, state, engine, message) {
  engine.setSending(true);
  engine.print('');

  // Soft-cancel plumbing: Esc during sending → abort signal → composer reopens
  // even if the provider stream is wedged. The runtime/providers don't honor
  // opts.signal yet, but the UI side aborts cleanly and the orphan resolve
  // (if any) is suppressed via the `aborted` closure flag below.
  const controller = new AbortController();
  let aborted = false;
  controller.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
  engine.setAbortHandler(() => {
    controller.abort('user-esc');
    engine.print(fmt.warn('  ⟂ interrupted'));
  });

  try {
    if (state.stream) {
      // Sprint 2 — buffer the stream, then re-render markdown every ~120ms
      // by REPLACING the assistant message tail in transcript. This avoids
      // the old double-render ("raw tokens then —— rendered ——" block) and
      // gives a smooth live-rendered reply. Falls back to plain passthrough
      // when /markdown is off.
      //
      // Sprint 2.1 — caption-style prefix matching the user echo. The
      // engine itself emits the "▌ horizon" caption + dim divider in
      // startStreamingMessage() (turn-separator polish); the prefix
      // passed here is what gets glued onto the FIRST line of the
      // streamed text, so we keep it as a simple gutter to stay
      // visually grouped with the caption above.
      const useMarkdown = state.markdown !== false;
      engine.startStreamingMessage(fmt.dim('| '));
      let buf = '';
      let lastRender = 0;
      const work = runtime.runChatStream(message, { history: state.history, signal: controller.signal }, (chunk) => {
        if (aborted) return; // suppress post-interrupt UI writes
        buf += chunk;
        const now = Date.now();
        if (now - lastRender >= 120) {
          engine.updateStreamingMessage(buf, { markdown: useMarkdown });
          lastRender = now;
        }
      });
      const race = await _interruptibleRace(work, controller, () => aborted, PROVIDER_HARD_TIMEOUT_MS);
      if (race.aborted) { engine.finishStreamingMessage(); return; }
      if (race.timedOut) {
        engine.finishStreamingMessage();
        engine.print(fmt.err('  ⟂ provider timed out after 5 min — try /model to switch'));
        return;
      }
      const r = race.value || {};
      // Final render — use r.reply if the provider returned a fully-assembled
      // string, otherwise the streamed buf. Either way: one last full pass
      // through the markdown renderer guarantees an unterminated fence is
      // closed correctly.
      const finalText = r.reply || buf;
      engine.updateStreamingMessage(finalText, { markdown: useMarkdown });
      engine.finishStreamingMessage();
      if (r.error) engine.print(fmt.err(friendlyError(r.error)));
      if (r.reply || buf) {
        state.history.push({ role: 'user', content: message });
        state.history.push({ role: 'assistant', content: r.reply || buf });
      }
      // Sprint 2 — feed token/cost into the status bar.
      if (r.usage) engine.recordUsage(r.usage, { model: r.model });
    } else {
      const work = runtime.runChat(message, { history: state.history, signal: controller.signal });
      const race = await _interruptibleRace(work, controller, () => aborted, PROVIDER_HARD_TIMEOUT_MS);
      if (race.aborted) return;
      if (race.timedOut) { engine.print(fmt.err('  ⟂ provider timed out after 5 min — try /model to switch')); return; }
      const r = race.value || {};
      if (r.reply) {
        // Sprint 2.1 — captioned reply matching the streaming layout.
        const _now = new Date();
        const _ts = String(_now.getHours()).padStart(2, '0') + ':'
                  + String(_now.getMinutes()).padStart(2, '0');
        engine.print(fmt.dim('  ────'));
        engine.print(fmt.cyan('⌁ ') + fmt.bold('horizon') + ' ' + fmt.dim('· ' + _ts));
        engine.print((state.markdown ? renderMarkdown(r.reply) : r.reply));
        state.history.push({ role: 'user', content: message });
        state.history.push({ role: 'assistant', content: r.reply });
      } else if (r.error) {
        engine.print(fmt.err(friendlyError(r.error)));
      }
      if (r.usage) engine.recordUsage(r.usage, { model: r.model });
    }
  } finally {
    engine.clearAbortHandler();
    engine.setSending(false);
  }
}

async function runAgent(runtime, state, engine, task) {
  const rail = new StepRail(engine, runtime);
  engine.setSending(true);
  rail.startThinking('⌁ planning…');

  // Same abort plumbing as runChat — Esc gives a soft cancel.
  const controller = new AbortController();
  let aborted = false;
  controller.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
  engine.setAbortHandler(() => {
    controller.abort('user-esc');
    rail.stop();
    engine.print(fmt.warn('  ⟂ interrupted'));
  });

  try {
    const work = runtime.runAgent(task, {
      signal: controller.signal,
      history: state.history,
      onStep: (event) => {
        switch (event.type) {
          case 'plan': if (event.plan?.steps) rail.showPlan(event.plan.steps); break;
          case 'executing': rail.executing(event.tool, event.args); break;
          case 'result':    rail.result(event.tool, event.ok, event.result); break;
          case 'reflection': rail.reflection(event.goalMet, event.confidence); break;
        }
      },
      askPermission: async ({ tool, args, reason }) => {
        const dangerous = /^(run_code|run_shell|run_python|write_file|delete_file|move_file|conn_.*_send|conn_.*_post|conn_.*_create|mouse_click|keyboard_type|smart_click)$/i.test(tool);
        if (!dangerous) return true;
        // Inline confirm via a simple prompt — pause engine, read line, resume.
        // The 60s timeout guards against the user walking away and locking the
        // TUI on a hung prompt; on timeout we conservatively deny the dangerous
        // action and resume.
        rail.stop();
        engine.pause();
        process.stdout.write(fmt.warn(`approve ${fmt.bold(tool)} ${fmt.dim(fmtArgs(args))} (${reason || 'agent step'}) y/N: `));
        let ans = '';
        try {
          ans = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('approval timed out')), 60_000);
            if (t.unref) t.unref();
            process.stdin.once('data', d => { clearTimeout(t); resolve(d.toString().trim()); });
            process.stdin.resume();
          });
        } catch (_) {
          process.stdout.write('\n');
          engine.print(fmt.warn('  ⟂ approval timed out — denying'));
        }
        engine.resume();
        rail.startThinking('⌁ thinking…');
        return /^(y|yes|д|да)/i.test(ans);
      },
    });
    const race = await _interruptibleRace(work, controller, () => aborted, PROVIDER_HARD_TIMEOUT_MS);
    rail.stop();
    if (race.aborted) return;
    if (race.timedOut) { engine.print(fmt.err('  ⟂ agent timed out after 5 min — partial run discarded')); return; }
    const r = race.value || {};
    if (r.answer) {
      // Sprint 2.1 — captioned final answer matching the streaming layout.
      const _now = new Date();
      const _ts = String(_now.getHours()).padStart(2, '0') + ':'
                + String(_now.getMinutes()).padStart(2, '0');
      engine.print('');
      engine.print(fmt.dim('  ────'));
      engine.print(fmt.cyan('⌁ ') + fmt.bold('horizon') + ' ' + fmt.dim('· ' + _ts));
      engine.print((state.markdown ? renderMarkdown(r.answer) : r.answer));
      state.history.push({ role: 'user', content: task });
      state.history.push({ role: 'assistant', content: r.answer });
    } else if (r.error) {
      engine.print(fmt.err(friendlyError(r.error)));
    }
  } finally {
    engine.clearAbortHandler();
    engine.setSending(false);
  }
}

module.exports = { main };

if (require.main === module) {
  main({ flags: {} });
}

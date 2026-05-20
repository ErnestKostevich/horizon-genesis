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
const { bannerBig, GradientSpinner, welcomeReveal } = require('./lib/banner');
const { TuiEngine } = require('./lib/tui-engine');
const { interactiveMenu } = require('./lib/menu');

const SLASH_LIST = ['/help','/quit','/clear','/reset','/skills','/skill','/skill-show',
                    '/persona','/persona-list','/model','/model-list','/mem','/agent',
                    '/chat','/stream','/markdown','/banner','/verbose','/find'];

function buildHelp() {
  return [
    '',
    fmt.bold('Slash commands'),
    '  /help                 show this list',
    '  /quit                 exit',
    '  /clear                clear screen',
    '  /reset                clear chat history (memory keeps everything)',
    '  /skills               list installed skills',
    '  /skill <id>           force-include a skill in the next turn',
    '  /skill-show <id>      print a skill\'s SKILL.md',
    '  /persona              show / switch persona (no arg or <id>)',
    '  /persona-list         list all personas',
    '  /model                show / switch provider (no arg or <id>)',
    '  /model-list           list all providers',
    '  /mem "query"          semantic memory search',
    '  /agent <task>         run the full agent loop (multi-step + tools)',
    '  /chat <message>       force single-turn chat',
    '  /stream on|off        toggle streaming',
    '  /markdown on|off      toggle markdown rendering',
    '  /find <query>         same as Ctrl+F',
    '',
    fmt.bold('Keyboard shortcuts'),
    '  Enter                 send message',
    '  Shift+Enter           newline (multi-line composer)',
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
    '  Ctrl+C / Ctrl+D       exit',
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
function buildGreeting(persona) {
  const h = new Date().getHours();
  let base;
  if (h >= 5  && h < 12) base = 'Good morning';
  else if (h >= 12 && h < 18) base = 'Good afternoon';
  else if (h >= 18 && h < 22) base = 'Good evening';
  else base = 'Working late';

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

function bannerHeader(rt) {
  const provider = rt.settingsStore.get('provider') || 'gemini';
  const persona = rt.settingsStore.get('persona') || 'jarvis';
  const memCount = rt.agentMemory?._data?.memories?.length || 0;
  const skillCount = rt.skillsManager?.list().length || 0;
  const lang = rt.settingsStore.get('lang') || 'en';

  // Sprint 2 — wordmark + vitals + greeting + hint line.
  const lines = [
    bannerBig(),
    '',
    `  ${fmt.dim('provider')} ${fmt.cyan(provider)}   ${fmt.dim('persona')} ${fmt.cyan(persona)}   ${fmt.dim('lang')} ${fmt.cyan(lang)}   ${fmt.dim('memory')} ${fmt.green(memCount + '')}   ${fmt.dim('skills')} ${fmt.green(skillCount + '')}   ${fmt.dim('workspace')} ${fmt.cyan(path.basename(rt.workspaceDir))}`,
    '  ' + fmt.dim(buildGreeting(persona)),
    fmt.dim('  Type /help · Tab complete · Shift+Enter newline · Ctrl+F search · /quit to exit'),
    '',
  ];
  return lines.join('\n');
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
  startThinking(text = 'thinking…') {
    if (this.spinner) this.spinner.stop();
    this.spinner = this._newSpinner(text, 'thinking');
  }
  showPlan(steps) {
    if (this.spinner) this.spinner.stop();
    this.engine.print('');
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
    this.spinner = this._newSpinner('thinking…', 'thinking');
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
  const runtime = createHorizonRuntime({
    userDataDir: flags?.['user-data-dir'],
    workspaceDir: flags?.workspace || process.cwd(),
    verbose: !!flags?.verbose,
  });

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

  // Print initial banner — write directly so it's part of the transcript too.
  const banner = bannerHeader(runtime);
  process.stdout.write((isFirstLaunch ? '' : '\x1b[2J\x1b[H') + banner);

  // v0.0.2 — explicit "you can type now" line so users don't sit at
  // a blank composer thinking it's broken. The v0.0.1 splash gave no
  // indication that the next thing to do was type a message.
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

  const state = {
    history: [],
    mode: 'chat',
    stream: true,
    markdown: true,
  };

  const engine = new TuiEngine({
    runtime,  // Fix 3 — engine reads provider/persona/cost/etc. for the status line
    completer: (line) => {
      if (!line.startsWith('/')) return [[], line];
      const hits = SLASH_LIST.filter(c => c.startsWith(line));
      return [hits, line];
    },
    onLine: async (raw) => {
      const line = raw.trim();
      if (!line) return;
      // Echo user line into transcript
      engine.print(fmt.cyan('› ') + line);
      try {
        if (line.startsWith('/')) await handleSlash(line, state, runtime, engine);
        else await runOne(runtime, state, engine, line);
      } catch (e) {
        engine.print(fmt.red('error: ' + e.message));
      }
    },
  });

  // Seed transcript with the banner so search/scroll see it
  banner.split('\n').forEach(l => engine.transcript.push(l));

  engine.start();
}

async function handleSlash(raw, state, runtime, engine) {
  const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const head = tokens[0];
  const rest = tokens.slice(1).map(t => t.replace(/^"|"$/g, ''));

  if (head === '/quit' || head === '/exit') { engine.close(); process.exit(0); return; }
  if (head === '/help') { engine.print(buildHelp()); return; }
  if (head === '/clear') {
    process.stdout.write('\x1b[2J\x1b[H');
    engine.transcript = [];
    return;
  }
  if (head === '/banner') {
    engine.print(bannerHeader(runtime));
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
    const list = runtime.skillsManager?.list() || [];
    if (!list.length) { engine.print(fmt.dim('no skills installed')); return; }
    const picked = await interactiveMenu({
      engine,
      title: `Skills (${list.length})`,
      items: list.map((s) => ({
        label: s.id,
        sublabel: fmt.dim(s.description || s.scope || ''),
        value: s,
      })),
      footer: '↑/↓ move · Enter show SKILL.md · Esc cancel',
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
    const picked = await interactiveMenu({
      engine,
      title: 'Pick a persona',
      initial: Math.max(0, list.findIndex((p) => p.id === active)),
      items: list.map((p) => ({
        label: p.id + (p.id === active ? '  (active)' : ''),
        sublabel: fmt.dim(p.tagline || p.description || ''),
        value: p,
      })),
      footer: '↑/↓ move · Enter activate · Esc cancel',
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
    const { DEFAULT_PROVIDER_MODELS } = require('../src/main/runtime/ai-providers');
    const active = runtime.settingsStore.get('provider') || 'gemini';
    const entries = Object.entries(DEFAULT_PROVIDER_MODELS);
    const items = entries.map(([p, m]) => {
      const isLocal = ['ollama','lmstudio','localai'].includes(p);
      const has = isLocal ? '—' : (runtime.keysStore.get('k_' + p) ? '✓' : '·');
      return {
        label: `${has}  ${p}${p === active ? '  (active)' : ''}`,
        sublabel: fmt.dim(m),
        value: { id: p, model: m },
      };
    });
    const picked = await interactiveMenu({
      engine,
      title: `Providers (${entries.length})`,
      initial: Math.max(0, entries.findIndex(([p]) => p === active)),
      items,
      footer: '↑/↓ move · Enter switch · Esc cancel · ✓ = key set',
    });
    if (!picked) { engine.print(fmt.dim('cancelled')); return; }
    runtime.settingsStore.set('provider', picked.id);
    engine.print(fmt.ok('provider → ' + fmt.cyan(picked.id) + fmt.dim(' (' + picked.model + ')')));
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
  engine.print(fmt.err('unknown slash command: ' + head));
}

async function runOne(runtime, state, engine, message, modeOverride) {
  const mode = modeOverride || state.mode;
  if (mode === 'agent') await runAgent(runtime, state, engine, message);
  else                  await runChat(runtime, state, engine, message);
}

async function runChat(runtime, state, engine, message) {
  engine.setSending(true);
  engine.print('');

  try {
    if (state.stream) {
      // Sprint 2 — buffer the stream, then re-render markdown every ~120ms
      // by REPLACING the assistant message tail in transcript. This avoids
      // the old double-render ("raw tokens then —— rendered ——" block) and
      // gives a smooth live-rendered reply. Falls back to plain passthrough
      // when /markdown is off.
      const useMarkdown = state.markdown !== false;
      engine.startStreamingMessage(fmt.bold('Horizon: '));
      let buf = '';
      let lastRender = 0;
      const r = await runtime.runChatStream(message, { history: state.history }, (chunk) => {
        buf += chunk;
        const now = Date.now();
        if (now - lastRender >= 120) {
          engine.updateStreamingMessage(buf, { markdown: useMarkdown });
          lastRender = now;
        }
      });
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
      const r = await runtime.runChat(message, { history: state.history });
      if (r.reply) {
        engine.print(fmt.bold('Horizon: ') + (state.markdown ? renderMarkdown(r.reply) : r.reply));
        state.history.push({ role: 'user', content: message });
        state.history.push({ role: 'assistant', content: r.reply });
      } else if (r.error) {
        engine.print(fmt.err(friendlyError(r.error)));
      }
      if (r.usage) engine.recordUsage(r.usage, { model: r.model });
    }
  } finally {
    engine.setSending(false);
  }
}

async function runAgent(runtime, state, engine, task) {
  const rail = new StepRail(engine, runtime);
  engine.setSending(true);
  rail.startThinking('planning…');
  try {
    const r = await runtime.runAgent(task, {
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
        // Inline confirm via a simple prompt — pause engine, read line, resume
        rail.stop();
        engine.pause();
        process.stdout.write(fmt.warn(`approve ${fmt.bold(tool)} ${fmt.dim(fmtArgs(args))} (${reason || 'agent step'}) y/N: `));
        const ans = await new Promise(resolve => {
          process.stdin.once('data', d => resolve(d.toString().trim()));
          process.stdin.resume();
        });
        engine.resume();
        rail.startThinking('thinking…');
        return /^(y|yes|д|да)/i.test(ans);
      },
    });
    rail.stop();
    if (r.answer) {
      engine.print('');
      engine.print(fmt.bold('Horizon: ') + (state.markdown ? renderMarkdown(r.answer) : r.answer));
      state.history.push({ role: 'user', content: task });
      state.history.push({ role: 'assistant', content: r.answer });
    } else if (r.error) {
      engine.print(fmt.err(friendlyError(r.error)));
    }
  } finally {
    engine.setSending(false);
  }
}

module.exports = { main };

if (require.main === module) {
  main({ flags: {} });
}

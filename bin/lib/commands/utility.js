// Phase 12 — utility subcommands.
//
// Small single-purpose verbs bundled here because each is < 30 LOC
// and they share helpers.
//
// Commands:
//   notes list | add "..." | show <id> | rm <id>
//   timer <minutes> [--break N] [--name X]      pomodoro w/ desktop bell
//   stats [--days N]                            global usage at a glance
//   clip                                        analyze clipboard contents (text)
//   env list | set KEY=VAL | unset KEY          per-workspace env overlay
//   open <url|path>                             OS-native opener (xdg/start/open)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { fmt, promptYesNo } = require('../tty');
const { panel } = require('../banner');

// Eighths-block bar palette. Same one as cost.js / insights.js — keeps
// every bar chart across the CLI visually consistent.
const _BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
function _eighthsBar(value, max, width, color = fmt.cyan) {
  if (max <= 0) return fmt.dim('·' + ' '.repeat(width - 1));
  const sub = Math.round((value / max) * width * 8);
  if (sub === 0) return fmt.dim('·' + ' '.repeat(width - 1));
  const full = Math.floor(sub / 8);
  const rem = sub % 8;
  return color('█'.repeat(full) + (rem > 0 ? _BLOCKS[rem] : ''))
       + ' '.repeat(Math.max(0, width - full - (rem > 0 ? 1 : 0)));
}

// ── helpers ────────────────────────────────────────────────────────────
function notesPath(userDataDir) { return path.join(userDataDir, 'notes.jsonl'); }
function loadNotes(userDataDir) {
  const p = notesPath(userDataDir);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
function saveNotes(userDataDir, notes) {
  fs.writeFileSync(notesPath(userDataDir), notes.map(n => JSON.stringify(n)).join('\n') + (notes.length ? '\n' : ''), 'utf8');
}

// ── notes ──────────────────────────────────────────────────────────────
const HANDLERS = {

  async notes({ runtime, args, flags }) {
    const sub = args[0] || 'list';
    const rest = args.slice(1);
    if (sub === 'list') {
      const notes = loadNotes(runtime.userDataDir);
      if (flags.json) { process.stdout.write(JSON.stringify(notes, null, 2) + '\n'); return 0; }
      if (!notes.length) { process.stdout.write(fmt.dim('\n  no notes · `horizon notes add "buy milk"`\n\n')); return 0; }
      for (const n of notes.slice(-50)) {
        process.stdout.write(`  ${fmt.cyan(n.id)}  ${fmt.dim(n.at.slice(0, 16))}  ${n.text}\n`);
      }
      return 0;
    }
    if (sub === 'add') {
      const text = rest.join(' ').trim();
      if (!text) { process.stderr.write(fmt.err('text required') + '\n'); return 2; }
      const notes = loadNotes(runtime.userDataDir);
      const note = { id: 'note-' + crypto.randomBytes(3).toString('hex'), at: new Date().toISOString(), text };
      notes.push(note);
      saveNotes(runtime.userDataDir, notes);
      process.stdout.write(fmt.ok(note.id) + '\n');
      return 0;
    }
    if (sub === 'show') {
      const id = rest[0];
      const notes = loadNotes(runtime.userDataDir);
      const n = notes.find(x => x.id === id);
      if (!n) { process.stderr.write(fmt.err('not found') + '\n'); return 1; }
      process.stdout.write(`${fmt.dim(n.at)}\n${n.text}\n`);
      return 0;
    }
    if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
      const id = rest[0];
      const notes = loadNotes(runtime.userDataDir);
      const filtered = notes.filter(x => x.id !== id);
      if (filtered.length === notes.length) { process.stderr.write(fmt.err('not found') + '\n'); return 1; }
      saveNotes(runtime.userDataDir, filtered);
      process.stdout.write(fmt.ok('removed ' + id) + '\n');
      return 0;
    }
    process.stderr.write(fmt.err('Usage: horizon notes list|add|show|rm') + '\n');
    return 2;
  },

  async timer({ runtime, args, flags }) {
    const mins = Number(args[0]);
    if (!mins || mins < 1 || mins > 240) {
      process.stderr.write(fmt.err('Usage: horizon timer <minutes 1-240> [--name X]') + '\n');
      return 2;
    }
    const name = flags.name || 'pomodoro';
    const started = Date.now();
    const endsAt = started + mins * 60_000;
    process.stdout.write(fmt.ok(`⏱  ${name} · ${mins} min · ends ${new Date(endsAt).toLocaleTimeString()}`) + '\n');
    // Tick every second updating a one-line progress
    return new Promise(resolve => {
      const total = mins * 60;
      const tick = setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        if (elapsed >= total) {
          clearInterval(tick);
          process.stdout.write('\r\x1b[K' + fmt.green('● done — ') + fmt.bold(name) + ' ✓\n');
          // Audible bell + system notification best-effort
          process.stdout.write('\x07');
          if (process.platform === 'darwin') {
            spawn('osascript', ['-e', `display notification "${name} complete" with title "Horizon Timer"`], { stdio: 'ignore', detached: true }).unref();
          } else if (process.platform === 'linux') {
            spawn('notify-send', ['Horizon Timer', `${name} complete`], { stdio: 'ignore', detached: true }).unref();
          }
          resolve(0);
          return;
        }
        const remaining = total - elapsed;
        // Eighths-block timer bar — every second moves a sub-cell so the
        // progress feels smooth even on short timers.
        const bar = _eighthsBar(elapsed, total, 30, fmt.cyan);
        const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
        const ss = String(remaining % 60).padStart(2, '0');
        process.stdout.write(`\r\x1b[K  ${bar}  ${fmt.bold(mm + ':' + ss)} ${fmt.dim('remaining')}`);
      }, 1000);
    });
  },

  async stats({ runtime, args, flags }) {
    const days = Number(flags.days || 30);
    const cost = runtime.costTracker?.summary?.({ days }) || null;
    const mem = runtime.agentMemory?._data || {};
    const skills = runtime.skillsManager?.list() || [];
    const crons = runtime.settingsStore.get('cli.cron') || [];
    const data = {
      window: { days },
      memory: {
        memories: mem.memories?.length || 0,
        facts: Object.keys(mem.facts || {}).length,
        conversations: mem.conversations?.length || 0,
      },
      skills: skills.length,
      enabledCrons: crons.filter(c => c.enabled).length,
      cost: cost?.totals || { calls: 0, tokens: 0, costUsd: 0 },
      topModels: cost ? Object.entries(cost.byModel || {}).sort((a,b)=>b[1].tokens-a[1].tokens).slice(0,3) : [],
    };
    if (flags.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return 0; }
    // Sprint-2.15 — panel-framed stats + eighths-block model chart.
    process.stdout.write('\n  ' + fmt.bold('Horizon stats') + fmt.dim(` · ${days}d`) + '\n\n');
    process.stdout.write(panel({
      title: 'Snapshot',
      accent: 'cyan',
      width: 72,
      lines: [
        fmt.dim('memory     ') + ' ' + fmt.green(data.memory.memories + '') + fmt.dim(' memories · ') + fmt.green(data.memory.facts + '') + fmt.dim(' facts · ') + fmt.green(data.memory.conversations + '') + fmt.dim(' conversations'),
        fmt.dim('skills     ') + ' ' + fmt.cyan(data.skills + '') + fmt.dim(' loaded · ') + fmt.cyan(data.enabledCrons + '') + fmt.dim(' cron entries enabled'),
        fmt.dim('cost       ') + ' ' + fmt.cyan(data.cost.calls + '') + fmt.dim(' calls · ') + fmt.cyan((data.cost.tokens || 0).toLocaleString()) + fmt.dim(' tokens · ') + fmt.green('$' + (data.cost.costUsd || 0).toFixed(4)),
      ],
    }) + '\n\n');
    if (data.topModels.length) {
      const maxTokens = Math.max(1, ...data.topModels.map(([, v]) => v.tokens));
      const modelLines = data.topModels.map(([m, v]) =>
        fmt.cyan(m.padEnd(36)) + ' ' +
        _eighthsBar(v.tokens, maxTokens, 18) + ' ' +
        fmt.dim(v.calls + ' calls · ') + fmt.green(v.tokens.toLocaleString() + ' tokens')
      );
      process.stdout.write(panel({
        title: 'Top models',
        accent: 'magenta',
        width: 90,
        lines: modelLines,
      }) + '\n\n');
    }
    return 0;
  },

  async clip({ runtime, args, flags }) {
    // Read OS clipboard. No native deps — use platform commands.
    let content = '';
    try {
      if (process.platform === 'darwin') {
        content = await runCmd('pbpaste', []);
      } else if (process.platform === 'win32') {
        content = await runCmd('powershell', ['-NoProfile', '-Command', 'Get-Clipboard']);
      } else {
        // Linux: prefer xclip, fallback xsel, fallback wl-paste
        try { content = await runCmd('xclip', ['-selection', 'clipboard', '-o']); }
        catch (_) {
          try { content = await runCmd('xsel', ['--clipboard', '--output']); }
          catch (__) { content = await runCmd('wl-paste', []); }
        }
      }
    } catch (e) {
      process.stderr.write(fmt.err('clipboard read failed: ' + e.message) + '\n');
      return 1;
    }
    content = String(content).trim();
    if (!content) { process.stdout.write(fmt.dim('clipboard empty\n')); return 0; }
    const action = args[0] || 'analyze';
    if (action === 'show')  { process.stdout.write(content + '\n'); return 0; }
    if (action === 'length' || action === 'len') { process.stdout.write(content.length + '\n'); return 0; }
    // Default: analyze with AI
    const r = await runtime.runChat(
      `Analyse this clipboard content. If it's code → identify language + summarise. If text → summarise in 2 sentences. If URL → describe what it links to. Be terse.\n\n${content.slice(0, 4000)}`,
      { skipLearn: true }
    );
    if (r.error) { process.stderr.write(fmt.err(r.error) + '\n'); return 1; }
    process.stdout.write(r.reply + '\n');
    return 0;
  },

  async env({ runtime, args, flags }) {
    const sub = args[0] || 'list';
    const rest = args.slice(1);
    const all = runtime.settingsStore.get('cli.env') || {};
    if (sub === 'list') {
      if (flags.json) { process.stdout.write(JSON.stringify(all, null, 2) + '\n'); return 0; }
      if (!Object.keys(all).length) { process.stdout.write(fmt.dim('\n  no env overrides\n\n')); return 0; }
      for (const [k, v] of Object.entries(all)) {
        process.stdout.write(`  ${fmt.cyan(k.padEnd(24))} ${fmt.dim(String(v))}\n`);
      }
      return 0;
    }
    if (sub === 'set') {
      const pair = rest[0];
      if (!pair || !pair.includes('=')) { process.stderr.write(fmt.err('Usage: horizon env set KEY=VAL') + '\n'); return 2; }
      const [k, ...vparts] = pair.split('=');
      all[k] = vparts.join('=');
      runtime.settingsStore.set('cli.env', all);
      process.stdout.write(fmt.ok(`${k} set`) + '\n');
      return 0;
    }
    if (sub === 'unset' || sub === 'rm') {
      const k = rest[0];
      if (!k) { process.stderr.write(fmt.err('key required') + '\n'); return 2; }
      delete all[k];
      runtime.settingsStore.set('cli.env', all);
      process.stdout.write(fmt.ok(`${k} unset`) + '\n');
      return 0;
    }
    process.stderr.write(fmt.err('Usage: horizon env list|set|unset') + '\n');
    return 2;
  },

  async open({ runtime, args, flags }) {
    const target = args[0];
    if (!target) { process.stderr.write(fmt.err('Usage: horizon open <url-or-path>') + '\n'); return 2; }
    let cmd, cmdArgs;
    if (process.platform === 'darwin') { cmd = 'open'; cmdArgs = [target]; }
    else if (process.platform === 'win32') { cmd = 'cmd'; cmdArgs = ['/c', 'start', '""', target]; }
    else { cmd = 'xdg-open'; cmdArgs = [target]; }
    try {
      spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
      process.stdout.write(fmt.ok('opened ' + target) + '\n');
      return 0;
    } catch (e) {
      process.stderr.write(fmt.err(e.message) + '\n');
      return 1;
    }
  },
};

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    child.stdout?.on('data', d => out += d);
    child.on('error', reject);
    child.on('exit', () => resolve(out));
  });
}

async function run({ runtime, args, flags, _subcommand }) {
  const h = HANDLERS[_subcommand];
  if (!h) {
    process.stderr.write(fmt.err('Unknown utility: ' + _subcommand) + '\n');
    return 2;
  }
  return h({ runtime, args, flags });
}

module.exports = { run, HANDLERS };

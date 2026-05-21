// `horizon macro <subcommand>` — record, list, play, show, delete saved macros.
//
// Subcommands:
//   horizon macro record <name>          — interactive: "perform actions, Ctrl+C to stop"
//   horizon macro list                   — list saved macros
//   horizon macro play <name> [flags]    — replay
//                                          --speed <n>    (default 1.0)
//                                          --repeat <n>   (default 1)
//                                          --dry-run      (don't fire native actions)
//   horizon macro show <name>            — pretty-print event timeline
//   horizon macro delete <name>          — delete saved macro
//
// Sprint 7D. CLI uses the same MacroRecorder + saveMacro/loadMacro
// helpers the Electron app calls, so files created via the GUI play
// back here and vice-versa.

const path = require('path');
const { fmt } = require('../tty');

function _macroModule() {
  return require(path.join(__dirname, '..', '..', '..', 'src', 'main', 'macroRecorder'));
}

function _resolveUserDataDir(runtime, flags) {
  // The runtime created by createHorizonRuntime exposes userDataDir;
  // fall back to the shim's default if not present (older snapshots).
  if (runtime?.userDataDir) return runtime.userDataDir;
  const { defaultUserDataDir } = require(path.join(__dirname, '..', '..', '..', 'src', 'main', 'runtime', 'store-shim'));
  return defaultUserDataDir();
}

async function run({ runtime, args, flags }) {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === 'list') return list(runtime, flags);
  if (sub === 'record')        return record(runtime, rest, flags);
  if (sub === 'play')          return play(runtime, rest, flags);
  if (sub === 'show')          return show(runtime, rest, flags);
  if (sub === 'delete' || sub === 'rm') return remove(runtime, rest, flags);

  process.stderr.write(fmt.err(`Unknown macro subcommand: ${sub}`) + '\n');
  process.stderr.write('Try: list | record | play | show | delete\n');
  return 2;
}

function list(runtime, flags) {
  const M = _macroModule();
  const dir = _resolveUserDataDir(runtime, flags);
  const macros = M.listMacros(dir);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, macros }, null, 2) + '\n');
    return 0;
  }
  if (!macros.length) {
    process.stdout.write(fmt.dim('No saved macros. Create one with `horizon macro record <name>`.') + '\n');
    return 0;
  }
  process.stdout.write(fmt.bold(`Saved macros (${macros.length}):`) + '\n');
  for (const m of macros) {
    const last = m.lastPlayedAt ? new Date(m.lastPlayedAt).toLocaleString() : 'never';
    process.stdout.write(
      `  ${fmt.cyan(m.name.padEnd(28))} ` +
      `${fmt.dim((m.events + ' events').padEnd(14))} ` +
      `${fmt.dim((Math.round(m.duration / 100) / 10 + 's').padEnd(8))} ` +
      `${fmt.dim('last: ' + last)}\n`
    );
  }
  return 0;
}

async function record(runtime, rest, flags) {
  const name = (rest[0] || '').trim();
  if (!name) {
    process.stderr.write(fmt.err('Need a macro name: horizon macro record <name>') + '\n');
    return 2;
  }
  const M = _macroModule();
  const dir = _resolveUserDataDir(runtime, flags);

  // Wire mouseMove poll-based recording: CLI can't hook keyboard reliably
  // without the optional uiohook-napi dep, but the polling fallback still
  // captures cursor motion which is useful for "demo this trail" workflows.
  let getMousePos = null;
  try {
    const { exec } = require('child_process');
    const IS_WIN = process.platform === 'win32';
    const IS_MAC = process.platform === 'darwin';
    getMousePos = () => new Promise(resolve => {
      let cmd;
      if (IS_WIN) cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output ($p.X.ToString()+','+$p.Y.ToString())"`;
      else if (IS_MAC) cmd = `osascript -e 'tell application "System Events" to position of mouse'`;
      else cmd = `xdotool getmouselocation --shell 2>/dev/null | awk -F= '/^X=/{x=$2} /^Y=/{y=$2} END{printf "%s,%s",x,y}'`;
      exec(cmd, { timeout: 1000 }, (err, out) => {
        if (err) return resolve(null);
        const [x, y] = String(out || '').trim().split(',').map(Number);
        if (Number.isFinite(x) && Number.isFinite(y)) resolve({ x, y });
        else resolve(null);
      });
    });
  } catch (_) { /* leave getMousePos null */ }

  const recorder = new M.MacroRecorder({ userDataDir: dir, getMousePos });
  const r = recorder.start(name);
  if (!r.ok) {
    process.stderr.write(fmt.err(r.error) + '\n');
    return 1;
  }
  process.stdout.write(`\n${fmt.bold('Recording')} "${fmt.cyan(name)}" — mode: ${fmt.dim(r.mode)}\n`);
  if (r.warning) process.stdout.write(fmt.dim('  ' + r.warning) + '\n');
  process.stdout.write(fmt.dim('  Perform your actions now. Press Ctrl+C to stop.\n\n'));

  return await new Promise((resolve) => {
    const onSig = () => {
      process.stdout.write('\n');
      const s = recorder.stop();
      if (!s.ok) {
        process.stderr.write(fmt.err(s.error) + '\n');
        resolve(1);
        return;
      }
      const macro = s.macro || {};
      process.stdout.write(fmt.bold('Saved ') + fmt.cyan(macro.name) + fmt.dim(` (${macro.events?.length || 0} events, ${Math.round((macro.duration || 0)/100)/10}s)`) + '\n');
      process.stdout.write(fmt.dim('  ' + s.path) + '\n');
      resolve(0);
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });
}

async function play(runtime, rest, flags) {
  const name = (rest[0] || '').trim();
  if (!name) {
    process.stderr.write(fmt.err('Need a macro name: horizon macro play <name>') + '\n');
    return 2;
  }
  const M = _macroModule();
  const dir = _resolveUserDataDir(runtime, flags);
  const r = M.loadMacro(dir, name);
  if (!r.ok) {
    process.stderr.write(fmt.err(r.error) + '\n');
    return 1;
  }
  const speed = Number(flags.speed) > 0 ? Number(flags.speed) : 1.0;
  const repeat = Math.max(1, Number(flags.repeat) || 1);
  const dryRun = !!flags['dry-run'];

  // The CLI doesn't load agent.js (heavy) unless we need it; load lazily.
  let agentTools = null;
  if (!dryRun) {
    try { agentTools = require(path.join(__dirname, '..', '..', '..', 'src', 'main', 'agent')); }
    catch (e) {
      process.stderr.write(fmt.err('Could not load native automation tools: ' + e.message) + '\n');
      return 1;
    }
  }
  const recorder = new M.MacroRecorder({ userDataDir: dir, agentTools });
  process.stdout.write(`Playing ${fmt.cyan(name)} ${fmt.dim(`speed=${speed} repeat=${repeat}${dryRun ? ' dry-run' : ''}`)}\n`);
  const result = await recorder.play(r.macro, { speed, repeat, dryRun });
  if (!result.ok) {
    process.stderr.write(fmt.err(result.error || 'Playback failed') + '\n');
    return 1;
  }
  process.stdout.write(fmt.bold('OK ') + fmt.dim(`fired ${result.fired.length} events`) + '\n');
  return 0;
}

function show(runtime, rest, flags) {
  const name = (rest[0] || '').trim();
  if (!name) {
    process.stderr.write(fmt.err('Need a macro name: horizon macro show <name>') + '\n');
    return 2;
  }
  const M = _macroModule();
  const dir = _resolveUserDataDir(runtime, flags);
  const r = M.loadMacro(dir, name);
  if (!r.ok) {
    process.stderr.write(fmt.err(r.error) + '\n');
    return 1;
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(r.macro, null, 2) + '\n');
    return 0;
  }
  const m = r.macro;
  process.stdout.write(fmt.bold(m.name) + fmt.dim(`  v${m.version}  ${m.events.length} events  ${Math.round(m.duration/100)/10}s\n`));
  for (const ev of m.events) {
    let desc = ev.type;
    if (ev.type === 'mouse_move' || ev.type === 'mouse_click' || ev.type === 'mouse_double_click') desc += ` (${ev.x},${ev.y})`;
    if (ev.type === 'mouse_click') desc += ` ${ev.button || 'left'}`;
    if (ev.type === 'type') desc += ` "${(ev.text || '').slice(0, 60)}"`;
    if (ev.type === 'key') desc += ` ${ev.key}`;
    process.stdout.write(`  ${fmt.dim((ev.t + 'ms').padStart(8))}  ${desc}\n`);
  }
  return 0;
}

function remove(runtime, rest, flags) {
  const name = (rest[0] || '').trim();
  if (!name) {
    process.stderr.write(fmt.err('Need a macro name: horizon macro delete <name>') + '\n');
    return 2;
  }
  const M = _macroModule();
  const dir = _resolveUserDataDir(runtime, flags);
  const r = M.deleteMacro(dir, name);
  if (!r.ok) {
    process.stderr.write(fmt.err(r.error) + '\n');
    return 1;
  }
  process.stdout.write(fmt.bold('Deleted ') + fmt.cyan(name) + '\n');
  return 0;
}

module.exports = { run };

// `horizon canvas` — view + edit the Live Canvas shared surface that
// the agent and you both write to. Persists at
// <userData>/horizon-canvas.json. Electron app shows a live panel; this
// CLI is for shell-only users or scripted appends.
//
// Subcommands:
//   horizon canvas                     — show current content
//   horizon canvas show                — same as above
//   horizon canvas append "text"       — add to the end
//   horizon canvas prepend "text"      — add to the top
//   horizon canvas replace "text"      — overwrite
//   horizon canvas clear               — empty it (with confirm)
//   horizon canvas path                — print the file path

const fs = require('fs');
const path = require('path');
const { fmt } = require('../tty');

function _canvasPath(runtime) {
  return path.join(runtime.userDataDir, 'horizon-canvas.json');
}

function _load(runtime) {
  const p = _canvasPath(runtime);
  if (!fs.existsSync(p)) return { content: '', version: 0, updatedAt: null };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { content: String(data.content || ''), version: data.version || 0, updatedAt: data.updatedAt || null };
  } catch (e) {
    return { content: '', version: 0, updatedAt: null, error: e.message };
  }
}

function _save(runtime, content, source = 'cli') {
  const p = _canvasPath(runtime);
  const prev = _load(runtime);
  const next = {
    content: String(content || ''),
    version: (prev.version || 0) + 1,
    updatedAt: new Date().toISOString(),
    source,
  };
  // Atomic write: tmp + rename to avoid partial files on crash.
  const tmp = p + '.tmp';
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, p);
  return next;
}

async function run({ runtime, args, flags }) {
  const sub = args[0] || 'show';
  const rest = args.slice(1).join(' ');
  if (sub === 'show' || sub === 'view' || sub === 'cat') return show(runtime, flags);
  if (sub === 'append')  return write(runtime, rest, 'append', flags);
  if (sub === 'prepend') return write(runtime, rest, 'prepend', flags);
  if (sub === 'replace') return write(runtime, rest, 'replace', flags);
  if (sub === 'clear')   return clear(runtime, flags);
  if (sub === 'path')    { process.stdout.write(_canvasPath(runtime) + '\n'); return 0; }

  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write('Try: show | append | prepend | replace | clear | path\n');
  return 2;
}

function show(runtime, flags) {
  const c = _load(runtime);
  if (flags.json) { process.stdout.write(JSON.stringify(c, null, 2) + '\n'); return 0; }
  if (!c.content) {
    process.stdout.write(fmt.dim('Canvas is empty. Try: horizon canvas append "your text"\n'));
    return 0;
  }
  process.stdout.write(c.content);
  if (!c.content.endsWith('\n')) process.stdout.write('\n');
  process.stdout.write(fmt.dim(`\n— ${c.content.length} chars, v${c.version}, updated ${c.updatedAt || 'unknown'}`) + '\n');
  return 0;
}

function write(runtime, text, mode, flags) {
  if (!text) {
    process.stderr.write(fmt.err('Need text: horizon canvas ' + mode + ' "your text"') + '\n');
    return 2;
  }
  const prev = _load(runtime);
  let next;
  if (mode === 'append')       next = (prev.content ? prev.content + '\n' : '') + text;
  else if (mode === 'prepend') next = text + (prev.content ? '\n' + prev.content : '');
  else                          next = text;
  // 1 MB cap to match CanvasManager runtime guard.
  if (next.length > 1_048_576) {
    process.stderr.write(fmt.err('Canvas would exceed 1 MB cap — trim before writing.') + '\n');
    return 1;
  }
  const saved = _save(runtime, next, 'cli');
  if (flags.json) { process.stdout.write(JSON.stringify(saved, null, 2) + '\n'); return 0; }
  process.stdout.write(fmt.ok(`✓ Canvas ${mode}ed (${text.length} chars, total ${saved.content.length}, v${saved.version}).`) + '\n');
  return 0;
}

function clear(runtime, flags) {
  if (!flags.force && !flags.json) {
    process.stdout.write(fmt.dim('Use --force to confirm clearing the canvas.') + '\n');
    return 0;
  }
  const saved = _save(runtime, '', 'cli');
  if (flags.json) { process.stdout.write(JSON.stringify(saved, null, 2) + '\n'); return 0; }
  process.stdout.write(fmt.ok('✓ Canvas cleared.') + '\n');
  return 0;
}

module.exports = { run };

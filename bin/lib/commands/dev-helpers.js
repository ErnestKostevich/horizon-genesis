// Phase 13 — 7 developer-flavoured subcommands.
//
// git    AI-assisted git operations (commit messages, log search, review)
// shell  interactive AI-augmented shell (read-eval-print with safety)
// web    web search via Tavily or Perplexity (whichever key is set)
// image  image generation (DALL-E / Gemini Imagen) with auto-save
// screen capture or read the screen from the desktop runtime
// todo   completion-tracking todo list (separate from notes)
// explain-error  paste a stack trace, get a human-readable explanation

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const { fmt, promptYesNo } = require('../tty');
const { renderMarkdown } = require('../markdown');
const { GradientSpinner } = require('../banner');

function quickChat(runtime, system, user, flags = {}) {
  const spinner = !flags.json && !flags.quiet && process.stdout.isTTY
    ? new GradientSpinner('thinking…').start() : null;
  return runtime.runChat(user, { system, provider: flags.provider, model: flags.model })
    .then(r => {
      if (spinner) spinner.stop();
      return r;
    });
}

function printChat(r, flags) {
  if (r.error) { process.stderr.write(fmt.err(r.error) + '\n'); return 1; }
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, reply: r.reply, model: r.model, usage: r.usage }) + '\n');
    return 0;
  }
  const out = (flags.plain || flags.quiet) ? r.reply : renderMarkdown(r.reply);
  process.stdout.write(out + '\n');
  if (!flags.quiet && r.usage) process.stderr.write(fmt.dim(`(${r.model}, ${r.usage.total} tokens)`) + '\n');
  return 0;
}

// ── helpers ────────────────────────────────────────────────────────────
function todosPath(userDataDir) { return path.join(userDataDir, 'todos.json'); }
function loadTodos(userDataDir) {
  const p = todosPath(userDataDir);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return []; }
}
function saveTodos(userDataDir, todos) {
  fs.writeFileSync(todosPath(userDataDir), JSON.stringify(todos, null, 2), 'utf8');
}

const HANDLERS = {

  // ── git ─────────────────────────────────────────────────────────────
  async git({ runtime, args, flags }) {
    const sub = args[0] || 'help';
    const rest = args.slice(1);
    const workspace = runtime.workspaceDir;

    function gitOutput(cmd) {
      try { return execSync('git ' + cmd, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
      catch (e) { return null; }
    }

    if (sub === 'commit') {
      const diff = gitOutput('diff --staged');
      if (!diff) {
        process.stderr.write(fmt.err('No staged changes — run `git add` first') + '\n');
        return 1;
      }
      const r = await quickChat(runtime,
        'You write commit messages following Conventional Commits. Output: one subject line (under 72 chars) and an optional body (no more than 5 lines). Subject starts with feat: / fix: / docs: / refactor: / chore: as appropriate. No filler.',
        `Generate a commit message for this staged diff:\n\n${diff.slice(0, 8000)}`,
        { ...flags, quiet: true });
      if (r.error) { process.stderr.write(fmt.err(r.error) + '\n'); return 1; }
      const msg = r.reply.trim();
      process.stdout.write('\n' + fmt.bold('Proposed commit message:') + '\n\n');
      process.stdout.write(msg + '\n\n');
      if (flags.yes || !process.stdin.isTTY) {
        execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd: workspace, stdio: 'inherit' });
        return 0;
      }
      const ok = await promptYesNo(fmt.cyan('  use this message? Y/n:'));
      if (ok || flags.yes) {
        execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd: workspace, stdio: 'inherit' });
      } else {
        process.stdout.write(fmt.dim('cancelled — copy/edit the message yourself\n'));
      }
      return 0;
    }

    if (sub === 'review') {
      const target = rest[0]; // file path or commit ref
      let diff;
      if (target && /^[a-f0-9]{4,40}$/.test(target)) {
        diff = gitOutput(`show ${target}`);
      } else if (target) {
        diff = gitOutput(`diff -- ${JSON.stringify(target)}`);
      } else {
        diff = gitOutput('diff HEAD');
      }
      if (!diff) {
        process.stderr.write(fmt.err('Nothing to review (no diff vs HEAD or invalid target)') + '\n');
        return 1;
      }
      const r = await quickChat(runtime,
        'You are a senior engineer doing code review on a git diff. Output: 1) bugs (HIGH), 2) security issues (HIGH), 3) tests/edge cases worth adding (MEDIUM), 4) nit picks (LOW). Reference file paths and approximate line numbers from the diff. Skip empty praise.',
        `Review this diff:\n\n${diff.slice(0, 12000)}`,
        flags);
      return printChat(r, flags);
    }

    if (sub === 'log') {
      const query = rest.join(' ').trim();
      if (!query) {
        // Default: explain the last 10 commits
        const log = gitOutput('log --oneline -n 10');
        if (!log) { process.stderr.write(fmt.err('Not a git repo') + '\n'); return 1; }
        process.stdout.write(log);
        return 0;
      }
      // Semantic search through git log
      const log = gitOutput(`log --pretty='%h %s — %an, %ad' --date=short -n 200`);
      if (!log) { process.stderr.write(fmt.err('Not a git repo or empty history') + '\n'); return 1; }
      const r = await quickChat(runtime,
        'You search a git log. Return the 5 most relevant commits as a markdown list with `hash subject (author, date)`. No prose around.',
        `Find commits relevant to "${query}":\n\n${log}`,
        flags);
      return printChat(r, flags);
    }

    if (sub === 'blame') {
      const file = rest[0];
      if (!file) { process.stderr.write(fmt.err('Usage: horizon git blame <file>') + '\n'); return 2; }
      try {
        const out = execSync(`git blame --line-porcelain ${JSON.stringify(file)}`, { cwd: workspace }).toString();
        // Aggregate by author
        const authors = {};
        for (const line of out.split('\n')) {
          const m = line.match(/^author (.+)$/);
          if (m) authors[m[1]] = (authors[m[1]] || 0) + 1;
        }
        const total = Object.values(authors).reduce((a, b) => a + b, 0);
        process.stdout.write('\n' + fmt.bold('Blame summary: ' + file) + '\n\n');
        for (const [a, n] of Object.entries(authors).sort((a, b) => b[1] - a[1])) {
          const pct = Math.round((n / total) * 100);
          process.stdout.write(`  ${fmt.cyan(a.padEnd(28))} ${String(n).padStart(5)} lines  ${fmt.dim(pct + '%')}\n`);
        }
        return 0;
      } catch (e) {
        process.stderr.write(fmt.err('git blame failed: ' + e.message) + '\n');
        return 1;
      }
    }

    process.stderr.write(fmt.err('Usage: horizon git <commit|review [target]|log [query]|blame <file>>') + '\n');
    return 2;
  },

  // ── shell ────────────────────────────────────────────────────────────
  async shell({ runtime, args, flags }) {
    const q = args.join(' ').trim();
    if (!q) {
      process.stderr.write(fmt.err('Usage: horizon shell "what you want to do"') + '\n');
      process.stderr.write(fmt.dim('Example: horizon shell "find largest files in this dir"') + '\n');
      return 2;
    }
    const platform = process.platform === 'win32' ? 'Windows PowerShell' : process.platform === 'darwin' ? 'macOS bash/zsh' : 'Linux bash';
    const r = await quickChat(runtime,
      `You suggest a single shell command for the user's task on ${platform}. Output ONLY the command, no markdown fences, no explanation, no leading $. If multiple commands needed, join with && or ;. If the task is destructive (rm, format, delete) prefix the command with #DANGEROUS\\n so we can warn.`,
      q, { ...flags, quiet: true });
    if (r.error) { process.stderr.write(fmt.err(r.error) + '\n'); return 1; }
    const raw = r.reply.trim().replace(/^```\w*\n?|\n?```$/g, '').trim();
    const dangerous = raw.startsWith('#DANGEROUS');
    const cmd = dangerous ? raw.replace(/^#DANGEROUS\n?/, '').trim() : raw;
    process.stdout.write('\n  ' + fmt.cyan(cmd) + '\n\n');
    if (dangerous) process.stdout.write(fmt.warn('  ⚠  Marked DANGEROUS — review before running') + '\n\n');
    if (!flags.run) {
      process.stdout.write(fmt.dim('  Run it with: --run  (or copy/paste yourself)') + '\n\n');
      return 0;
    }
    if (process.stdin.isTTY && !flags.yes) {
      const ok = await promptYesNo(fmt.cyan('  execute? Y/n:'));
      if (!ok && ok !== undefined) {
        process.stdout.write(fmt.dim('cancelled\n'));
        return 0;
      }
    }
    try {
      execSync(cmd, { cwd: runtime.workspaceDir, stdio: 'inherit', shell: true });
      return 0;
    } catch (e) {
      return 1;
    }
  },

  // ── web search ──────────────────────────────────────────────────────
  async web({ runtime, args, flags }) {
    const q = args.join(' ').trim();
    if (!q) {
      process.stderr.write(fmt.err('Usage: horizon web "search query"') + '\n');
      return 2;
    }
    const tavilyKey = runtime.keysStore.get('k_tavily');
    const perplexityKey = runtime.keysStore.get('k_perplexity');
    if (!tavilyKey && !perplexityKey) {
      process.stderr.write(fmt.err('Need k_tavily or k_perplexity key — set via Settings or horizon connect') + '\n');
      return 1;
    }
    const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
    try {
      if (tavilyKey) {
        // Tavily search API
        const r = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: tavilyKey, query: q, max_results: 5 }),
        });
        const d = await r.json();
        if (d.error) { process.stderr.write(fmt.err(d.error) + '\n'); return 1; }
        if (flags.json) { process.stdout.write(JSON.stringify(d, null, 2) + '\n'); return 0; }
        process.stdout.write('\n' + fmt.bold('Web search: ' + q) + '\n\n');
        for (const r of (d.results || []).slice(0, 5)) {
          process.stdout.write(`  ${fmt.cyan(r.title)}\n`);
          process.stdout.write(`  ${fmt.dim(r.url)}\n`);
          process.stdout.write(`  ${(r.content || '').slice(0, 200)}…\n\n`);
        }
        if (d.answer) process.stdout.write(fmt.bold('Summary: ') + d.answer + '\n\n');
        return 0;
      }
      // Perplexity as web-aware fallback
      const r = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + perplexityKey },
        body: JSON.stringify({
          model: 'sonar',
          messages: [{ role: 'user', content: q }],
        }),
      });
      const d = await r.json();
      if (d.error) { process.stderr.write(fmt.err(d.error.message || d.error) + '\n'); return 1; }
      const reply = d.choices?.[0]?.message?.content || '';
      const citations = d.citations || [];
      if (flags.json) { process.stdout.write(JSON.stringify({ answer: reply, citations }, null, 2) + '\n'); return 0; }
      process.stdout.write('\n' + renderMarkdown(reply) + '\n\n');
      if (citations.length) {
        process.stdout.write(fmt.bold('Sources:') + '\n');
        citations.slice(0, 5).forEach((u, i) => process.stdout.write(`  ${i + 1}. ${fmt.dim(u)}\n`));
        process.stdout.write('\n');
      }
      return 0;
    } catch (e) {
      process.stderr.write(fmt.err(e.message) + '\n');
      return 1;
    }
  },

  // ── image generation ────────────────────────────────────────────────
  async image({ runtime, args, flags }) {
    const prompt = args.join(' ').trim();
    if (!prompt) { process.stderr.write(fmt.err('Usage: horizon image "prompt" [--out file.png] [--provider openai|gemini]') + '\n'); return 2; }
    const provider = flags.provider || runtime.settingsStore.get('image.provider') || 'openai';
    const out = flags.out || `horizon-image-${Date.now()}.png`;

    if (provider === 'openai') {
      const key = runtime.keysStore.get('k_openai');
      if (!key) { process.stderr.write(fmt.err('Need k_openai key (DALL-E 3)') + '\n'); return 1; }
      const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: runtime.settingsStore.get('image.model.openai') || 'dall-e-3',
          prompt, n: 1, size: flags.size || '1024x1024',
          response_format: 'b64_json',
        }),
      });
      const d = await r.json();
      if (d.error) { process.stderr.write(fmt.err(d.error.message) + '\n'); return 1; }
      const b64 = d.data?.[0]?.b64_json;
      if (!b64) { process.stderr.write(fmt.err('No image data returned') + '\n'); return 1; }
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
      process.stdout.write(fmt.ok('saved ' + path.resolve(out)) + '\n');
      return 0;
    }

    if (provider === 'gemini') {
      const key = runtime.keysStore.get('k_gemini');
      if (!key) { process.stderr.write(fmt.err('Need k_gemini key') + '\n'); return 1; }
      const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
      const model = runtime.settingsStore.get('image.model.gemini') || 'imagen-3.0-generate-001';
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1, aspectRatio: flags.aspect || '1:1' },
        }),
      });
      const d = await r.json();
      if (d.error) { process.stderr.write(fmt.err(d.error.message) + '\n'); return 1; }
      const b64 = d.predictions?.[0]?.bytesBase64Encoded;
      if (!b64) { process.stderr.write(fmt.err('No image data returned (model may not support image gen on free tier)') + '\n'); return 1; }
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
      process.stdout.write(fmt.ok('saved ' + path.resolve(out)) + '\n');
      return 0;
    }

    process.stderr.write(fmt.err('Unknown image provider: ' + provider) + '\n');
    return 2;
  },

  // ── screen capture / OCR ────────────────────────────────────────────
  async screen({ runtime, args, flags }) {
    const sub = args[0] || 'capture';
    const out = flags.out || `horizon-screen-${Date.now()}.png`;

    if (sub === 'capture' || sub === 'shot' || sub === 'snapshot') {
      // Platform-native screenshot. No native deps.
      try {
        if (process.platform === 'darwin') {
          execSync(`screencapture -x ${JSON.stringify(out)}`, { stdio: 'ignore' });
        } else if (process.platform === 'win32') {
          // PowerShell screenshot via .NET classes
          const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $s=[System.Windows.Forms.SystemInformation]::VirtualScreen; $b=New-Object System.Drawing.Bitmap $s.Width,$s.Height; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.Left,$s.Top,0,0,$b.Size); $b.Save('${out.replace(/'/g, "''")}'); $g.Dispose(); $b.Dispose()`;
          execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
        } else {
          // Linux — try common tools in order
          const tried = [];
          for (const cmd of ['gnome-screenshot -f', 'scrot', 'grim']) {
            try { execSync(`${cmd} ${JSON.stringify(out)}`, { stdio: 'ignore' }); break; }
            catch (_) { tried.push(cmd.split(' ')[0]); }
          }
          if (!fs.existsSync(out)) {
            process.stderr.write(fmt.err('No screenshot tool found. Install: ' + tried.join(', ')) + '\n');
            return 1;
          }
        }
        process.stdout.write(fmt.ok('saved ' + path.resolve(out)) + '\n');
        return 0;
      } catch (e) {
        process.stderr.write(fmt.err('screenshot failed: ' + e.message) + '\n');
        return 1;
      }
    }

    if (sub === 'describe') {
      // Capture first, then ask AI to describe
      const tmp = path.join(require('os').tmpdir(), `horizon-screen-${Date.now()}.png`);
      const dummyArgs = ['capture'];
      const r1 = await HANDLERS.screen({ runtime, args: dummyArgs, flags: { ...flags, out: tmp } });
      if (r1 !== 0) return r1;
      try {
        const buf = fs.readFileSync(tmp);
        const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
        // Use Gemini if available — it accepts vision; else fail honestly
        const key = runtime.keysStore.get('k_gemini');
        if (!key) {
          process.stderr.write(fmt.err('Need k_gemini key for vision describe') + '\n');
          process.stdout.write(fmt.dim('  Screenshot saved to ' + tmp + '\n'));
          return 1;
        }
        const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { text: 'Describe what is on this screen in 3-5 sentences. Note any apps, key UI elements, and obvious content.' },
                { inline_data: { mime_type: 'image/png', data: buf.toString('base64') } },
              ],
            }],
            generationConfig: { maxOutputTokens: 800 },
          }),
        });
        const d = await r.json();
        const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
        process.stdout.write('\n' + text + '\n\n');
        try { fs.unlinkSync(tmp); } catch (_) {}
        return 0;
      } catch (e) {
        process.stderr.write(fmt.err(e.message) + '\n');
        return 1;
      }
    }

    process.stderr.write(fmt.err('Usage: horizon screen <capture|describe> [--out file.png]') + '\n');
    return 2;
  },

  // ── todo ────────────────────────────────────────────────────────────
  async todo({ runtime, args, flags }) {
    const sub = args[0] || 'list';
    const rest = args.slice(1);
    const todos = loadTodos(runtime.userDataDir);

    if (sub === 'list') {
      if (flags.json) { process.stdout.write(JSON.stringify(todos, null, 2) + '\n'); return 0; }
      const open = todos.filter(t => !t.done);
      const done = todos.filter(t => t.done);
      process.stdout.write('\n' + fmt.bold('TODO') + ` ${fmt.dim(`(${open.length} open · ${done.length} done)`)}\n\n`);
      if (!open.length && !done.length) {
        process.stdout.write(fmt.dim('  no items · `horizon todo add "buy milk"`\n\n'));
        return 0;
      }
      for (const t of open) {
        process.stdout.write(`  ${fmt.dim('[ ]')} ${fmt.cyan(t.id)}  ${t.text}\n`);
      }
      if (done.length && flags.all !== false) {
        process.stdout.write('\n');
        for (const t of done.slice(-5)) {
          process.stdout.write(`  ${fmt.green('[✓]')} ${fmt.dim(t.id + '  ' + t.text)}\n`);
        }
      }
      process.stdout.write('\n');
      return 0;
    }

    if (sub === 'add') {
      const text = rest.join(' ').trim();
      if (!text) { process.stderr.write(fmt.err('text required') + '\n'); return 2; }
      const todo = { id: 't-' + crypto.randomBytes(2).toString('hex'), text, done: false, at: new Date().toISOString() };
      todos.push(todo);
      saveTodos(runtime.userDataDir, todos);
      process.stdout.write(fmt.ok(todo.id + ' added') + '\n');
      return 0;
    }

    if (sub === 'done' || sub === 'check') {
      const id = rest[0];
      const t = todos.find(x => x.id === id);
      if (!t) { process.stderr.write(fmt.err('not found') + '\n'); return 1; }
      t.done = true;
      t.doneAt = new Date().toISOString();
      saveTodos(runtime.userDataDir, todos);
      process.stdout.write(fmt.ok('✓ ' + t.text) + '\n');
      return 0;
    }

    if (sub === 'rm' || sub === 'remove') {
      const id = rest[0];
      const filtered = todos.filter(x => x.id !== id);
      if (filtered.length === todos.length) { process.stderr.write(fmt.err('not found') + '\n'); return 1; }
      saveTodos(runtime.userDataDir, filtered);
      process.stdout.write(fmt.ok('removed ' + id) + '\n');
      return 0;
    }

    if (sub === 'clear-done') {
      const filtered = todos.filter(t => !t.done);
      saveTodos(runtime.userDataDir, filtered);
      process.stdout.write(fmt.ok(`cleared ${todos.length - filtered.length} done items`) + '\n');
      return 0;
    }

    process.stderr.write(fmt.err('Usage: horizon todo list|add|done|rm|clear-done') + '\n');
    return 2;
  },

  // ── explain-error ───────────────────────────────────────────────────
  async 'explain-error'({ runtime, args, flags }) {
    const file = args[0];
    let content;
    if (file && file !== '-' && fs.existsSync(file)) {
      content = fs.readFileSync(file, 'utf8');
    } else {
      if (process.stdin.isTTY) {
        process.stderr.write(fmt.err('Pipe a stack trace or pass a log file path:\n  npm test 2>&1 | horizon explain-error\n  horizon explain-error error.log') + '\n');
        return 2;
      }
      content = fs.readFileSync(0, 'utf8');
    }
    const r = await quickChat(runtime,
      'You explain an error message or stack trace to a developer. Output: 1) ONE-sentence summary of what went wrong, 2) the most likely root cause, 3) 2-3 concrete fixes to try in priority order. Reference specific file paths or function names from the trace.',
      `Explain this error:\n\n${content.slice(0, 8000)}`,
      flags);
    return printChat(r, flags);
  },
};

async function run({ runtime, args, flags, _subcommand }) {
  const h = HANDLERS[_subcommand];
  if (!h) {
    process.stderr.write(fmt.err('Unknown dev helper: ' + _subcommand) + '\n');
    return 2;
  }
  return h({ runtime, args, flags });
}

module.exports = { run, HANDLERS };

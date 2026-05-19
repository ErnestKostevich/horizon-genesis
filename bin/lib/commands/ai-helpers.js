// Phase 12 — 10 AI-helper subcommands.
//
// Each is a thin wrapper around runChat / runAgent with a preset
// system prompt + arg parsing tuned for one task. They look like
// separate subcommands to the user but share this file because they're
// structurally identical (prompt, optional file/stdin, run, print).
//
// Why this design: Hermes Agent gets 70+ commands by giving every
// frequent pattern its own verb. "horizon explain main.js" reads
// better than "horizon chat 'explain this file' --file main.js". The
// preset prompts also tune model behaviour per task (terser for
// summarize, more careful for refactor, etc.).
//
// Commands implemented in this file:
//   ask "..."            quick one-liner (alias for chat --quiet)
//   explain <file|->     explain a file (or stdin) in plain words
//   summarize <file|->   bullet summary
//   translate <file|->   translate to --to <lang> (default Russian)
//   review <file>        code review
//   refactor <file>      suggest refactoring (read-only — outputs to stdout)
//   test <file>          generate a unit test scaffold
//   diff <file|->        explain a diff
//   search "query"       semantic search across workspace files
//   brief                morning briefing (memory + calendar-style summary)

const fs = require('fs');
const path = require('path');
const { fmt } = require('../tty');
const { renderMarkdown } = require('../markdown');
const { GradientSpinner } = require('../banner');

function readInput(arg) {
  if (!arg || arg === '-') {
    // Read all of stdin
    if (process.stdin.isTTY) return null;
    return fs.readFileSync(0, 'utf8');
  }
  try { return fs.readFileSync(arg, 'utf8'); }
  catch (e) { return null; }
}

async function quickChat(runtime, system, user, flags) {
  const spinner = !flags.json && !flags.quiet && process.stdout.isTTY
    ? new GradientSpinner('thinking…').start() : null;
  const r = await runtime.runChat(user, { system, provider: flags.provider, model: flags.model });
  if (spinner) spinner.stop();
  if (r.error) { process.stderr.write(fmt.err(r.error) + '\n'); return 1; }
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, reply: r.reply, model: r.model, usage: r.usage }) + '\n');
    return 0;
  }
  const out = (flags.plain || flags.quiet) ? r.reply : renderMarkdown(r.reply);
  process.stdout.write(out + '\n');
  if (!flags.quiet && r.usage) {
    process.stderr.write(fmt.dim(`(${r.model}, ${r.usage.total} tokens)`) + '\n');
  }
  return 0;
}

const HANDLERS = {
  async ask({ runtime, args, flags }) {
    const q = args.join(' ').trim();
    if (!q) { process.stderr.write(fmt.err('Usage: horizon ask "your question"') + '\n'); return 2; }
    return quickChat(runtime, '', q, { ...flags, quiet: true });
  },

  async explain({ runtime, args, flags }) {
    const file = args[0];
    const content = readInput(file);
    if (content == null) { process.stderr.write(fmt.err('Cannot read input (file or stdin)') + '\n'); return 1; }
    const ext = file && file !== '-' ? path.extname(file) : '';
    const head = file && file !== '-' ? `File: ${file}` : 'Input from stdin';
    return quickChat(runtime,
      'You explain code or text in plain language. Be concise. Use short paragraphs and numbered lists. No filler.',
      `${head}\n\n\`\`\`${ext.replace('.','')}\n${content}\n\`\`\`\n\nExplain:\n  1. What it does (one sentence)\n  2. Key parts and why they exist\n  3. Anything surprising or risky`,
      flags);
  },

  async summarize({ runtime, args, flags }) {
    const file = args[0];
    const content = readInput(file);
    if (content == null) { process.stderr.write(fmt.err('Cannot read input') + '\n'); return 1; }
    return quickChat(runtime,
      'You produce dense bullet-point summaries. No preamble, no conclusion, just facts. Lead each bullet with a verb or noun.',
      `Summarise this in 5-10 bullets:\n\n${content}`,
      flags);
  },

  async translate({ runtime, args, flags }) {
    const file = args[0];
    const content = readInput(file);
    if (content == null) { process.stderr.write(fmt.err('Cannot read input') + '\n'); return 1; }
    const to = flags.to || 'Russian';
    return quickChat(runtime,
      `You translate text into ${to}. Preserve formatting, code blocks, and links. Return only the translation, no commentary.`,
      content, flags);
  },

  async review({ runtime, args, flags }) {
    const file = args[0];
    const content = readInput(file);
    if (content == null) { process.stderr.write(fmt.err('Cannot read input') + '\n'); return 1; }
    return quickChat(runtime,
      'You are a careful senior engineer doing code review. Output: 1) bugs (HIGH priority), 2) security issues (HIGH), 3) maintainability issues (MEDIUM), 4) style nitpicks (LOW). Be specific — point to lines or functions. No empty praise.',
      `Review this code:\n\n\`\`\`\n${content}\n\`\`\``,
      flags);
  },

  async refactor({ runtime, args, flags }) {
    const file = args[0];
    const content = readInput(file);
    if (content == null) { process.stderr.write(fmt.err('Cannot read input') + '\n'); return 1; }
    return quickChat(runtime,
      'You suggest refactorings. Output: 1) what to change and why, 2) the refactored code in a single fenced block, ready to copy. If multiple changes, show one full revised file. Preserve external behaviour.',
      `Refactor this:\n\n\`\`\`\n${content}\n\`\`\`\n\nGoal: ${flags.goal || 'better readability + smaller functions, no behaviour change'}`,
      flags);
  },

  async test({ runtime, args, flags }) {
    const file = args[0];
    const content = readInput(file);
    if (content == null) { process.stderr.write(fmt.err('Cannot read input') + '\n'); return 1; }
    const runner = flags.runner || 'auto-detect (vitest if package.json has it, else jest, else node:test)';
    return quickChat(runtime,
      `You write unit tests. Pick the test runner (${runner}). Output a single ready-to-save test file. Cover happy path + 2 edge cases. No setup boilerplate beyond imports.`,
      `Write a test file for this:\n\n\`\`\`\n${content}\n\`\`\``,
      flags);
  },

  async diff({ runtime, args, flags }) {
    const file = args[0];
    const content = readInput(file);
    if (content == null) { process.stderr.write(fmt.err('Cannot read input (a .patch / .diff / stdin)') + '\n'); return 1; }
    return quickChat(runtime,
      'You explain unified diffs to a reviewer. Output: 1) one-sentence what this change does, 2) per-file bullet of the meaningful changes (skip whitespace), 3) risks / things to test.',
      `Explain this diff:\n\n\`\`\`diff\n${content}\n\`\`\``,
      flags);
  },

  async search({ runtime, args, flags }) {
    const query = args.join(' ').trim();
    if (!query) { process.stderr.write(fmt.err('Usage: horizon search "query"') + '\n'); return 2; }
    // Semantic search across memory only — for workspace files, use
    // `horizon agent "find every TODO and ..."` via tool calls.
    const results = await runtime.agentMemory.semanticRecall(query, flags.limit || 10, {});
    if (flags.json) { process.stdout.write(JSON.stringify(results, null, 2) + '\n'); return 0; }
    if (!results.length) { process.stdout.write(fmt.dim('no matches in memory · try horizon agent "..." for file-content search\n')); return 0; }
    for (const m of results) {
      const score = typeof m.score === 'number' ? fmt.dim(`(${m.score.toFixed(2)}) `) : '';
      process.stdout.write(`${score}${m.content || m.text || ''}\n`);
    }
    return 0;
  },

  async brief({ runtime, args, flags }) {
    // Daily briefing: memory snapshot + cost summary + cron upcoming
    const mem = runtime.agentMemory?._data || {};
    const cost = runtime.costTracker?.summary?.({ days: 1 }) || null;
    const cron = (runtime.settingsStore.get('cli.cron') || []).filter(c => c.enabled);
    const persona = runtime.settingsStore.get('persona') || 'jarvis';
    const userName = runtime.settingsStore.get('userName') || 'user';
    const context = [
      `User: ${userName}`,
      `Active persona: ${persona}`,
      `Memories: ${mem.memories?.length || 0}`,
      `Facts: ${Object.keys(mem.facts || {}).length}`,
      `Conversations: ${mem.conversations?.length || 0}`,
      cost ? `Last 24h: ${cost.totals.calls} calls, ${cost.totals.tokens} tokens, $${cost.totals.costUsd.toFixed(4)}` : '',
      cron.length ? `Scheduled today: ${cron.map(c => c.name || c.task.slice(0, 30)).join(' · ')}` : 'No cron entries enabled',
      `Time: ${new Date().toLocaleString()}`,
    ].filter(Boolean).join('\n');

    return quickChat(runtime,
      `You give a 6-sentence morning briefing to ${userName}. Mention what's scheduled, last usage, suggest 1-2 things to focus on. Be warm but specific. No emoji unless the persona is "pixel".`,
      `Context:\n${context}\n\nGive me the briefing.`,
      flags);
  },
};

async function run({ runtime, args, flags, _subcommand }) {
  const h = HANDLERS[_subcommand];
  if (!h) {
    process.stderr.write(fmt.err('Unknown helper: ' + _subcommand) + '\n');
    return 2;
  }
  return h({ runtime, args, flags });
}

module.exports = { run, HANDLERS };

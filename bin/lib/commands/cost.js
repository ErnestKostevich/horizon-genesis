// `horizon cost` — show token + dollar spend.
//
// Reads <userData>/horizon-cost.jsonl which the runtime appends to on
// every AI call. Aggregates by day / provider / model and prints a
// human table or --json export.
//
// Subcommands:
//   horizon cost                      — summary table (last 30 days)
//   horizon cost --days 7             — limit window
//   horizon cost --provider claude    — filter
//   horizon cost --json               — machine-readable
//   horizon cost dump                 — every recorded call as NDJSON
//   horizon cost prune --older 90     — trim old entries

const { fmt } = require('../tty');

async function run({ runtime, args, flags }) {
  const sub = args[0];
  if (sub === 'dump') return dump(runtime, flags);
  if (sub === 'prune') return prune(runtime, flags);
  return summary(runtime, flags);
}

function summary(runtime, flags) {
  const days = Number(flags.days || 30);
  const s = runtime.costTracker.summary({ days });

  if (flags.json) {
    process.stdout.write(JSON.stringify(s, null, 2) + '\n');
    return 0;
  }

  process.stdout.write('\n' + fmt.bold(`Cost summary · last ${days} days`) + '\n');
  process.stdout.write('  ' + fmt.dim('since ' + s.since.slice(0, 10)) + '\n\n');

  process.stdout.write(fmt.bold('Totals') + '\n');
  process.stdout.write(`  calls   ${s.totals.calls}\n`);
  process.stdout.write(`  tokens  ${fmtNumber(s.totals.tokens)}\n`);
  process.stdout.write(`  cost    ${fmt.green('$' + s.totals.costUsd.toFixed(4))}\n\n`);

  if (Object.keys(s.byProvider).length) {
    process.stdout.write(fmt.bold('By provider') + '\n');
    const rows = Object.entries(s.byProvider)
      .sort((a, b) => b[1].costUsd - a[1].costUsd);
    for (const [prov, v] of rows) {
      if (flags.provider && prov !== flags.provider) continue;
      process.stdout.write(
        `  ${fmt.cyan(prov.padEnd(13))} ${String(v.calls).padStart(5)} calls   ${fmtNumber(v.tokens).padStart(10)} tokens   ${fmt.green('$' + v.costUsd.toFixed(4))}\n`
      );
    }
    process.stdout.write('\n');
  }

  if (Object.keys(s.byModel).length && !flags.brief) {
    process.stdout.write(fmt.bold('By model') + '\n');
    const rows = Object.entries(s.byModel)
      .sort((a, b) => b[1].costUsd - a[1].costUsd)
      .slice(0, 10);
    for (const [mod, v] of rows) {
      process.stdout.write(
        `  ${fmt.cyan(mod.padEnd(38))} ${String(v.calls).padStart(5)} ${fmtNumber(v.tokens).padStart(10)} ${fmt.green('$' + v.costUsd.toFixed(4))}\n`
      );
    }
    process.stdout.write('\n');
  }

  // Last 7 days bar chart (ascii)
  if (Object.keys(s.byDay).length) {
    process.stdout.write(fmt.bold('Last 7 days') + '\n');
    const today = new Date();
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400_000);
      const key = d.toISOString().slice(0, 10);
      last7.push({ key, ...(s.byDay[key] || { calls: 0, tokens: 0, costUsd: 0 }) });
    }
    const maxCost = Math.max(0.0001, ...last7.map(d => d.costUsd));
    for (const d of last7) {
      const w = Math.round((d.costUsd / maxCost) * 30);
      const bar = w > 0 ? '█'.repeat(w) : fmt.dim('·');
      process.stdout.write(
        `  ${fmt.dim(d.key)}  ${fmt.cyan(bar.padEnd(30))} ${fmt.green('$' + d.costUsd.toFixed(4))} ${fmt.dim('· ' + d.calls + ' calls')}\n`
      );
    }
    process.stdout.write('\n');
  }

  if (s.totals.calls === 0) {
    process.stdout.write(fmt.dim('  No usage recorded yet. Run `horizon chat "hi"` to seed the log.\n\n'));
  }
  return 0;
}

function dump(runtime, flags) {
  const entries = runtime.costTracker.load(Infinity);
  for (const e of entries) process.stdout.write(JSON.stringify(e) + '\n');
  return 0;
}

function prune(runtime, flags) {
  const olderThanDays = Number(flags.older || 365);
  const r = runtime.costTracker.prune({ olderThanDays });
  process.stdout.write(fmt.ok(`pruned ${r.removed} entries older than ${olderThanDays} days, kept ${r.kept}`) + '\n');
  return 0;
}

function fmtNumber(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'K';
  return (n / 1_000_000).toFixed(2) + 'M';
}

module.exports = { run };

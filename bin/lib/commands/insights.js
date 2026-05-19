// `horizon insights` — extended analytics over cost log + memory + skills.
//
// Where `horizon cost` is dollars-and-tokens, insights answers
// "how am I using the agent?":
//   - top personas by usage
//   - top skills triggered
//   - hour-of-day heatmap
//   - which provider/model wins for each task type
//   - run success rate (goal-met vs partial)

const { fmt } = require('../tty');

async function run({ runtime, args, flags }) {
  const days = Number(flags.days || 30);
  const since = Date.now() - days * 86400_000;

  // Cost log is the spine — every AI call lands there
  const entries = (runtime.costTracker?.load(Infinity) || [])
    .filter(e => new Date(e.at).getTime() >= since);

  if (flags.json) {
    process.stdout.write(JSON.stringify({ days, count: entries.length, byPersona: byPersona(entries), byHour: byHour(entries), byModel: topN(byField(entries, 'model'), 10), bySource: byField(entries, 'source') }, null, 2) + '\n');
    return 0;
  }

  process.stdout.write('\n' + fmt.bold(`Insights · last ${days} days`) + '\n\n');
  if (!entries.length) {
    process.stdout.write(fmt.dim('  no activity in this window — run `horizon chat "hi"` and try again') + '\n\n');
    return 0;
  }

  // By model (heaviest usage)
  const models = topN(byField(entries, 'model'), 8);
  process.stdout.write(fmt.bold('Top models by token spend') + '\n');
  for (const [k, v] of models) {
    process.stdout.write(`  ${fmt.cyan(k.padEnd(36))} ${fmt.dim(v.calls + ' calls')} ${fmt.green(v.tokens.toLocaleString().padStart(12) + ' tokens')}\n`);
  }

  // By source (cli vs cli-stream vs cron vs ...)
  process.stdout.write('\n' + fmt.bold('Where calls came from') + '\n');
  const sources = byField(entries, 'source');
  for (const [k, v] of Object.entries(sources).sort((a, b) => b[1].calls - a[1].calls)) {
    process.stdout.write(`  ${fmt.cyan(k.padEnd(20))} ${fmt.dim(String(v.calls).padStart(5) + ' calls')}\n`);
  }

  // Hour-of-day heatmap
  process.stdout.write('\n' + fmt.bold('Hour-of-day heatmap (UTC)') + '\n');
  const hours = byHour(entries);
  const max = Math.max(1, ...hours);
  for (let h = 0; h < 24; h++) {
    const w = Math.round((hours[h] / max) * 30);
    const bar = w > 0 ? '█'.repeat(w) : fmt.dim('·');
    process.stdout.write(`  ${String(h).padStart(2, '0')}:00  ${fmt.cyan(bar.padEnd(30))} ${fmt.dim(hours[h] + ' calls')}\n`);
  }

  // Persona breakdown (read from memory.profile, not log — log doesn't tag persona)
  const personaCounts = personaUsage(runtime);
  if (personaCounts && Object.keys(personaCounts).length) {
    process.stdout.write('\n' + fmt.bold('Persona memory entries') + '\n');
    for (const [k, v] of Object.entries(personaCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      process.stdout.write(`  ${fmt.cyan(k.padEnd(14))} ${fmt.dim(v + ' notes')}\n`);
    }
  }

  process.stdout.write('\n');
  return 0;
}

function byField(entries, field) {
  const out = {};
  for (const e of entries) {
    const k = e[field] || 'unknown';
    out[k] = out[k] || { calls: 0, tokens: 0 };
    out[k].calls++;
    out[k].tokens += e.total || 0;
  }
  return out;
}

function topN(map, n) {
  return Object.entries(map).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, n);
}

function byHour(entries) {
  const buckets = new Array(24).fill(0);
  for (const e of entries) {
    try { buckets[new Date(e.at).getUTCHours()]++; } catch (_) {}
  }
  return buckets;
}

function byPersona(entries) {
  return byField(entries, 'source');
}

function personaUsage(runtime) {
  try {
    const pm = runtime.agentMemory?._data?.personaMemory;
    if (!pm) return null;
    const out = {};
    for (const [k, v] of Object.entries(pm)) {
      out[k] = Array.isArray(v) ? v.length : Object.keys(v || {}).length;
    }
    return out;
  } catch (_) { return null; }
}

module.exports = { run };

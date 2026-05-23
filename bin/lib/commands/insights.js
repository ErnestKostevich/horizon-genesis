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
const { panel } = require('../banner');

// Eighths-block palette for sub-cell-precision bar charts. Matches the
// cost-summary chart so the two commands feel like one visual system.
const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
function eighthsBar(value, max, width, color = fmt.cyan) {
  if (max <= 0) return fmt.dim('·' + ' '.repeat(width - 1));
  const sub = Math.round((value / max) * width * 8);
  if (sub === 0) return fmt.dim('·' + ' '.repeat(width - 1));
  const full = Math.floor(sub / 8);
  const rem = sub % 8;
  return color('█'.repeat(full) + (rem > 0 ? BLOCKS[rem] : ''))
       + ' '.repeat(Math.max(0, width - full - (rem > 0 ? 1 : 0)));
}

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

  process.stdout.write('\n  ' + fmt.bold(`Insights · last ${days} days`) + '\n\n');
  if (!entries.length) {
    process.stdout.write(fmt.dim('  no activity in this window — run `horizon chat "hi"` and try again') + '\n\n');
    return 0;
  }

  // Sprint-2.15 — eighths-block charts + panel framing. Each section is
  // now its own rounded panel so the dashboard reads like one cohesive
  // surface; bar charts use the 1/8-precision blocks from cost.js so
  // small values still show a visible sliver instead of "no bar at all".

  // ── Top models by token spend (with eighths bar) ─────────────────────
  const models = topN(byField(entries, 'model'), 8);
  const maxModelTokens = Math.max(1, ...models.map(([, v]) => v.tokens));
  const modelLines = models.map(([k, v]) =>
    fmt.cyan(k.padEnd(36)) + ' ' +
    eighthsBar(v.tokens, maxModelTokens, 18) + ' ' +
    fmt.green(v.tokens.toLocaleString().padStart(10)) + ' ' +
    fmt.dim('· ' + v.calls + ' calls')
  );
  process.stdout.write(panel({
    title: 'Top models by token spend',
    accent: 'cyan',
    width: 90,
    lines: modelLines,
  }) + '\n\n');

  // ── Where calls came from ────────────────────────────────────────────
  const sources = byField(entries, 'source');
  const sourceRows = Object.entries(sources).sort((a, b) => b[1].calls - a[1].calls);
  const maxSrcCalls = Math.max(1, ...sourceRows.map(([, v]) => v.calls));
  const sourceLines = sourceRows.map(([k, v]) =>
    fmt.cyan(k.padEnd(20)) + ' ' +
    eighthsBar(v.calls, maxSrcCalls, 18) + ' ' +
    fmt.dim(String(v.calls).padStart(5) + ' calls')
  );
  process.stdout.write(panel({
    title: 'Where calls came from',
    accent: 'magenta',
    width: 72,
    lines: sourceLines,
  }) + '\n\n');

  // ── Hour-of-day heatmap (UTC, eighths-precision) ─────────────────────
  const hours = byHour(entries);
  const maxHour = Math.max(1, ...hours);
  const hourLines = [];
  for (let h = 0; h < 24; h++) {
    hourLines.push(
      fmt.dim(String(h).padStart(2, '0') + ':00') + '  ' +
      eighthsBar(hours[h], maxHour, 30) + ' ' +
      fmt.dim(String(hours[h]).padStart(4) + ' calls')
    );
  }
  process.stdout.write(panel({
    title: 'Hour-of-day heatmap (UTC)',
    accent: 'green',
    width: 72,
    lines: hourLines,
  }) + '\n\n');

  // ── Persona memory entries (read from memory.profile) ─────────────────
  const personaCounts = personaUsage(runtime);
  if (personaCounts && Object.keys(personaCounts).length) {
    const personaRows = Object.entries(personaCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const maxNotes = Math.max(1, ...personaRows.map(([, v]) => v));
    const personaLines = personaRows.map(([k, v]) =>
      fmt.cyan(k.padEnd(14)) + ' ' +
      eighthsBar(v, maxNotes, 18) + ' ' +
      fmt.dim(String(v).padStart(4) + ' notes')
    );
    process.stdout.write(panel({
      title: 'Persona memory entries',
      accent: 'yellow',
      width: 72,
      lines: personaLines,
    }) + '\n\n');
  }
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

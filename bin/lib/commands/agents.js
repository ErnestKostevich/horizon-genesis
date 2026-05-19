// `horizon agents` — list running subagent runs (parallel/background).
//
// Right now the CLI doesn't keep cross-process state for in-flight
// runs (each `horizon agent "..."` is a one-shot), so this is mostly
// useful when `horizon serve` is up — the server tracks runs in memory
// and exposes them.
//
//   horizon agents list       — list active runs (HTTP API hit)
//   horizon agents stop <id>  — request graceful stop
//
// Reads from HORIZON_URL + HORIZON_TOKEN env vars if set, else assumes
// http://127.0.0.1:18789 with no token (will 401 if token is enforced
// — pass --token X explicitly).

const { fmt } = require('../tty');

async function run({ runtime, args, flags }) {
  const sub = args[0] || 'list';
  const rest = args.slice(1);
  const baseUrl = flags.url || process.env.HORIZON_URL || 'http://127.0.0.1:18789';
  const token = flags.token || process.env.HORIZON_TOKEN || '';
  const headers = token ? { 'Authorization': 'Bearer ' + token } : {};

  if (sub === 'list')                       return list(baseUrl, headers, flags);
  if (sub === 'stop' || sub === 'kill')     return stop(baseUrl, headers, rest, flags);

  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write('Try: list | stop <id>     (needs horizon serve to be running)\n');
  return 2;
}

async function list(baseUrl, headers, flags) {
  const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
  try {
    // The serve API exposes /api/agents/list when --enable-agents is set,
    // but this is best-effort: fall back gracefully if not implemented.
    const r = await fetch(baseUrl + '/api/agents/list', { headers });
    if (r.status === 404) {
      process.stdout.write(fmt.dim('\n  serve runtime doesn\'t expose /api/agents — single-process CLI has no concurrent runs to list\n\n'));
      return 0;
    }
    if (!r.ok) { process.stderr.write(fmt.err('HTTP ' + r.status) + '\n'); return 1; }
    const data = await r.json();
    if (flags.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return 0; }
    if (!data.runs?.length) {
      process.stdout.write(fmt.dim('\n  no active runs\n\n'));
      return 0;
    }
    process.stdout.write('\n' + fmt.bold('Active agent runs') + '\n\n');
    for (const r of data.runs) {
      process.stdout.write(`  ${fmt.cyan(r.id)} ${fmt.dim('step ' + r.step + '/' + r.maxSteps)} ${r.task.slice(0, 60)}\n`);
    }
    process.stdout.write('\n');
    return 0;
  } catch (e) {
    process.stderr.write(fmt.err('failed to reach ' + baseUrl + ' — is `horizon serve` running?') + '\n');
    return 1;
  }
}

async function stop(baseUrl, headers, rest, flags) {
  const id = rest[0];
  if (!id) { process.stderr.write(fmt.err('id required') + '\n'); return 2; }
  const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
  try {
    const r = await fetch(baseUrl + '/api/agents/' + encodeURIComponent(id) + '/stop', { method: 'POST', headers });
    if (r.status === 404) { process.stderr.write(fmt.err('not found: ' + id) + '\n'); return 1; }
    if (!r.ok) { process.stderr.write(fmt.err('HTTP ' + r.status) + '\n'); return 1; }
    process.stdout.write(fmt.ok('stop requested for ' + id) + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(fmt.err('failed to reach ' + baseUrl) + '\n');
    return 1;
  }
}

module.exports = { run };

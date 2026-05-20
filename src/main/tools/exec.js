'use strict';
/**
 * Code/shell execution tools.
 *
 * All execution is routed through agent.js's _routeExec so PHASE Docker
 * (host vs docker vs ssh executor) keeps working unchanged. We require
 * agent.js lazily inside execute() to avoid the require-cycle that would
 * otherwise occur when agent.js loads this file.
 */

const { register } = require('./registry');

function _agent() { return require('../agent'); }

register({
  name: 'run_code',
  description: 'Run code on PC. language: python/powershell/javascript/shell/cmd',
  parameters: { code: 'string', language: 'string' },
  async execute(args = {}) {
    // _routeExec is not exported by agent.js (it's a private helper), so we
    // use the public executeCode and let agent's internal _routeExec wrapper
    // get used through the live binding — but the cleanest approach is to
    // re-implement the route check here. To avoid behaviour drift we go
    // through agent.executeCode when no executor is wired, and through the
    // executor.run when it is. agent.js's _routeExec did exactly that.
    return _routeExec(args.code, args.language || 'shell', args.timeout);
  },
});

register({
  name: 'run_powershell',
  description: 'Run PowerShell script on Windows',
  parameters: { code: 'string' },
  async execute(args = {}) {
    return _routeExec(args.code, 'powershell', args.timeout);
  },
});

register({
  name: 'run_javascript',
  description: 'Run JavaScript code',
  parameters: { code: 'string' },
  async execute(args = {}) {
    return _routeExec(args.code, 'javascript', args.timeout);
  },
});

register({
  name: 'run_shell',
  description: 'Run a shell script',
  parameters: { code: 'string' },
  async execute(args = {}) {
    return _routeExec(args.code, 'shell', args.timeout);
  },
});

register({
  name: 'shell_command',
  description: 'Read-only shell cmd: dir/ls/ipconfig/ping/tasklist/systeminfo',
  parameters: { cmd: 'string' },
  async execute(args = {}) {
    const safe = /^(dir|ls|echo|date|time|whoami|hostname|ipconfig|ifconfig|pwd|cat\s|type\s|find\s|grep\s|ping\s|df |du |free |netstat|systeminfo|tasklist|ps |ver|uname|where|which)/i;
    if (!safe.test((args.cmd || '').trim())) {
      return { ok: false, out: '', err: 'Only read-only commands allowed. Use run_code for scripts.' };
    }
    return _agent().sh(args.cmd, 8000);
  },
});

// ── _routeExec mirror ──────────────────────────────────────────────────────
// agent.js keeps _routeExec as an unexported helper. We replicate it here
// (against the exact same executor lookup) so behaviour is identical: route
// through the wired Executor when present, fall back to host executeCode
// otherwise. This is the same 7-line function — duplicated rather than
// re-exported so the registry stays self-contained.
function _getExecutor() {
  try {
    const mainMod = require.cache[require.resolve('../main')];
    return (mainMod && mainMod.exports && mainMod.exports.executor) || null;
  } catch (_) { return null; }
}

async function _routeExec(code, language, timeout) {
  const exec = _getExecutor();
  if (exec && typeof exec.run === 'function') {
    return exec.run(code, language, { timeout });
  }
  return _agent().executeCode(code, language, timeout);
}

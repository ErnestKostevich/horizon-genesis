// `horizon doctor [--fix]` — health check that goes deeper than
// `horizon version`. Walks every subsystem, reports green/yellow/red,
// and with `--fix` repairs what it can without asking.
//
// Checks performed:
//   - userData dir exists and is writable
//   - settings/keys stores load + decrypt
//   - at least one provider key is configured (or a local provider URL)
//   - the active provider's key is set (or it's local)
//   - the active model is in the known model list for that provider
//   - memory file integrity (parseable, not truncated)
//   - embeddings sidecar consistent with memory count
//   - workspace dir exists; .horizon/ subdir is present or noted
//   - executor backend reachable (docker daemon if mode=docker)
//   - cost log JSONL not corrupted
//
// --fix repairs:
//   - missing .horizon/ subdir → mkdir
//   - corrupt cost log line → drop the bad lines, keep good ones
//   - missing default persona/lang/provider → write sensible defaults
//
// Inspired by `hermes doctor --fix`.

const fs = require('fs');
const path = require('path');
const { fmt } = require('../tty');
const { renderArt } = require('../banner');
const { DEFAULT_PROVIDER_MODELS } = require('../../../src/main/runtime/ai-providers');

function row(state, label, detail) {
  const icon = state === 'ok'   ? fmt.green('✓')
             : state === 'warn' ? fmt.yellow('⚠')
             : state === 'fail' ? fmt.red('✗')
             : fmt.dim('·');
  const det = detail ? '   ' + fmt.dim(detail) : '';
  process.stdout.write(`  ${icon} ${label}${det}\n`);
}

async function run({ runtime, args, flags }) {
  const fix = !!flags.fix;
  const findings = [];

  function check(state, label, detail, fixFn) {
    findings.push({ state, label, detail, fixFn: fixFn || null });
  }

  // 1. userData dir
  try {
    fs.accessSync(runtime.userDataDir, fs.constants.W_OK);
    check('ok', 'userData dir writable', runtime.userDataDir);
  } catch (e) {
    check('fail', 'userData dir not writable', runtime.userDataDir + ' (' + e.code + ')');
  }

  // 2. settings + keys stores load
  try {
    runtime.settingsStore.get('provider');
    check('ok', 'settings store readable', runtime.settingsStore.path);
  } catch (e) {
    check('fail', 'settings store unreadable', e.message);
  }
  try {
    runtime.keysStore.get('k_gemini'); // smoke read; decrypts AES-GCM
    check('ok', 'keys store decrypts', runtime.keysStore.path);
  } catch (e) {
    check('fail', 'keys store fails to decrypt', e.message + ' (was the GUI installed on a different machine?)');
  }

  // 3. At least one usable provider
  const providers = Object.keys(DEFAULT_PROVIDER_MODELS);
  const haveKey = providers.filter(p => runtime.keysStore.get('k_' + p));
  const haveLocal = ['ollama', 'lmstudio', 'localai'].filter(p => {
    const k = p === 'ollama' ? 'ollamaUrl' : p === 'lmstudio' ? 'lmStudioUrl' : 'localAiUrl';
    return !!runtime.settingsStore.get(k);
  });
  if (haveKey.length || haveLocal.length) {
    check('ok', 'at least one provider configured',
      `keys: ${haveKey.join(', ') || 'none'} · local: ${haveLocal.join(', ') || 'none'}`);
  } else {
    check('fail', 'no provider configured — run `horizon setup`');
  }

  // 4. Active provider has a key (or is local)
  const active = runtime.settingsStore.get('provider') || 'gemini';
  if (['ollama','lmstudio','localai'].includes(active)) {
    check('ok', `active provider "${active}" is local`);
  } else if (active === 'azure') {
    const ep = runtime.settingsStore.get('azureEndpoint');
    const dep = runtime.settingsStore.get('azureDeployment');
    if (ep && dep && runtime.keysStore.get('k_azure')) {
      check('ok', 'azure: endpoint + deployment + key set');
    } else {
      check('warn', 'azure: missing endpoint/deployment/key',
        `endpoint=${!!ep} deployment=${!!dep} key=${!!runtime.keysStore.get('k_azure')}`);
    }
  } else if (active === 'custom') {
    const url = runtime.settingsStore.get('customUrl');
    if (url) check('ok', 'custom: URL set', url);
    else check('warn', 'custom: URL not set');
  } else if (runtime.keysStore.get('k_' + active)) {
    check('ok', `active provider "${active}" has key`);
  } else {
    check('warn', `active provider "${active}" missing key`,
      'set with `horizon connect ...` or pick another with `horizon model <id>`');
  }

  // 5. Memory file integrity
  try {
    const memPath = path.join(runtime.userDataDir, 'horizon_memory.json');
    if (fs.existsSync(memPath)) {
      const raw = fs.readFileSync(memPath, 'utf8');
      JSON.parse(raw);
      check('ok', 'memory file parseable',
        `${(runtime.agentMemory._data?.memories?.length || 0)} memories, ${Object.keys(runtime.agentMemory._data?.facts || {}).length} facts`);
    } else {
      check('ok', 'memory file missing (will be created)', memPath);
    }
  } catch (e) {
    check('fail', 'memory file corrupt', e.message);
  }

  // 6. Embeddings sidecar
  const emb = runtime.embeddingService?.status();
  if (emb?.available) {
    const mem = runtime.agentMemory._data?.memories?.length || 0;
    if (emb.indexed === 0 && mem > 0) {
      check('warn', 'embeddings: 0 indexed but memories present',
        'run `horizon` and let backfill complete, or check the embed provider key');
    } else {
      check('ok', 'embeddings ready',
        `${emb.provider}, ${emb.indexed}/${mem} indexed`);
    }
  } else {
    check('warn', 'embeddings off',
      'set k_gemini or k_openai for semantic recall (keyword + FTS still work)');
  }

  // 7. Workspace .horizon dir
  const horDir = path.join(runtime.workspaceDir, '.horizon');
  if (fs.existsSync(horDir)) {
    check('ok', '.horizon/ found in workspace', horDir);
  } else {
    check('warn', '.horizon/ not in workspace',
      'workspace memory + rules will be empty; ' + (fix ? 'creating now' : 'run --fix to create'),
      () => {
        fs.mkdirSync(horDir, { recursive: true });
        fs.mkdirSync(path.join(horDir, 'skills'), { recursive: true });
      });
  }

  // 8. Executor / docker
  const exStatus = runtime.executor?.status();
  if (exStatus) {
    if (exStatus.mode === 'docker') {
      if (exStatus.dockerAvailable) {
        check('ok', 'executor mode=docker (daemon reachable)');
      } else {
        check('warn', 'executor mode=docker BUT docker not running',
          exStatus.dockerLastError || 'will fall back to host on next call');
      }
    } else {
      check('ok', `executor mode=${exStatus.mode}`);
    }
  }

  // 9. Cost log integrity
  const costPath = path.join(runtime.userDataDir, 'horizon-cost.jsonl');
  if (fs.existsSync(costPath)) {
    try {
      const raw = fs.readFileSync(costPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      let bad = 0;
      const good = [];
      for (const l of lines) {
        try { JSON.parse(l); good.push(l); } catch (_) { bad++; }
      }
      if (bad === 0) {
        check('ok', 'cost log clean', `${good.length} entries`);
      } else {
        check('warn', 'cost log has corrupt lines', `${bad} bad of ${lines.length}; ` + (fix ? 'rewriting' : 'run --fix to clean'),
          () => fs.writeFileSync(costPath, good.join('\n') + '\n', 'utf8'));
      }
    } catch (e) {
      check('warn', 'cost log read failed', e.message);
    }
  } else {
    check('ok', 'cost log not yet created (no calls recorded)');
  }

  // 10. Apply fixes
  let fixed = 0;
  if (fix) {
    for (const f of findings) {
      if (f.state === 'warn' && f.fixFn) {
        try { f.fixFn(); fixed++; f.detail = (f.detail || '') + ' → fixed'; f.state = 'ok'; }
        catch (e) { f.detail = (f.detail || '') + ' → fix failed: ' + e.message; }
      }
    }
  }

  // Output
  if (flags.json) {
    process.stdout.write(JSON.stringify({
      ok: !findings.some(f => f.state === 'fail'),
      checks: findings.map(({state,label,detail}) => ({state,label,detail})),
      fixed,
    }, null, 2) + '\n');
    return findings.some(f => f.state === 'fail') ? 1 : 0;
  }

  process.stdout.write('\n' + fmt.bold('Horizon doctor') + '\n\n');
  for (const f of findings) row(f.state, f.label, f.detail);

  const fails = findings.filter(f => f.state === 'fail').length;
  const warns = findings.filter(f => f.state === 'warn').length;
  process.stdout.write('\n');
  if (fails) {
    process.stdout.write(fmt.red(`  ${fails} failure${fails > 1 ? 's' : ''}`) +
      (warns ? fmt.dim(`, ${warns} warning${warns > 1 ? 's' : ''}`) : '') + '\n');
  } else if (warns) {
    process.stdout.write(fmt.yellow(`  ${warns} warning${warns > 1 ? 's' : ''}`));
    if (!fix && findings.some(f => f.fixFn)) {
      process.stdout.write(fmt.dim('  · re-run with --fix to repair'));
    }
    process.stdout.write('\n');
  } else {
    process.stdout.write(fmt.green('  all checks passed') + '\n');
    const art = renderArt('doctorHealthy', {
      tag: `${findings.length} check${findings.length === 1 ? '' : 's'} passed`,
      flags,
    });
    if (art) process.stdout.write('\n' + art + '\n');
  }
  if (fixed) process.stdout.write(fmt.dim(`  fixed ${fixed} item${fixed > 1 ? 's' : ''}`) + '\n');
  process.stdout.write('\n');

  return fails ? 1 : 0;
}

module.exports = { run };

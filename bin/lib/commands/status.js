// `horizon status` — runtime + system snapshot, more compact than doctor.
//
// `horizon status` shows: version + provider + memory size + skills + cron
// count + active session + last cost call + disk + workspace.
//
// `horizon status --deep` adds per-subsystem latency probes:
//   - ping the active provider's endpoint (HEAD or /models)
//   - timing for memory.recall
//   - timing for skillsManager.getSkillsBlock
//   - executor probe round-trip

const fs = require('fs');
const path = require('path');
const { fmt } = require('../tty');

async function run({ runtime, args, flags }) {
  const out = {
    version: require(path.join(__dirname, '..', '..', '..', 'package.json')).version,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    provider: runtime.settingsStore.get('provider'),
    persona: runtime.settingsStore.get('persona'),
    workspace: runtime.workspaceDir,
    userDataDir: runtime.userDataDir,
    memory: {
      memories: runtime.agentMemory?._data?.memories?.length || 0,
      facts: Object.keys(runtime.agentMemory?._data?.facts || {}).length,
      conversations: runtime.agentMemory?._data?.conversations?.length || 0,
    },
    skills: runtime.skillsManager?.list().length || 0,
    cronEntries: (runtime.settingsStore.get('cli.cron') || []).length,
    executor: runtime.executor?.status() || null,
    embeddings: runtime.embeddingService?.status() || null,
  };

  // Disk free for userData dir
  try {
    const stat = fs.statfsSync ? fs.statfsSync(runtime.userDataDir) : null;
    if (stat) {
      out.diskFreeBytes = stat.bavail * stat.bsize;
    }
  } catch (_) {}

  if (flags.deep) {
    out.probes = {};
    // memory recall timing
    try {
      const t0 = Date.now();
      runtime.agentMemory.recall('a', 5);
      out.probes.memoryRecallMs = Date.now() - t0;
    } catch (_) {}
    // skills block timing
    try {
      const t0 = Date.now();
      runtime.skillsManager?.getSkillsBlock?.('test', {});
      out.probes.skillsBlockMs = Date.now() - t0;
    } catch (_) {}
    // provider reachability (HEAD on a known endpoint)
    try {
      const provider = out.provider;
      const probes = {
        gemini: 'https://generativelanguage.googleapis.com',
        openai: 'https://api.openai.com/v1/models',
        groq: 'https://api.groq.com/openai/v1/models',
        claude: 'https://api.anthropic.com',
      };
      const url = probes[provider];
      if (url) {
        const t0 = Date.now();
        const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
        try {
          await Promise.race([
            fetch(url, { method: 'HEAD' }),
            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 4000)),
          ]);
          out.probes.providerReachMs = Date.now() - t0;
        } catch (_) {
          out.probes.providerReachMs = null;
        }
      }
    } catch (_) {}
  }

  if (flags.json) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); return 0; }

  process.stdout.write('\n' + fmt.bold('Horizon status') + '\n\n');
  process.stdout.write(`  version    ${fmt.cyan('v' + out.version)} ${fmt.dim('· Node ' + out.nodeVersion + ' ' + out.platform + '/' + out.arch)}\n`);
  process.stdout.write(`  provider   ${fmt.cyan(out.provider)} ${fmt.dim('· persona=' + out.persona)}\n`);
  process.stdout.write(`  memory     ${fmt.green(out.memory.memories + ' memories')} ${fmt.dim('· ' + out.memory.facts + ' facts · ' + out.memory.conversations + ' conversations')}\n`);
  process.stdout.write(`  skills     ${out.skills}\n`);
  process.stdout.write(`  cron       ${out.cronEntries} entries\n`);
  if (out.executor) {
    process.stdout.write(`  executor   ${fmt.cyan(out.executor.mode)} ${fmt.dim('· docker=' + (out.executor.dockerAvailable ? '✓' : '·') + ' ssh=' + (out.executor.sshConfigured ? '✓' : '·'))}\n`);
  }
  if (out.embeddings) {
    process.stdout.write(`  embeddings ${out.embeddings.available ? fmt.green('ready') : fmt.dim('off')} ${fmt.dim('· ' + (out.embeddings.indexed || 0) + ' indexed')}\n`);
  }
  process.stdout.write(`  workspace  ${fmt.dim(out.workspace)}\n`);
  process.stdout.write(`  userData   ${fmt.dim(out.userDataDir)}\n`);
  if (out.diskFreeBytes) {
    process.stdout.write(`  disk free  ${fmt.dim(Math.round(out.diskFreeBytes / 1024 / 1024 / 1024) + ' GB')}\n`);
  }
  if (flags.deep && out.probes) {
    process.stdout.write('\n  ' + fmt.bold('Probes') + '\n');
    for (const [k, v] of Object.entries(out.probes)) {
      process.stdout.write(`  ${fmt.dim(k.padEnd(20))} ${v === null ? fmt.red('timeout') : fmt.green(v + 'ms')}\n`);
    }
  }
  process.stdout.write('\n');
  return 0;
}

module.exports = { run };

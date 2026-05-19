// `horizon logs` — typed log views over what the runtime persisted.
//
//   horizon logs cost [--tail N]         — last N cost-log entries
//   horizon logs agent [--tail N]        — agent run summaries (from memory)
//   horizon logs errors [--tail N]       — errors collected from the log stream
//   horizon logs cron                    — fired entries
//   horizon logs all --tail N            — merged chronological view

const fs = require('fs');
const path = require('path');
const { fmt } = require('../tty');

async function run({ runtime, args, flags }) {
  const which = args[0] || 'all';
  const tail = Number(flags.tail || 25);

  if (which === 'cost' || which === 'all') {
    const entries = (runtime.costTracker?.load(tail) || []);
    if (entries.length) {
      process.stdout.write('\n' + fmt.bold('cost (last ' + tail + ')') + '\n');
      for (const e of entries.slice(-tail)) {
        const cost = e.costUsd ? '$' + e.costUsd.toFixed(4) : fmt.dim('—');
        process.stdout.write(`  ${fmt.dim(e.at.slice(11, 19))} ${fmt.cyan(e.provider.padEnd(13))} ${fmt.dim(String(e.total).padStart(6) + 't')} ${cost.padStart(10)} ${fmt.dim(e.source || '')}\n`);
      }
    }
  }

  if (which === 'agent' || which === 'all') {
    const mems = runtime.agentMemory?._data?.memories || [];
    const runMemos = mems.filter(m => m.source === 'cli' || m.source === 'cli-chat' || m.source === 'cli-chat-stream').slice(-tail);
    if (runMemos.length) {
      process.stdout.write('\n' + fmt.bold('agent (last ' + tail + ')') + '\n');
      for (const m of runMemos) {
        process.stdout.write(`  ${fmt.dim((m.timestamp || '').slice(11, 19))} ${fmt.cyan(m.source.padEnd(20))} ${(m.content || '').slice(0, 80)}\n`);
      }
    }
  }

  if (which === 'cron') {
    const items = runtime.settingsStore.get('cli.cron') || [];
    process.stdout.write('\n' + fmt.bold('cron') + '\n');
    for (const e of items) {
      const ok = e.lastResult?.ok === false ? fmt.red('✗') : fmt.green('✓');
      const when = e.lastRunAt ? new Date(e.lastRunAt).toLocaleString() : fmt.dim('never');
      process.stdout.write(`  ${ok} ${fmt.cyan(e.id.padEnd(16))} ${fmt.dim(e.expr.padEnd(13))} ${e.name}\n`);
      process.stdout.write(`    ${fmt.dim('last ' + when)}\n`);
    }
  }

  if (which === 'errors' || which === 'all') {
    // Find error-tagged entries
    const entries = (runtime.costTracker?.load(Infinity) || []).filter(e => e.error);
    if (entries.length) {
      process.stdout.write('\n' + fmt.bold('errors (last ' + tail + ')') + '\n');
      for (const e of entries.slice(-tail)) {
        process.stdout.write(`  ${fmt.red('✗')} ${fmt.dim(e.at.slice(11, 19))} ${fmt.cyan(e.provider)} ${(e.error || '').slice(0, 100)}\n`);
      }
    }
  }

  process.stdout.write('\n');
  return 0;
}

module.exports = { run };

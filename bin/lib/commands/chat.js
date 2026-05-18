// `horizon chat "message"` — single-turn chat. Streams reply to stdout.
//
// No multi-step agent loop, no tool calls. Use this for quick questions or
// to pipe results into other tools.

const { fmt, Spinner } = require('../tty');

async function run({ runtime, args, flags }) {
  const message = args.join(' ').trim();
  if (!message) {
    process.stderr.write(fmt.err('Need a message: horizon chat "your question"') + '\n');
    return 2;
  }

  const opts = {
    provider: flags.provider,
    model: flags.model,
    persona: flags.persona,
  };

  let spinner = null;
  if (!flags.quiet && !flags.json) {
    spinner = new Spinner('thinking…').start();
  }

  const r = await runtime.runChat(message, opts);

  if (spinner) spinner.stop();

  if (r.error) {
    process.stderr.write(fmt.err(r.error) + '\n');
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: r.error }) + '\n');
    }
    return 1;
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      ok: true,
      reply: r.reply,
      model: r.model,
      usage: r.usage || null,
    }) + '\n');
  } else if (flags.quiet) {
    process.stdout.write(r.reply.trim() + '\n');
  } else {
    process.stdout.write(r.reply.trim() + '\n');
    if (r.usage) {
      process.stderr.write(
        fmt.dim(`(${r.model}, ${r.usage.total} tokens)`) + '\n'
      );
    }
  }
  return 0;
}

module.exports = { run };

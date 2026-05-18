// `horizon chat "message"` — single-turn chat.
//
// Default behaviour:
//   - TTY: streams tokens as they arrive (gradient spinner before first
//     token), renders the finalised reply with markdown
//   - Piped (non-TTY): buffers, prints plain text
//   - --json: machine-readable single-line JSON
//   - --quiet: only the reply text, no metadata
//   - --no-stream / --plain: disable streaming/markdown explicitly

const { fmt } = require('../tty');
const { renderMarkdown } = require('../markdown');
const { GradientSpinner } = require('../banner');

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

  const wantStream = flags.stream !== false && !flags.json && !flags.plain && process.stdout.isTTY;
  const wantMarkdown = !flags.plain && !flags.json && !flags.quiet;

  if (flags.json) {
    // JSON path — always non-stream, single payload
    const r = await runtime.runChat(message, opts);
    process.stdout.write(JSON.stringify({
      ok: !r.error,
      reply: r.reply || null,
      error: r.error || null,
      model: r.model,
      usage: r.usage || null,
    }) + '\n');
    return r.error ? 1 : 0;
  }

  if (wantStream) {
    const spinner = new GradientSpinner('thinking…').start();
    let firstToken = true;
    const r = await runtime.runChatStream(message, opts, (chunk) => {
      if (firstToken) { spinner.stop(); firstToken = false; }
      process.stdout.write(chunk);
    });
    if (firstToken) {
      // Provider didn't stream — fall back to one-shot
      spinner.stop();
      if (r.error) { process.stderr.write(fmt.err(r.error) + '\n'); return 1; }
      // Some providers (cohere) return non-streamed reply this way
      if (r.reply) {
        process.stdout.write(wantMarkdown ? renderMarkdown(r.reply) : r.reply);
        process.stdout.write('\n');
      }
    } else {
      process.stdout.write('\n');
      if (wantMarkdown && r.reply && /[*_`#>-]/.test(r.reply)) {
        process.stdout.write(fmt.dim('─── rendered ───') + '\n');
        process.stdout.write(renderMarkdown(r.reply) + '\n');
      }
    }
    if (r.usage && !flags.quiet) {
      process.stderr.write(fmt.dim(`(${r.model}, ${r.usage.total} tokens)`) + '\n');
    }
    return r.error ? 1 : 0;
  }

  // Buffered (piped / non-TTY / explicit --no-stream)
  const r = await runtime.runChat(message, opts);
  if (r.error) {
    process.stderr.write(fmt.err(r.error) + '\n');
    return 1;
  }
  if (flags.quiet) {
    process.stdout.write(r.reply.trim() + '\n');
  } else {
    const out = wantMarkdown ? renderMarkdown(r.reply) : r.reply.trim();
    process.stdout.write(out + '\n');
    if (r.usage) {
      process.stderr.write(fmt.dim(`(${r.model}, ${r.usage.total} tokens)`) + '\n');
    }
  }
  return 0;
}

module.exports = { run };

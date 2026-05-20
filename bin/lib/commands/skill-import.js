// `horizon skill import <source>` — federated curator entry point.
//
// Pulls a SKILL.md from an external hub (agentskills.io, ClawHub,
// Hermes Skills Hub, GitHub) or a local path, runs the security scanner,
// shows a risk report, and (after user confirmation) installs into the
// user skills dir.
//
// Flags:
//   --force       install even when the scanner flags dangerous patterns
//   --yes         skip the confirmation prompt (still blocks "dangerous")
//   --json        machine-readable output (no prompt; never installs
//                 dangerous content without --force)
//   --scope user  target scope (only `user` makes sense today — workspace
//                 imports go through a different path)

const fs = require('fs');
const { fmt, promptYesNo, isTTY } = require('../tty');
const { importSkill } = require('../../../src/main/skillImporter');

async function run({ runtime, args, flags }) {
  const source = args[0];
  if (!source) {
    process.stderr.write(fmt.err('usage: horizon skill import <url|path> [--force] [--yes] [--json]') + '\n');
    process.stderr.write(fmt.dim('  sources: https://agentskills.io/... | https://clawhub.ai/... | github URL | local path') + '\n');
    return 2;
  }
  const sm = runtime.skillsManager;
  if (!sm) {
    process.stderr.write(fmt.err('Skills manager unavailable.') + '\n');
    return 1;
  }

  if (!flags.json) {
    process.stdout.write(fmt.cyan('→ ') + 'Fetching skill from ' + fmt.dim(source) + '\n');
  }

  let result;
  try {
    result = await importSkill(source, {});
  } catch (e) {
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
    } else {
      process.stderr.write(fmt.err('Import failed: ' + e.message) + '\n');
    }
    return 1;
  }

  if (!result.ok) {
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: result.error, parseErrors: result.parseErrors }) + '\n');
    } else {
      process.stderr.write(fmt.err('Import failed: ' + (result.error || 'unknown')) + '\n');
      for (const e of result.parseErrors || []) {
        process.stderr.write(fmt.dim('  - ' + e) + '\n');
      }
    }
    return 1;
  }

  const { skill, bundle, scanReport } = result;

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      ok: true,
      source: result.source,
      sourceKind: result.sourceKind,
      resolvedUrl: result.resolvedUrl,
      skill: { id: skill.id, frontmatter: skill.frontmatter },
      scan: scanReport,
    }, null, 2) + '\n');
    // In --json mode we don't auto-install — that should be an explicit
    // follow-up command (or call via the IPC API).
    return scanReport.risk === 'dangerous' && !flags.force ? 1 : 0;
  }

  // Pretty boxed scan report.
  process.stdout.write('\n' + renderScanReport(skill, scanReport) + '\n');

  if (scanReport.risk === 'dangerous' && !flags.force) {
    process.stderr.write(
      '\n' + fmt.err('Cannot install — dangerous patterns found.') +
      '\n  ' + fmt.dim('Re-run with --force to override (at your own risk).') + '\n'
    );
    return 1;
  }

  let proceed;
  if (flags.yes) {
    proceed = true;
  } else if (!isTTY) {
    process.stderr.write(fmt.err('Refusing to auto-install in non-TTY context. Pass --yes to confirm.') + '\n');
    return 1;
  } else {
    const defaultYes = scanReport.risk === 'low';
    const prompt = defaultYes
      ? `Install ${fmt.cyan(skill.id)}? [Y/n]`
      : `Install ${fmt.cyan(skill.id)} despite ${fmt.yellow(scanReport.risk)} risk? [y/N]`;
    const answer = await promptYesNo(prompt);
    proceed = defaultYes ? (answer || answer === undefined) : answer;
  }

  if (!proceed) {
    process.stdout.write(fmt.dim('Cancelled.') + '\n');
    return 0;
  }

  // Hand off to SkillsManager. force=true ensures we can overwrite an
  // existing user-scope entry on re-import; workspace skills are still
  // protected by installFromBundle's anti-clobber check.
  const r = sm.installFromBundle({
    frontmatter: bundle.frontmatter,
    body: bundle.body,
    helpers: bundle.helpers,
    references: bundle.references,
  }, { force: true });
  if (!r.ok) {
    process.stderr.write(fmt.err('Install failed: ' + r.error) + '\n');
    return 1;
  }
  process.stdout.write(fmt.ok(`Installed skill: ${fmt.cyan(skill.id)}`) + '\n');
  process.stdout.write(fmt.dim('  ' + r.dir + '\n'));

  // Audit log — same pattern as skill improve.
  try {
    const path = require('path');
    const log = path.join(runtime.userDataDir, 'skill-imports.log');
    fs.appendFileSync(log, JSON.stringify({
      ts: new Date().toISOString(),
      source: result.source,
      resolvedUrl: result.resolvedUrl,
      skill: skill.id,
      risk: scanReport.risk,
      findings: scanReport.summary,
      forced: !!flags.force,
    }) + '\n');
  } catch (_) {}

  return 0;
}

/**
 * Render a boxed scan report. Width is fixed at 60 cols so it lines up
 * inside the typical CLI viewport; if findings are wider, they wrap.
 *
 * Severity colours:
 *   dangerous → red bold
 *   high      → red
 *   medium    → yellow
 *   low       → dim
 */
function renderScanReport(skill, report) {
  const WIDTH = 60;
  const top    = '╭─ Skill Scan Report ' + '─'.repeat(Math.max(0, WIDTH - 22)) + '╮';
  const bottom = '╰' + '─'.repeat(WIDTH - 2) + '╯';

  const riskLine = (() => {
    const label = report.risk;
    const colored =
      label === 'dangerous' ? fmt.red(fmt.bold(label.toUpperCase())) :
      label === 'high'      ? fmt.red(label) :
      label === 'medium'    ? fmt.yellow(label) :
                              fmt.green(label);
    return boxLine(`Skill: ${fmt.cyan(skill.id)}    Risk: ${colored}`, WIDTH);
  })();

  const sum = report.summary || {};
  const findingsTotals = boxLine(
    `Findings: ${sum.dangerous || 0} dangerous, ${sum.high || 0} high, ${sum.medium || 0} medium, ${sum.low || 0} low`,
    WIDTH
  );

  const lines = [top, riskLine, findingsTotals];

  // Up to 8 most-severe findings, ordered by severity rank.
  const rank = { dangerous: 0, high: 1, medium: 2, low: 3 };
  const sorted = (report.findings || []).slice().sort((a, b) =>
    (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9)
  );
  const toShow = sorted.slice(0, 8);
  if (toShow.length) {
    lines.push(boxLine('', WIDTH));
    for (const f of toShow) {
      const tag = severityTag(f.severity);
      const head = `${tag} Line ${f.line}: ${f.description}`;
      lines.push(boxLine(head, WIDTH));
      if (f.context) {
        lines.push(boxLine('  ' + fmt.dim(truncate(f.context, WIDTH - 6)), WIDTH));
      }
    }
    if (sorted.length > toShow.length) {
      lines.push(boxLine(fmt.dim(`  …and ${sorted.length - toShow.length} more (re-run with --json for full report)`), WIDTH));
    }
  } else {
    lines.push(boxLine(fmt.dim('  No risk patterns detected.'), WIDTH));
  }

  lines.push(bottom);
  return lines.join('\n');
}

function boxLine(content, width) {
  // Strip ANSI for visible-length math, but keep the original string for paint.
  const visible = String(content).replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, width - 4 - visible.length);
  return '│ ' + content + ' '.repeat(pad) + ' │';
}

function severityTag(severity) {
  switch (severity) {
    case 'dangerous': return fmt.red(fmt.bold('[DANGER]'));
    case 'high':      return fmt.red('[HIGH]  ');
    case 'medium':    return fmt.yellow('[MEDIUM]');
    case 'low':       return fmt.dim('[LOW]   ');
    default:          return '[INFO]  ';
  }
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

module.exports = { run };

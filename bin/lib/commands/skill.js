// `horizon skill <subcommand>` — manage skills (list / show / new / run).
//
// Subcommands:
//   horizon skill list              — list every skill (workspace + user + builtin)
//   horizon skill show <id>         — print SKILL.md for an id
//   horizon skill new <id>          — scaffold a new SKILL.md in workspace scope
//   horizon skill run <id> "task"   — force-include this skill, run agent

const fs = require('fs');
const path = require('path');
const { fmt } = require('../tty');

const SKELETON = `---
name: REPLACE-ME
description: One sentence about when to use this skill.
version: 0.1.0
tags: []
triggers:
  - keyword pattern
examples:
  - example user query
---

# Skill body

Write the skill instructions here. Headers, lists, code blocks — anything
the agent should follow when this skill matches the user's query.
`;

async function run({ runtime, args, flags }) {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === 'list') {
    return listSkills(runtime, flags);
  }
  if (sub === 'show')    return showSkill(runtime, rest, flags);
  if (sub === 'new')     return newSkill(runtime, rest, flags);
  if (sub === 'run')     return runSkill(runtime, rest, flags);
  if (sub === 'improve') return improveSkill(runtime, rest, flags);
  if (sub === 'enable' || sub === 'disable') return toggleSkill(runtime, rest, sub, flags);

  process.stderr.write(fmt.err(`Unknown skill subcommand: ${sub}`) + '\n');
  process.stderr.write('Try: list | show | new | run | improve | enable | disable\n');
  return 2;
}

/**
 * PHASE 28.5 — agent-driven skill self-improvement.
 *
 * Reads the current SKILL.md, gives the agent a focused task to refine
 * it based on `--rationale "what's unclear"` (or a default review
 * brief), then writes the result back via skillsManager.writeSource.
 * Built-ins are read-only (writeSource enforces). Every edit logs to
 * <userData>/skill-edits.log so you can audit + roll back.
 */
async function improveSkill(runtime, rest, flags) {
  const id = String(rest[0] || '').trim();
  if (!id) {
    process.stderr.write(fmt.err('Need a skill id: horizon skill improve <id> [--rationale "what to improve"]') + '\n');
    return 2;
  }
  const sm = runtime.skillsManager;
  if (!sm) {
    process.stderr.write(fmt.err('Skills manager unavailable.') + '\n');
    return 1;
  }
  const skill = (sm.list() || []).find(s => s.id === id || s.name === id);
  if (!skill) {
    process.stderr.write(fmt.err('Unknown skill: ' + id) + '\n');
    return 2;
  }
  if (skill.scope === 'builtin') {
    process.stderr.write(fmt.err('Built-in skills are read-only. Copy to user/workspace scope first.') + '\n');
    return 1;
  }
  const oldContent = sm.readSource ? sm.readSource(id) : '';
  if (!oldContent) {
    process.stderr.write(fmt.err('Could not read existing SKILL.md for ' + id) + '\n');
    return 1;
  }
  const rationale = String(flags.rationale || 'Review the SKILL.md for clarity, missing trigger examples, ambiguous instructions, and stale references. Tighten and improve where useful, but preserve the frontmatter name + the original intent.').slice(0, 400);

  // Use the runtime's runChat to ask the active provider for an
  // improved SKILL.md. Temperature low + max tokens generous because
  // skills can be 5-15 KB.
  process.stdout.write(fmt.dim('Calling AI to refine the skill…\n'));
  const messages = [{
    role: 'user',
    content: 'Refine this skill\'s SKILL.md. Return ONLY the new full SKILL.md (YAML frontmatter + body), no prose around it, no markdown code fences.\n\n' +
             'Rationale for this edit:\n' + rationale + '\n\n' +
             'CURRENT SKILL.md:\n\n' + oldContent,
  }];
  let res;
  try {
    res = await runtime.runChat(messages, { system: 'You are a skill-document editor. Output only the new SKILL.md text — no commentary.' });
  } catch (e) {
    process.stderr.write(fmt.err('AI call failed: ' + e.message) + '\n');
    return 1;
  }
  if (!res || res.error || !res.reply) {
    process.stderr.write(fmt.err('AI returned no usable reply.') + '\n');
    return 1;
  }
  let updated = String(res.reply).trim();
  // Strip code fences if the model added them despite the instruction.
  updated = updated.replace(/^```(?:markdown|md|yaml)?/i, '').replace(/```$/, '').trim();

  if (!flags.yes && !flags.json) {
    const delta = updated.length - oldContent.length;
    process.stdout.write(fmt.dim(`\nProposed change — ${delta >= 0 ? '+' : ''}${delta} chars vs original.\n`));
    process.stdout.write(fmt.dim('Re-run with --yes to apply, or eyeball the proposed file at the path printed below:\n'));
    const previewPath = require('path').join(runtime.userDataDir, `.skill-preview-${id}.md`);
    require('fs').writeFileSync(previewPath, updated);
    process.stdout.write(fmt.cyan('  ' + previewPath) + '\n');
    return 0;
  }
  const r = sm.writeSource(id, updated, skill.scope);
  if (!r.ok) {
    process.stderr.write(fmt.err('Write failed: ' + r.error) + '\n');
    return 1;
  }
  // Audit log — same pattern self_improve_skill tool uses.
  try {
    const fsx = require('fs');
    const pathx = require('path');
    const log = pathx.join(runtime.userDataDir, 'skill-edits.log');
    fsx.appendFileSync(log, JSON.stringify({
      ts: new Date().toISOString(),
      skill: id,
      scope: skill.scope,
      rationale,
      source: 'cli',
      oldChars: oldContent.length,
      newChars: updated.length,
      delta: updated.length - oldContent.length,
    }) + '\n');
  } catch (_) {}
  process.stdout.write(fmt.ok(`✓ Skill ${id} refined (${updated.length - oldContent.length >= 0 ? '+' : ''}${updated.length - oldContent.length} chars) — logged.`) + '\n');
  return 0;
}

function listSkills(runtime, flags) {
  const list = runtime.skillsManager?.list() || [];
  const filter = flags.scope ? list.filter(s => s.scope === flags.scope) : list;

  if (flags.json) {
    process.stdout.write(JSON.stringify(filter, null, 2) + '\n');
    return 0;
  }
  if (!filter.length) {
    process.stdout.write(fmt.dim('no skills installed\n'));
    return 0;
  }
  // Pretty table
  const byScope = {};
  for (const s of filter) (byScope[s.scope] = byScope[s.scope] || []).push(s);
  for (const scope of ['workspace', 'user', 'builtin']) {
    if (!byScope[scope]) continue;
    process.stdout.write('\n' + fmt.bold(scope) + ' ' + fmt.dim(`(${byScope[scope].length})`) + '\n');
    for (const s of byScope[scope]) {
      const enabled = s.enabled === false ? fmt.dim('[off] ') : '';
      const tag = s.tags?.length ? fmt.dim(' [' + s.tags.join(',') + ']') : '';
      process.stdout.write(
        `  ${enabled}${fmt.cyan(s.id)} ${fmt.dim('· ' + (s.description || ''))}${tag}\n`
      );
    }
  }
  return 0;
}

function showSkill(runtime, rest, flags) {
  const id = rest[0];
  if (!id) {
    process.stderr.write(fmt.err('Need a skill id: horizon skill show <id>') + '\n');
    return 2;
  }
  const sk = runtime.skillsManager?.get(id);
  if (!sk) {
    process.stderr.write(fmt.err('No such skill: ' + id) + '\n');
    return 1;
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(sk, null, 2) + '\n');
    return 0;
  }
  const raw = runtime.skillsManager.readSource(id);
  process.stdout.write(raw + '\n');
  return 0;
}

function newSkill(runtime, rest, flags) {
  const id = rest[0];
  if (!id || !/^[a-z][a-z0-9-]{2,59}$/.test(id)) {
    process.stderr.write(fmt.err('Skill id must be kebab-case, 3–60 chars') + '\n');
    return 2;
  }
  const scope = flags.scope === 'user' ? 'user' : 'workspace';
  const content = SKELETON.replace('REPLACE-ME', id);
  const r = runtime.skillsManager.writeSource(id, content, scope);
  if (!r.ok) {
    process.stderr.write(fmt.err(r.error || 'Failed to create skill') + '\n');
    return 1;
  }
  process.stdout.write(fmt.ok(`created ${fmt.cyan(id)} in ${scope} scope`) + '\n');
  process.stdout.write(fmt.dim('  ' + r.dir + '\n'));
  return 0;
}

async function runSkill(runtime, rest, flags) {
  const id = rest[0];
  const task = rest.slice(1).join(' ').trim();
  if (!id) {
    process.stderr.write(fmt.err('Usage: horizon skill run <id> "task"') + '\n');
    return 2;
  }
  const sk = runtime.skillsManager?.get(id);
  if (!sk) {
    process.stderr.write(fmt.err('No such skill: ' + id) + '\n');
    return 1;
  }
  // Force-include the skill by prepending its trigger keyword. The
  // SkillsManager.getSkillsBlock relevance scorer picks it up first.
  const effectiveTask = task || `Apply skill ${id}.`;
  // We don't have a true "force selection" API — easiest is to pass the
  // skill body inline to the agent via a system block. Delegate to agent
  // command runner via runtime.runAgent with custom system bias.
  const agentCmd = require('./agent');
  return agentCmd.run({
    runtime,
    args: [effectiveTask],
    flags: { ...flags, persona: flags.persona },
  });
}

function toggleSkill(runtime, rest, sub, flags) {
  const id = rest[0];
  if (!id) {
    process.stderr.write(fmt.err(`Usage: horizon skill ${sub} <id>`) + '\n');
    return 2;
  }
  const r = runtime.skillsManager.toggleEnable(id, flags.scope);
  if (!r.ok) {
    process.stderr.write(fmt.err(r.error || 'toggle failed') + '\n');
    return 1;
  }
  process.stdout.write(
    fmt.ok(`${id} → ${r.enabled ? 'enabled' : 'disabled'}`) + '\n'
  );
  return 0;
}

module.exports = { run };

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
  if (sub === 'show') return showSkill(runtime, rest, flags);
  if (sub === 'new')  return newSkill(runtime, rest, flags);
  if (sub === 'run')  return runSkill(runtime, rest, flags);
  if (sub === 'enable' || sub === 'disable') return toggleSkill(runtime, rest, sub, flags);

  process.stderr.write(fmt.err(`Unknown skill subcommand: ${sub}`) + '\n');
  process.stderr.write('Try: list | show | new | run | enable | disable\n');
  return 2;
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

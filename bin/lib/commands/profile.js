// `horizon profile` — multiple isolated profiles in one install.
//
// Each profile is a named subdir under <userData>/profiles/<name>/ that
// holds its own horizon-settings.json, horizon-keys.json, horizon_memory.json,
// horizon-cost.jsonl, skills/, plugins/. The "default" profile is the
// regular <userData> dir (so existing users keep their data without
// migration).
//
// Switching profile: writes the chosen profile name to
// <userData>/active-profile.txt. The CLI bootstrap reads this file
// before calling createHorizonRuntime() and overrides userDataDir if
// a profile is set. The env var HORIZON_PROFILE=<name> overrides both.
//
// Subcommands:
//   horizon profile             — show active profile + list
//   horizon profile list        — list profiles
//   horizon profile create <name>  — create empty profile dir
//   horizon profile use <name>  — switch active
//   horizon profile show <name> — show profile details
//   horizon profile delete <name> — confirm + remove (NOT default)
//   horizon profile rename <old> <new> — rename
//   horizon profile path        — print active profile dir
//
// Inspired by `hermes profile`.

const fs = require('fs');
const path = require('path');
const { fmt, promptYesNo } = require('../tty');

function profileRoot(userDataDir) {
  // We use the *parent* userData dir, NOT the profile-scoped one. That way
  // active-profile.txt lives in a place the bootstrap reads BEFORE picking
  // the profile, breaking the chicken-and-egg.
  return userDataDir.endsWith(path.sep + path.basename(userDataDir))
    ? path.dirname(userDataDir) // shouldn't hit; defensive
    : userDataDir;
}

function rootDir(runtime) {
  // The base location — same calculation defaultUserDataDir() returns
  // before any profile selection. Already exposed as runtime.userDataDir
  // unless a profile is active; if active, the profile dir is set there
  // and the root is one level up under "profiles/".
  return runtime.userDataDir;
}

function profilesDir(baseDir) {
  return path.join(baseDir, 'profiles');
}

function activeFile(baseDir) {
  return path.join(baseDir, 'active-profile.txt');
}

function readActive(baseDir) {
  try {
    if (fs.existsSync(activeFile(baseDir))) {
      return fs.readFileSync(activeFile(baseDir), 'utf8').trim() || 'default';
    }
  } catch (_) {}
  return 'default';
}

function writeActive(baseDir, name) {
  fs.writeFileSync(activeFile(baseDir), name + '\n', 'utf8');
}

function listProfiles(baseDir) {
  const dir = profilesDir(baseDir);
  const out = ['default'];
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) out.push(e.name);
    }
  }
  return out;
}

async function run({ runtime, args, flags }) {
  // The runtime's userDataDir might be a profile-scoped dir; we walk up
  // if needed to find the base.
  const ud = runtime.userDataDir;
  const isProfileScoped = path.basename(path.dirname(ud)) === 'profiles';
  const baseDir = isProfileScoped ? path.dirname(path.dirname(ud)) : ud;

  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === 'list') {
    const active = process.env.HORIZON_PROFILE || readActive(baseDir);
    const list = listProfiles(baseDir);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ active, profiles: list }, null, 2) + '\n');
      return 0;
    }
    process.stdout.write('\n' + fmt.bold('Profiles') + '\n\n');
    for (const p of list) {
      const star = p === active ? fmt.green('●') : ' ';
      const dir = p === 'default' ? baseDir : path.join(profilesDir(baseDir), p);
      const note = p === active ? fmt.cyan(' (active)') : '';
      process.stdout.write(`  ${star} ${fmt.cyan(p.padEnd(16))}${note}  ${fmt.dim(dir)}\n`);
    }
    process.stdout.write('\n');
    if (process.env.HORIZON_PROFILE) {
      process.stdout.write(fmt.dim(`  active via HORIZON_PROFILE=${process.env.HORIZON_PROFILE} env var\n\n`));
    }
    return 0;
  }

  if (sub === 'path') {
    process.stdout.write(ud + '\n');
    return 0;
  }

  if (sub === 'create') {
    const name = validateName(rest[0]);
    if (!name) return 2;
    const dir = path.join(profilesDir(baseDir), name);
    if (fs.existsSync(dir)) {
      process.stderr.write(fmt.err('profile already exists: ' + name) + '\n');
      return 1;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    process.stdout.write(fmt.ok(`created profile ${fmt.cyan(name)}`) + '\n');
    process.stdout.write(fmt.dim('  ' + dir) + '\n');
    process.stdout.write(fmt.dim('  switch with: horizon profile use ' + name) + '\n');
    return 0;
  }

  if (sub === 'use') {
    const name = validateName(rest[0]);
    if (!name) return 2;
    if (name !== 'default') {
      const dir = path.join(profilesDir(baseDir), name);
      if (!fs.existsSync(dir)) {
        process.stderr.write(fmt.err('profile not found: ' + name + ' (use `horizon profile create ' + name + '` first)') + '\n');
        return 1;
      }
    }
    writeActive(baseDir, name);
    process.stdout.write(fmt.ok(`active profile → ${fmt.cyan(name)}`) + '\n');
    process.stdout.write(fmt.dim('  takes effect on next command') + '\n');
    return 0;
  }

  if (sub === 'show') {
    const name = rest[0] || readActive(baseDir);
    const dir = name === 'default' ? baseDir : path.join(profilesDir(baseDir), name);
    if (!fs.existsSync(dir)) {
      process.stderr.write(fmt.err('profile not found: ' + name) + '\n');
      return 1;
    }
    const settings = path.join(dir, 'horizon-settings.json');
    const keys = path.join(dir, 'horizon-keys.json');
    const mem = path.join(dir, 'horizon_memory.json');
    const summary = {
      name,
      dir,
      hasSettings: fs.existsSync(settings),
      hasKeys: fs.existsSync(keys),
      hasMemory: fs.existsSync(mem),
    };
    if (flags.json) { process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); return 0; }
    process.stdout.write(fmt.bold(name) + '\n');
    process.stdout.write(`  dir       ${fmt.dim(dir)}\n`);
    process.stdout.write(`  settings  ${summary.hasSettings ? fmt.green('✓') : fmt.dim('·')}\n`);
    process.stdout.write(`  keys      ${summary.hasKeys ? fmt.green('✓') : fmt.dim('·')}\n`);
    process.stdout.write(`  memory    ${summary.hasMemory ? fmt.green('✓') : fmt.dim('·')}\n`);
    return 0;
  }

  if (sub === 'delete') {
    const name = validateName(rest[0]);
    if (!name) return 2;
    if (name === 'default') {
      process.stderr.write(fmt.err('cannot delete the default profile') + '\n');
      return 1;
    }
    const dir = path.join(profilesDir(baseDir), name);
    if (!fs.existsSync(dir)) {
      process.stderr.write(fmt.err('profile not found: ' + name) + '\n');
      return 1;
    }
    if (!flags.yes) {
      process.stderr.write(fmt.warn(`This deletes ${dir} and everything inside (keys, memory, skills).`) + '\n');
      const ok = await promptYesNo(fmt.cyan('  proceed? y/N:'));
      if (!ok) { process.stdout.write(fmt.dim('cancelled\n')); return 0; }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    // If this was active, fall back to default
    if (readActive(baseDir) === name) writeActive(baseDir, 'default');
    process.stdout.write(fmt.ok('deleted ' + name) + '\n');
    return 0;
  }

  if (sub === 'rename') {
    const oldName = validateName(rest[0]);
    const newName = validateName(rest[1]);
    if (!oldName || !newName) return 2;
    if (oldName === 'default') {
      process.stderr.write(fmt.err('cannot rename the default profile') + '\n');
      return 1;
    }
    const oldDir = path.join(profilesDir(baseDir), oldName);
    const newDir = path.join(profilesDir(baseDir), newName);
    if (!fs.existsSync(oldDir)) {
      process.stderr.write(fmt.err('profile not found: ' + oldName) + '\n');
      return 1;
    }
    if (fs.existsSync(newDir)) {
      process.stderr.write(fmt.err('destination exists: ' + newName) + '\n');
      return 1;
    }
    fs.renameSync(oldDir, newDir);
    if (readActive(baseDir) === oldName) writeActive(baseDir, newName);
    process.stdout.write(fmt.ok(`renamed ${oldName} → ${newName}`) + '\n');
    return 0;
  }

  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write('Try: list | use <name> | create <name> | show <name> | delete <name> | rename <old> <new> | path\n');
  return 2;
}

function validateName(name) {
  if (!name) {
    process.stderr.write(fmt.err('profile name required') + '\n');
    return null;
  }
  if (!/^[a-z0-9][a-z0-9-_]{0,30}$/i.test(name)) {
    process.stderr.write(fmt.err('invalid profile name (alphanumeric + dash/underscore, max 31)') + '\n');
    return null;
  }
  return name;
}

module.exports = { run };

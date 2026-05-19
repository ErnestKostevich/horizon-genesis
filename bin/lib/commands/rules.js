// `horizon rules` — view / edit .horizon/rules.md in the current workspace.
//
// rules.md is the per-project "don't do this, prefer that" file the
// agent reads on every turn (lands in the system prompt). Keeping it
// short + checked into git turns project conventions into agent rules.
//
//   horizon rules                  — show current contents (or hint)
//   horizon rules edit             — open in $EDITOR (or VS Code)
//   horizon rules path             — print path
//   horizon rules add "rule line"  — append a single rule line
//   horizon rules clear            — wipe (asks confirmation)

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fmt, promptYesNo } = require('../tty');

function rulesPath(workspaceDir) {
  return path.join(workspaceDir, '.horizon', 'rules.md');
}

async function run({ runtime, args, flags }) {
  const sub = args[0] || 'show';
  const file = rulesPath(runtime.workspaceDir);

  if (sub === 'path') { process.stdout.write(file + '\n'); return 0; }

  if (sub === 'show' || !sub) {
    if (!fs.existsSync(file)) {
      process.stdout.write(fmt.dim('\n  no .horizon/rules.md in this workspace\n'));
      process.stdout.write(fmt.dim(`  create one: horizon rules add "Never push to main directly"\n\n`));
      return 0;
    }
    process.stdout.write(fs.readFileSync(file, 'utf8'));
    return 0;
  }

  if (sub === 'edit') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '# Project rules for the Horizon agent\n\n- ', 'utf8');
    }
    const editor = process.env.EDITOR || process.env.VISUAL ||
                   (process.platform === 'win32' ? 'notepad' : 'vi');
    const child = spawn(editor, [file], { stdio: 'inherit', shell: true });
    return new Promise(resolve => child.on('exit', () => resolve(0)));
  }

  if (sub === 'add') {
    const rule = args.slice(1).join(' ').trim();
    if (!rule) { process.stderr.write(fmt.err('Usage: horizon rules add "rule text"') + '\n'); return 2; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let cur = '';
    if (fs.existsSync(file)) cur = fs.readFileSync(file, 'utf8');
    if (cur && !cur.endsWith('\n')) cur += '\n';
    if (!cur) cur = '# Project rules for the Horizon agent\n\n';
    cur += '- ' + rule + '\n';
    fs.writeFileSync(file, cur, 'utf8');
    process.stdout.write(fmt.ok('rule added') + '\n');
    return 0;
  }

  if (sub === 'clear') {
    if (!fs.existsSync(file)) { process.stdout.write(fmt.dim('nothing to clear\n')); return 0; }
    if (!flags.yes) {
      const ok = await promptYesNo(fmt.cyan(`  wipe ${file}? y/N:`));
      if (!ok) return 0;
    }
    fs.unlinkSync(file);
    process.stdout.write(fmt.ok('cleared') + '\n');
    return 0;
  }

  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write('Try: show | edit | path | add "rule" | clear\n');
  return 2;
}

module.exports = { run };

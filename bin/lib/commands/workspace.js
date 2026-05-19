// `horizon ws` (alias: `horizon workspace`) — inspect / init .horizon/
// folder in the current workspace.
//
//   horizon ws                  — show what's configured in .horizon/
//   horizon ws init             — scaffold .horizon/ with rules.md, memory.json, skills/
//   horizon ws path             — print absolute path
//   horizon ws memory show      — view memory.json
//   horizon ws memory edit      — open in $EDITOR

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fmt } = require('../tty');

function horDir(workspaceDir) {
  return path.join(workspaceDir, '.horizon');
}

async function run({ runtime, args, flags }) {
  const sub = args[0] || 'show';
  const rest = args.slice(1);
  const dir = horDir(runtime.workspaceDir);

  if (sub === 'path') { process.stdout.write(dir + '\n'); return 0; }

  if (sub === 'show' || !sub) {
    process.stdout.write('\n' + fmt.bold('Workspace .horizon/') + '\n');
    process.stdout.write(`  ${fmt.dim(dir)}\n\n`);
    if (!fs.existsSync(dir)) {
      process.stdout.write(fmt.dim('  not initialised · run `horizon ws init` to scaffold\n\n'));
      return 0;
    }
    const items = [
      { f: 'rules.md',     label: 'project rules',         editable: true },
      { f: 'memory.json',  label: 'workspace memory',      editable: true },
      { f: 'skills',       label: 'workspace skills dir',  editable: false },
    ];
    for (const it of items) {
      const p = path.join(dir, it.f);
      const exists = fs.existsSync(p);
      const tag = exists ? fmt.green('●') : fmt.dim('○');
      let detail = '';
      if (exists) {
        const st = fs.statSync(p);
        if (st.isDirectory()) {
          const count = fs.readdirSync(p).filter(x => !x.startsWith('.')).length;
          detail = `${count} item${count !== 1 ? 's' : ''}`;
        } else {
          detail = `${Math.round(st.size / 102) / 10} KB`;
        }
      }
      process.stdout.write(`  ${tag} ${fmt.cyan(it.f.padEnd(14))} ${it.label.padEnd(25)} ${fmt.dim(detail)}\n`);
    }
    process.stdout.write('\n');
    return 0;
  }

  if (sub === 'init') {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    const rulesPath = path.join(dir, 'rules.md');
    if (!fs.existsSync(rulesPath)) {
      fs.writeFileSync(rulesPath,
        '# Project rules for the Horizon agent\n\n' +
        '- Prefer reading existing code before writing new files\n' +
        '- Never modify .env or files outside this workspace\n' +
        '- Run tests before committing\n', 'utf8');
    }
    const memPath = path.join(dir, 'memory.json');
    if (!fs.existsSync(memPath)) {
      const ws = path.basename(runtime.workspaceDir);
      fs.writeFileSync(memPath, JSON.stringify({
        version: 1,
        workspace: { name: ws },
        conventions: [],
        glossary: {},
        decisions: [],
        do_not: [],
      }, null, 2), 'utf8');
    }
    process.stdout.write(fmt.ok('initialised .horizon/ in ' + runtime.workspaceDir) + '\n');
    process.stdout.write(fmt.dim('  edit:  horizon rules edit  ·  horizon ws memory edit\n'));
    return 0;
  }

  if (sub === 'memory') {
    const sub2 = rest[0] || 'show';
    const mem = path.join(dir, 'memory.json');
    if (sub2 === 'show') {
      if (!fs.existsSync(mem)) { process.stdout.write(fmt.dim('not initialised · run horizon ws init\n')); return 0; }
      process.stdout.write(fs.readFileSync(mem, 'utf8') + '\n');
      return 0;
    }
    if (sub2 === 'edit') {
      if (!fs.existsSync(mem)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(mem, '{}\n', 'utf8'); }
      const editor = process.env.EDITOR || process.env.VISUAL ||
                     (process.platform === 'win32' ? 'notepad' : 'vi');
      const child = spawn(editor, [mem], { stdio: 'inherit', shell: true });
      return new Promise(resolve => child.on('exit', () => resolve(0)));
    }
    process.stderr.write(fmt.err('Usage: horizon ws memory show|edit') + '\n');
    return 2;
  }

  process.stderr.write(fmt.err('Unknown subcommand: ' + sub) + '\n');
  process.stderr.write('Try: show | init | path | memory show | memory edit\n');
  return 2;
}

module.exports = { run };

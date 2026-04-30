const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const outPath = path.join(root, 'src', 'main', 'build-info.json');

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function git(args, fallback = '') {
  try {
    return childProcess.execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || fallback;
  } catch (_) {
    return fallback;
  }
}

const ref =
  process.env.GITHUB_REF_NAME ||
  process.env.GITHUB_HEAD_REF ||
  process.env.GITHUB_REF ||
  git(['rev-parse', '--abbrev-ref', 'HEAD'], 'local');

const sha =
  process.env.GITHUB_SHA ||
  git(['rev-parse', 'HEAD'], 'unknown');

const runner =
  process.env.RUNNER_OS ||
  argValue('runner', process.platform);

const info = {
  official: true,
  version: `v${pkg.version}`,
  ref,
  sha,
  buildDate: new Date().toISOString(),
  runner,
  workflow: process.env.GITHUB_WORKFLOW || 'local-build',
  runId: process.env.GITHUB_RUN_ID || 'local',
};

fs.writeFileSync(outPath, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
console.log(`Stamped ${path.relative(root, outPath)} for ${info.version} (${info.ref})`);

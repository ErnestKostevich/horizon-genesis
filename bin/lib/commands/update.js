// `horizon update` — self-update from GitHub Releases.
//
// Two install modes are auto-detected:
//   1. Standalone binary (process.pkg is truthy when bundled by @yao-pkg/pkg)
//      → download the matching binary for this OS/arch from the latest
//        `cli-v*` release and atomically replace the running file.
//   2. From-source clone (process.pkg is false)
//      → `git pull` + `npm ci --omit=dev` in the repo dir.
//
// Flags:
//   --check    print latest available vs current, no changes
//   --backup   snapshot userData/ to backups/ before swapping
//   --json     machine-readable status
//
// Latest version is read from the public GitHub API
// (https://api.github.com/repos/ErnestKostevich/horizon-genesis/releases),
// filtered to tags starting with `cli-v`.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fmt } = require('../tty');

const REPO_API = 'https://api.github.com/repos/ErnestKostevich/horizon-genesis/releases';

const ASSET_FOR_PLATFORM = () => {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'win32') return 'horizon-win-x64.exe';
  if (platform === 'darwin') return arch === 'arm64' ? 'horizon-macos-arm64' : 'horizon-macos-x64';
  if (platform === 'linux') return 'horizon-linux-x64';
  return null;
};

function pkgVersion() {
  // When bundled by pkg, package.json is embedded as an asset and the
  // resolution path differs. We read it through require() to handle both.
  try {
    return require(path.join(__dirname, '..', '..', '..', 'package.json')).version;
  } catch (_) {
    try { return require('../../../package.json').version; } catch (_) { return '0.0.0'; }
  }
}

async function fetchJson(url) {
  const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
  const r = await fetch(url, { headers: { 'User-Agent': 'horizon-cli/' + pkgVersion() } });
  if (!r.ok) throw new Error(`GitHub API HTTP ${r.status}`);
  return r.json();
}

async function findLatestCliRelease() {
  const all = await fetchJson(REPO_API);
  // Filter to cli-v* tags only
  const cliReleases = all.filter(r => /^cli-v\d/.test(r.tag_name || ''));
  if (!cliReleases.length) {
    return { tag: null, assets: [], note: 'No cli-v* release published yet — push tag `cli-v0.0.1` (or newer) to trigger release-cli.yml' };
  }
  const latest = cliReleases[0]; // GitHub returns newest first
  return {
    tag: latest.tag_name,
    name: latest.name,
    publishedAt: latest.published_at,
    assets: latest.assets.map(a => ({ name: a.name, url: a.browser_download_url, size: a.size })),
  };
}

async function downloadTo(url, dest) {
  const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
  const r = await fetch(url, { headers: { 'User-Agent': 'horizon-cli' } });
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

function backupUserData(userDataDir) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.dirname(userDataDir);
  const dest = path.join(base, `backups`, `horizon-${ts}`);
  fs.mkdirSync(dest, { recursive: true });
  // Copy the 4 most important files; skip caches.
  for (const f of ['horizon-settings.json', 'horizon-keys.json', 'horizon_memory.json', 'horizon-cost.jsonl']) {
    const src = path.join(userDataDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
  }
  return dest;
}

function isBundledBinary() {
  return typeof process.pkg !== 'undefined';
}

async function run({ runtime, args, flags }) {
  const current = pkgVersion();

  let latest;
  try {
    latest = await findLatestCliRelease();
  } catch (e) {
    process.stderr.write(fmt.err('GitHub API: ' + e.message) + '\n');
    return 1;
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      current, latest: latest.tag, bundled: isBundledBinary(),
      assets: latest.assets || [],
      note: latest.note || null,
    }, null, 2) + '\n');
    return 0;
  }

  process.stdout.write('\n' + fmt.bold('Horizon CLI update') + '\n\n');
  process.stdout.write(`  current  ${fmt.cyan('v' + current)}\n`);
  if (latest.tag) {
    process.stdout.write(`  latest   ${fmt.cyan(latest.tag)} ${fmt.dim('· published ' + latest.publishedAt.slice(0, 10))}\n`);
  } else {
    process.stdout.write(`  latest   ${fmt.yellow('none')}  ${fmt.dim(latest.note)}\n\n`);
    return 0;
  }

  if (flags.check) {
    const latestVer = latest.tag.replace(/^cli-v/, '');
    if (current === latestVer) {
      process.stdout.write('\n' + fmt.green('  up to date') + '\n\n');
    } else {
      process.stdout.write('\n' + fmt.yellow(`  update available — run \`horizon update\` to apply`) + '\n\n');
    }
    return 0;
  }

  // Apply
  if (isBundledBinary()) {
    return updateBundled(runtime, flags, latest);
  } else {
    return updateFromSource(runtime, flags);
  }
}

async function updateBundled(runtime, flags, latest) {
  const assetName = ASSET_FOR_PLATFORM();
  if (!assetName) {
    process.stderr.write(fmt.err(`Unsupported platform/arch: ${process.platform}/${process.arch}`) + '\n');
    return 1;
  }
  const asset = latest.assets.find(a => a.name === assetName);
  if (!asset) {
    process.stderr.write(fmt.err(`Asset not found in release: ${assetName}`) + '\n');
    return 1;
  }

  if (flags.backup) {
    process.stdout.write(fmt.dim('  backing up userData…\n'));
    const dest = backupUserData(runtime.userDataDir);
    process.stdout.write(fmt.ok('  backed up to ' + dest) + '\n');
  }

  const myPath = process.execPath; // current binary
  const tmp = myPath + '.new';
  // Sprint-2.10 — spinner during the multi-MB download. Previously the
  // CLI printed "downloading…" and went silent for 10-30 seconds. Now
  // a gradient spinner ticks while bytes arrive, and the final stop()
  // converts the line to a ✓ green check.
  const { GradientSpinner } = require('../banner');
  const sizeMb = Math.round(asset.size / 1024 / 1024);
  const dlSpinner = new GradientSpinner(`downloading ${assetName} (${sizeMb} MB)…`).start();
  try {
    await downloadTo(asset.url, tmp);
    dlSpinner.succeed(`downloaded ${assetName} (${sizeMb} MB)`);
  } catch (e) {
    dlSpinner.fail('download failed: ' + e.message);
    return 1;
  }

  // Atomic swap. On Windows we can't replace the running .exe directly —
  // schedule a rename via a tiny side-script that the user's shell will
  // pick up next launch. On Unix we can rename in place.
  if (process.platform === 'win32') {
    const swap = myPath + '.swap.cmd';
    fs.writeFileSync(swap,
      `@echo off\r\nping 127.0.0.1 -n 2 > nul\r\nmove /Y "${tmp}" "${myPath}"\r\ndel "%~f0"\r\n`,
      'utf8');
    process.stdout.write(fmt.ok('  staged swap; restart `horizon` to use the new version') + '\n');
    // Spawn the swap script detached so it runs after we exit
    const { spawn } = require('child_process');
    spawn('cmd.exe', ['/c', swap], { detached: true, stdio: 'ignore', shell: true }).unref();
  } else {
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, myPath);
    process.stdout.write(fmt.ok('  installed — next `horizon` runs the new version') + '\n');
  }
  return 0;
}

async function updateFromSource(runtime, flags) {
  const { execSync } = require('child_process');
  const repoDir = path.join(__dirname, '..', '..', '..');

  if (flags.backup) {
    const dest = backupUserData(runtime.userDataDir);
    process.stdout.write(fmt.ok('  backed up to ' + dest) + '\n');
  }

  process.stdout.write(fmt.dim('  git fetch origin main…\n'));
  try {
    execSync('git fetch --quiet origin main', { cwd: repoDir, stdio: 'inherit' });
    execSync('git reset --hard --quiet origin/main', { cwd: repoDir, stdio: 'inherit' });
  } catch (e) {
    process.stderr.write(fmt.err('git pull failed: ' + e.message) + '\n');
    return 1;
  }
  process.stdout.write(fmt.dim('  npm ci --omit=dev…\n'));
  try {
    execSync('npm ci --omit=dev --silent', { cwd: repoDir, stdio: 'inherit' });
  } catch (e) {
    process.stderr.write(fmt.err('npm ci failed: ' + e.message) + '\n');
    return 1;
  }
  process.stdout.write(fmt.ok('  source updated') + '\n');
  return 0;
}

module.exports = { run };

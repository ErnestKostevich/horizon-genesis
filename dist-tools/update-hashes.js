#!/usr/bin/env node
// dist-tools/update-hashes.js
//
// After a new CLI release tag is cut (e.g. `cli-v0.0.2`), this script:
//   1. Hits the GitHub API for that release's assets.
//   2. Downloads each binary into a temp dir (or reuses --local files).
//   3. Computes SHA256 for each.
//   4. Rewrites the Homebrew formula + Scoop manifest in place,
//      replacing both the `version` field and the per-arch `sha256`/`hash`
//      values.
//
// The output of this script is what gets committed into the separate
// tap / bucket repos.
//
// Usage:
//   node dist-tools/update-hashes.js --tag cli-v0.0.2
//   node dist-tools/update-hashes.js --tag cli-v0.0.2 --local ./dist-cli
//   node dist-tools/update-hashes.js --tag cli-v0.0.2 --dry-run
//
// Flags:
//   --tag <name>     GitHub release tag (default: read from horizon-genesis
//                    package.json version, prefixed with `cli-v`).
//   --local <dir>    Skip the GitHub API; hash binaries from this local
//                    directory instead. Useful for testing before pushing
//                    a release. Expects file names:
//                      horizon-macos-arm64
//                      horizon-macos-x64
//                      horizon-linux-x64
//                      horizon-win-x64.exe
//   --dry-run        Compute hashes and log diffs, but don't write files.
//
// Requires Node 20+ (uses native fetch + node:crypto).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const HOST_PKG = require(path.join(ROOT, 'package.json'));

const args = parseArgs(process.argv.slice(2));
const DRY = !!args['dry-run'];

const TAG = args.tag || `cli-v${HOST_PKG.version}`;
const VERSION = TAG.replace(/^cli-v/, '');

const BREW_FORMULA = path.join(__dirname, 'homebrew-tap', 'Formula', 'horizon.rb');
const SCOOP_MANIFEST = path.join(__dirname, 'scoop-bucket', 'horizon.json');

// Asset filename -> { brewPlaceholder, scoopArch }
// Order in this map mirrors the order the formulas reference them.
const ASSETS = {
  'horizon-macos-arm64':  { brewPlaceholder: 'SHA256_PLACEHOLDER_ARM64',  scoopArch: null   },
  'horizon-macos-x64':    { brewPlaceholder: 'SHA256_PLACEHOLDER_X64',    scoopArch: null   },
  'horizon-linux-x64':    { brewPlaceholder: 'SHA256_PLACEHOLDER_LINUX',  scoopArch: null   },
  'horizon-win-x64.exe':  { brewPlaceholder: null,                         scoopArch: '64bit'},
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function log(...a) { process.stdout.write(a.join(' ') + '\n'); }

async function sha256Of(filepath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filepath);
    s.on('error', reject);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function downloadAsset(downloadUrl, dst) {
  log('  downloading', downloadUrl);
  const res = await fetch(downloadUrl, {
    redirect: 'follow',
    headers: { 'User-Agent': 'horizon-update-hashes' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${downloadUrl}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dst, buf);
  return dst;
}

async function hashFromGithub(tag) {
  log('fetching release', tag, 'from GitHub');
  const apiUrl = `https://api.github.com/repos/ErnestKostevich/horizon-genesis/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetch(apiUrl, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'horizon-update-hashes',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} for tag ${tag}; check the release exists and is public`);
  }
  const release = await res.json();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-hash-'));
  const out = {};
  for (const name of Object.keys(ASSETS)) {
    const asset = (release.assets || []).find(a => a.name === name);
    if (!asset) {
      log(`  skip ${name}: not in release ${tag}`);
      continue;
    }
    const dst = path.join(tmp, name);
    await downloadAsset(asset.browser_download_url, dst);
    out[name] = await sha256Of(dst);
    log(`  sha256(${name}) = ${out[name]}`);
  }
  return out;
}

async function hashFromLocal(dir) {
  log('hashing local binaries from', dir);
  const out = {};
  for (const name of Object.keys(ASSETS)) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) {
      log(`  skip ${name}: not present locally`);
      continue;
    }
    out[name] = await sha256Of(p);
    log(`  sha256(${name}) = ${out[name]}`);
  }
  return out;
}

function rewriteBrewFormula(version, hashes) {
  let txt = fs.readFileSync(BREW_FORMULA, 'utf8');
  const before = txt;

  // version "..."
  txt = txt.replace(/version "[^"]*"/, `version "${version}"`);

  // URL paths point at the cli-v<version> tag
  txt = txt.replace(
    /releases\/download\/cli-v[^\/]+\/horizon-/g,
    `releases/download/cli-v${version}/horizon-`,
  );

  for (const [name, meta] of Object.entries(ASSETS)) {
    if (!meta.brewPlaceholder) continue;
    const newHash = hashes[name];
    if (!newHash) continue;
    // Replace either the original placeholder OR a prior hex hash.
    // The brew formula's per-arch sha256 lines are scoped inside on_arm/on_intel/on_linux
    // blocks that reference the matching url path, so a textual replace is safe
    // as long as we use unique placeholders. After the first run the placeholders
    // are gone -- we then match by the asset's URL line + the next sha256.
    if (txt.includes(meta.brewPlaceholder)) {
      txt = txt.replace(meta.brewPlaceholder, newHash);
    } else {
      // Replace the sha256 line that immediately follows the asset's URL.
      const re = new RegExp(
        `(url "[^"]*${name.replace(/[.+\\-]/g, m => '\\' + m)}"\\s*\\n\\s*sha256 ")[0-9a-f]{64}(")`,
      );
      txt = txt.replace(re, `$1${newHash}$2`);
    }
  }

  if (txt === before) {
    log('  brew formula: no change');
    return;
  }
  if (DRY) {
    log('  brew formula: WOULD update', path.relative(ROOT, BREW_FORMULA));
  } else {
    fs.writeFileSync(BREW_FORMULA, txt, 'utf8');
    log('  brew formula: updated', path.relative(ROOT, BREW_FORMULA));
  }
}

function rewriteScoopManifest(version, hashes) {
  const json = JSON.parse(fs.readFileSync(SCOOP_MANIFEST, 'utf8'));
  json.version = version;

  for (const [name, meta] of Object.entries(ASSETS)) {
    if (!meta.scoopArch) continue;
    const newHash = hashes[name];
    if (!newHash) continue;
    if (json.architecture && json.architecture[meta.scoopArch]) {
      json.architecture[meta.scoopArch].url = json.architecture[meta.scoopArch].url
        .replace(/releases\/download\/cli-v[^\/]+\//, `releases/download/cli-v${version}/`);
      json.architecture[meta.scoopArch].hash = newHash;
    }
  }

  const out = JSON.stringify(json, null, 2) + '\n';
  if (DRY) {
    log('  scoop manifest: WOULD update', path.relative(ROOT, SCOOP_MANIFEST));
  } else {
    fs.writeFileSync(SCOOP_MANIFEST, out, 'utf8');
    log('  scoop manifest: updated', path.relative(ROOT, SCOOP_MANIFEST));
  }
}

(async function main() {
  log(`update-hashes: tag=${TAG} version=${VERSION} ${DRY ? '[dry-run]' : ''}`);

  let hashes;
  if (args.local) {
    hashes = await hashFromLocal(path.resolve(args.local));
  } else {
    hashes = await hashFromGithub(TAG);
  }

  if (!Object.keys(hashes).length) {
    log('no assets hashed; nothing to write');
    process.exit(0);
  }

  rewriteBrewFormula(VERSION, hashes);
  rewriteScoopManifest(VERSION, hashes);
  log('done');
})().catch(e => {
  process.stderr.write('[err] ' + (e?.stack || e?.message || String(e)) + '\n');
  process.exit(1);
});

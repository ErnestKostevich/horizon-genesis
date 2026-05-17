#!/usr/bin/env node
'use strict';
/**
 * detect-runner.js — Horizon "write-test" skill helper.
 *
 * Reads package.json from the given root and reports the detected test
 * runner so the agent can pick the right scaffolding template.
 *
 * Args (stdin JSON): { root: string }
 * Output: { ok, runner: "vitest"|"jest"|"none", configFile?, testDir? }
 */

const fs = require('fs');
const path = require('path');

function readStdinJson() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve({});
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    setTimeout(() => resolve({}), 2000);
  });
}

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function detect(root) {
  const pkgPath = path.join(root, 'package.json');
  if (!fileExists(pkgPath)) return { runner: 'none', reason: 'no package.json at root' };
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); }
  catch (e) { return { runner: 'none', reason: 'package.json invalid: ' + e.message }; }
  const deps = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };

  const configCandidates = {
    vitest: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs'],
    jest: ['jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs'],
  };

  if (deps.vitest) {
    const cfg = configCandidates.vitest.find(f => fileExists(path.join(root, f)));
    return { runner: 'vitest', configFile: cfg || null, testDir: null };
  }
  if (deps.jest || deps['ts-jest']) {
    const cfg = configCandidates.jest.find(f => fileExists(path.join(root, f)));
    const testDir = fileExists(path.join(root, '__tests__')) ? '__tests__' : null;
    return { runner: 'jest', configFile: cfg || null, testDir };
  }
  if (pkg.scripts?.test && /vitest/.test(pkg.scripts.test)) {
    return { runner: 'vitest', configFile: null, testDir: null, note: 'inferred from package.json scripts' };
  }
  if (pkg.scripts?.test && /jest/.test(pkg.scripts.test)) {
    return { runner: 'jest', configFile: null, testDir: null, note: 'inferred from package.json scripts' };
  }
  return { runner: 'none', reason: 'no vitest or jest in dependencies' };
}

(async () => {
  const args = await readStdinJson();
  const root = String(args.root || process.cwd());
  const detected = detect(root);
  process.stdout.write(JSON.stringify({ ok: true, root, ...detected }, null, 2));
})();

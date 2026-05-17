#!/usr/bin/env node
'use strict';
/**
 * find-class-components.js — Horizon "refactor-react" skill helper.
 *
 * Walks a directory looking for files that declare a React class component
 * (matches `class X extends React.Component` and `class X extends Component`).
 *
 * Args (read from stdin as JSON, see HORIZON_SKILL_ARGS env var as fallback):
 *   { root: string, exts?: string[], maxFiles?: number }
 *
 * Output: JSON `{ files: [{ path, className, line }], scanned: N }` on stdout.
 */

const fs = require('fs');
const path = require('path');

function readStdinJson() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve({});
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); }
    });
    // Safety: don't wait forever for stdin in environments that send EOF lazily.
    setTimeout(() => resolve({}), 2000);
  });
}

const DEFAULT_EXTS = ['.js', '.jsx', '.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage']);
const CLASS_RE = /class\s+(\w+)\s+extends\s+(?:React\.)?(?:Pure)?Component\b/;

function walk(dir, exts, maxFiles, out) {
  if (out.length >= maxFiles) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const ent of entries) {
    if (out.length >= maxFiles) return;
    if (ent.name.startsWith('.')) {
      if (SKIP_DIRS.has(ent.name) || ent.name === '.next') continue;
    }
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(full, exts, maxFiles, out);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (!exts.includes(ext)) continue;
      let content;
      try { content = fs.readFileSync(full, 'utf8'); }
      catch { continue; }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(CLASS_RE);
        if (m) {
          out.push({ path: full, className: m[1], line: i + 1 });
        }
      }
    }
  }
}

(async () => {
  const args = await readStdinJson();
  const root = String(args.root || process.cwd());
  const exts = Array.isArray(args.exts) && args.exts.length ? args.exts : DEFAULT_EXTS;
  const maxFiles = Math.max(1, Math.min(2000, Number(args.maxFiles) || 500));
  const out = [];
  try {
    walk(root, exts, maxFiles, out);
    process.stdout.write(JSON.stringify({ ok: true, files: out, scanned: out.length, root }, null, 2));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
})();

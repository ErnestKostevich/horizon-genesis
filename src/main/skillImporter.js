'use strict';
/**
 * Horizon Skills — federated importer.
 *
 * One door for users to pull a skill in from anywhere:
 *
 *   horizon skill import <source>
 *
 * where <source> can be:
 *   - https://agentskills.io/skills/<id>          (community hub)
 *   - https://clawhub.ai/skills/<id>              (ClawHub)
 *   - https://hermes-skills.dev/<id>              (Hermes Skills Hub)
 *   - https://raw.githubusercontent.com/.../SKILL.md
 *   - https://github.com/<owner>/<repo>           (auto-rewrite to raw)
 *   - https://github.com/<owner>/<repo>/tree/<ref>/<dir>
 *   - /path/to/SKILL.md                           (local file)
 *   - /path/to/skill-dir                          (local directory)
 *
 * The flow is always: fetch → parse → scan → report → (caller confirms) →
 * install. This module owns the first four steps; it returns a result
 * object that the CLI/TUI layer renders and then hands back to
 * SkillsManager.installFromBundle when the user confirms.
 *
 * Why we don't auto-install: even a "low risk" scan can miss novel
 * attacks. Treat every import as untrusted input until the user has
 * eyeballed the report.
 */

const fs = require('fs');
const path = require('path');
const { parseSkillMd, NAME_RE } = require('./skillsParser');
const { scanSkill } = require('./skillScanner');

// `node-fetch` is in the dep tree already (v2.x — see package.json).
// We require it lazily so unit tests that don't hit the network can
// avoid loading it.
let _fetch = null;
function getFetch() {
  if (_fetch) return _fetch;
  try {
    // Node 18+ has a global fetch; prefer that for cold-start cost.
    if (typeof globalThis.fetch === 'function') {
      _fetch = globalThis.fetch.bind(globalThis);
    } else {
      _fetch = require('node-fetch');
    }
  } catch (e) {
    throw new Error('No fetch implementation available (need node-fetch or Node 18+)');
  }
  return _fetch;
}

const MAX_FETCH_BYTES = 1 * 1024 * 1024; // 1 MB — generous for a SKILL.md
const FETCH_TIMEOUT_MS = 15_000;

// ── Source type detection ────────────────────────────────────────────

function detectSourceType(source) {
  const s = String(source || '').trim();
  if (!s) return { kind: 'invalid', reason: 'empty source' };
  if (/^https?:\/\//i.test(s)) {
    let host = '';
    try { host = new URL(s).hostname.toLowerCase(); } catch (_) {
      return { kind: 'invalid', reason: 'malformed URL' };
    }
    if (/(?:^|\.)agentskills\.io$/.test(host))      return { kind: 'url', host: 'agentskills.io', url: s };
    if (/(?:^|\.)clawhub\.ai$/.test(host))           return { kind: 'url', host: 'clawhub.ai', url: s };
    if (/hermes-?skills/.test(host))                 return { kind: 'url', host: 'hermes-skills', url: s };
    if (/(?:^|\.)github\.com$/.test(host))           return { kind: 'github', host: 'github.com', url: s };
    if (/(?:^|\.)githubusercontent\.com$/.test(host))return { kind: 'url', host: 'github-raw', url: s };
    return { kind: 'url', host, url: s };
  }
  // Local path
  if (fs.existsSync(s)) {
    try {
      const st = fs.statSync(s);
      if (st.isDirectory()) return { kind: 'dir', path: s };
      if (st.isFile()) return { kind: 'file', path: s };
    } catch (_) {}
  }
  // Path-shaped but missing — let the fetch step error explicitly.
  if (s.includes('/') || s.includes('\\') || /\.(?:md|skill|zip)$/i.test(s)) {
    return { kind: 'file', path: s, missing: true };
  }
  return { kind: 'invalid', reason: 'not a URL or existing path: ' + s };
}

/**
 * GitHub URL → raw URL rewrite.
 *   https://github.com/foo/bar                   → assume default branch + SKILL.md
 *   https://github.com/foo/bar/blob/main/x.md    → raw.githubusercontent.com/foo/bar/main/x.md
 *   https://github.com/foo/bar/tree/main/sub     → raw + assume sub/SKILL.md
 */
function rewriteGithubUrl(url) {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(?:blob|tree)\/([^/]+)(?:\/(.+))?)?\/?$/i);
  if (!m) return null;
  const [, owner, repoRaw, ref = 'main', subPath = ''] = m;
  const repo = repoRaw.replace(/\.git$/, '');
  if (!subPath || subPath.endsWith('/')) {
    // Repo root or directory tree — guess SKILL.md at that path.
    const dir = subPath.replace(/\/$/, '');
    const filePath = dir ? `${dir}/SKILL.md` : 'SKILL.md';
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
  }
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${subPath}`;
}

// ── Fetch helpers ────────────────────────────────────────────────────

async function fetchUrl(url, opts = {}) {
  const fetchImpl = getFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'horizon-skill-importer/1.0',
        Accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.5',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText} — ${url}`);
  }
  // Length check via header first (cheap), then enforce on read.
  const lenHdr = parseInt(res.headers.get('content-length') || '0', 10) || 0;
  if (lenHdr > MAX_FETCH_BYTES) {
    throw new Error(`remote file too large (${lenHdr} bytes, limit ${MAX_FETCH_BYTES})`);
  }
  const text = await res.text();
  if (text.length > MAX_FETCH_BYTES) {
    throw new Error(`remote file too large after read (${text.length} bytes, limit ${MAX_FETCH_BYTES})`);
  }
  return text;
}

async function fetchFile(filePath) {
  const st = fs.statSync(filePath);
  if (st.size > MAX_FETCH_BYTES) {
    throw new Error(`file too large (${st.size} bytes, limit ${MAX_FETCH_BYTES})`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

async function fetchDirectory(dirPath) {
  // Pick up SKILL.md plus any helpers/ and reference/ subfiles.
  const skillFile = path.join(dirPath, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    throw new Error(`no SKILL.md found in ${dirPath}`);
  }
  const content = await fetchFile(skillFile);
  const bundle = { content, helpers: [], references: [] };
  const helpersDir = path.join(dirPath, 'helpers');
  if (fs.existsSync(helpersDir)) {
    for (const entry of fs.readdirSync(helpersDir)) {
      const full = path.join(helpersDir, entry);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && st.size < MAX_FETCH_BYTES) {
          bundle.helpers.push({ path: `helpers/${entry}`, content: fs.readFileSync(full, 'utf8') });
        }
      } catch (_) {}
    }
  }
  const refDir = path.join(dirPath, 'reference');
  if (fs.existsSync(refDir)) {
    for (const entry of fs.readdirSync(refDir)) {
      const full = path.join(refDir, entry);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && st.size < MAX_FETCH_BYTES) {
          bundle.references.push({ path: `reference/${entry}`, content: fs.readFileSync(full, 'utf8') });
        }
      } catch (_) {}
    }
  }
  return bundle;
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Fetch a SKILL.md from the given source, parse it, run the security
 * scanner, and return a unified report. Never installs — that's the
 * caller's job after the user confirms.
 *
 * @param {string} source — URL or path (see file header for formats)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{
 *   ok: boolean,
 *   source: string,
 *   sourceKind: string,
 *   resolvedUrl: string | null,
 *   skill: { id, frontmatter, body, content } | null,
 *   bundle: { frontmatter, body, helpers, references } | null,
 *   scanReport: { risk, findings, summary } | null,
 *   parseErrors: string[],
 *   error: string | null
 * }>}
 */
async function importSkill(source, opts = {}) {
  const detected = detectSourceType(source);
  const baseResult = {
    ok: false,
    source: String(source || ''),
    sourceKind: detected.kind,
    resolvedUrl: null,
    skill: null,
    bundle: null,
    scanReport: null,
    parseErrors: [],
    error: null,
  };

  if (detected.kind === 'invalid') {
    return { ...baseResult, error: detected.reason };
  }

  let content;
  let helpers = [];
  let references = [];
  let resolvedUrl = null;

  try {
    if (detected.kind === 'github') {
      resolvedUrl = rewriteGithubUrl(detected.url);
      if (!resolvedUrl) throw new Error(`could not rewrite GitHub URL to raw: ${detected.url}`);
      content = await fetchUrl(resolvedUrl, opts);
    } else if (detected.kind === 'url') {
      resolvedUrl = detected.url;
      content = await fetchUrl(detected.url, opts);
    } else if (detected.kind === 'file') {
      if (detected.missing) throw new Error(`file not found: ${detected.path}`);
      content = await fetchFile(detected.path);
    } else if (detected.kind === 'dir') {
      const dirBundle = await fetchDirectory(detected.path);
      content = dirBundle.content;
      helpers = dirBundle.helpers;
      references = dirBundle.references;
    } else {
      throw new Error('unsupported source kind: ' + detected.kind);
    }
  } catch (e) {
    return { ...baseResult, resolvedUrl, error: e.message };
  }

  // Parse the SKILL.md.
  const parsed = parseSkillMd(content);
  const parseErrors = parsed.errors || [];
  if (!parsed.frontmatter || !parsed.frontmatter.name) {
    return {
      ...baseResult,
      resolvedUrl,
      parseErrors,
      error: parseErrors[0] || 'SKILL.md missing required `name` field',
    };
  }
  const id = String(parsed.frontmatter.name);
  if (!NAME_RE.test(id)) {
    return {
      ...baseResult,
      resolvedUrl,
      parseErrors: [...parseErrors, `name "${id}" is not valid kebab-case (3-60 chars)`],
      error: `invalid skill id: ${id}`,
    };
  }

  // Run scanner over the FULL document (frontmatter + body) — prompt
  // injection often lives in the description field, not the body.
  const scanReport = scanSkill(content, parsed.frontmatter);

  return {
    ok: true,
    source: String(source || ''),
    sourceKind: detected.kind,
    resolvedUrl,
    skill: {
      id,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      content,
    },
    bundle: {
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      helpers,
      references,
    },
    scanReport,
    parseErrors,
    error: null,
  };
}

module.exports = {
  importSkill,
  detectSourceType,
  rewriteGithubUrl,
  // Exposed for tests
  MAX_FETCH_BYTES,
};

'use strict';
/**
 * Horizon Skills — lifecycle manager
 *
 * Mirrors PluginManager but for Claude Code-style skill bundles. A skill is:
 *   <dir>/
 *     SKILL.md         (YAML frontmatter + body)
 *     helpers/*.{js,py} (optional — runnable through skill_run_helper tool)
 *     reference/*.md   (optional — extra context for power-user skills)
 *
 * Three scopes (resolved in this priority order — high wins on duplicate id):
 *   1. workspace — <workspaceRoot>/.horizon/skills/<id>/
 *   2. user      — <userData>/skills/<id>/             (installed from marketplace + manual)
 *   3. builtin   — <appResources>/builtin-skills/<id>/ (ships with the app)
 *
 * Public API mirrors PluginManager so chat-skills.js can copy chat-plugin-hub.js
 * almost line-for-line in Phase 2.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseSkillMd, buildSkillMd, NAME_RE } = require('./skillsParser');
const { selectRelevantSkills } = require('./skillsRelevance');

const MAX_BODY_INJECT_BYTES = 8_000;
const MAX_TOTAL_INJECT_BYTES = 12_000;
const MAX_HELPER_BYTES = 64_000;
const MAX_HELPERS_PER_SKILL = 8;
const VALID_HELPER_EXT = new Set(['.js', '.py', '.mjs', '.cjs']);
const VALID_REFERENCE_EXT = new Set(['.md', '.txt']);

function safeRel(p) {
  // Reject helper paths that escape the skill dir: no .., no absolute.
  if (typeof p !== 'string') return null;
  const norm = p.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!norm) return null;
  if (norm.includes('..')) return null;
  if (path.isAbsolute(norm)) return null;
  return norm;
}

function listHelperFiles(skillDir) {
  const out = [];
  const helpersDir = path.join(skillDir, 'helpers');
  if (!fs.existsSync(helpersDir)) return out;
  try {
    for (const entry of fs.readdirSync(helpersDir)) {
      const full = path.join(helpersDir, entry);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (st.size > MAX_HELPER_BYTES) continue;
        const ext = path.extname(entry).toLowerCase();
        if (!VALID_HELPER_EXT.has(ext)) continue;
        out.push({ name: entry, rel: `helpers/${entry}`, size: st.size });
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}

function listReferenceFiles(skillDir) {
  const out = [];
  const refDir = path.join(skillDir, 'reference');
  if (!fs.existsSync(refDir)) return out;
  try {
    for (const entry of fs.readdirSync(refDir)) {
      const full = path.join(refDir, entry);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        const ext = path.extname(entry).toLowerCase();
        if (!VALID_REFERENCE_EXT.has(ext)) continue;
        out.push({ name: entry, rel: `reference/${entry}`, size: st.size });
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}

function readSkillFromDir(dir, scope) {
  const skillFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;
  let raw;
  try { raw = fs.readFileSync(skillFile, 'utf8'); }
  catch (_) { return null; }
  const parsed = parseSkillMd(raw);
  if (!parsed.frontmatter?.name) return null;
  const id = String(parsed.frontmatter.name);
  if (!NAME_RE.test(id)) return null;
  return {
    id,
    scope,                    // 'workspace' | 'user' | 'builtin'
    dir,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    rawFrontmatter: parsed.rawFrontmatter,
    parseOk: parsed.ok,
    parseErrors: parsed.errors || [],
    helpers: listHelperFiles(dir),
    references: listReferenceFiles(dir),
    enabled: true,           // populated from disabled-set below
  };
}

class SkillsManager {
  /**
   * @param {object} opts
   * @param {string} opts.userDir       — <userData>/skills
   * @param {string} opts.builtinDir    — <appResources>/builtin-skills
   * @param {function():string} opts.workspaceProvider — returns current workspace root or ''
   * @param {object} [opts.settingsStore] — electron-store for disabled list
   */
  constructor(opts = {}) {
    this.userDir = opts.userDir;
    this.builtinDir = opts.builtinDir;
    this.workspaceProvider = typeof opts.workspaceProvider === 'function' ? opts.workspaceProvider : () => '';
    this.settingsStore = opts.settingsStore || null;

    this.skills = new Map();   // id → record (best-scope variant kept here)
    this.allScopes = new Map(); // `${scope}:${id}` → record (full list for the UI)
    this.disabled = new Set(this._loadDisabled());
    this._cacheKey = '';

    if (this.userDir && !fs.existsSync(this.userDir)) {
      try { fs.mkdirSync(this.userDir, { recursive: true }); } catch (_) {}
    }
  }

  _loadDisabled() {
    if (!this.settingsStore) return [];
    try {
      const raw = this.settingsStore.get('skills.disabled') || [];
      return Array.isArray(raw) ? raw.map(String) : [];
    } catch (_) { return []; }
  }

  _saveDisabled() {
    if (!this.settingsStore) return;
    try { this.settingsStore.set('skills.disabled', Array.from(this.disabled)); }
    catch (_) {}
  }

  _scanDir(rootDir, scope) {
    const found = [];
    if (!rootDir || !fs.existsSync(rootDir)) return found;
    let entries = [];
    try { entries = fs.readdirSync(rootDir); }
    catch (_) { return found; }
    for (const entry of entries) {
      const full = path.join(rootDir, entry);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch (_) { continue; }
      const rec = readSkillFromDir(full, scope);
      if (rec) found.push(rec);
    }
    return found;
  }

  loadAll() {
    this.skills.clear();
    this.allScopes.clear();

    const workspaceRoot = this.workspaceProvider() || '';
    const workspaceSkillsDir = workspaceRoot ? path.join(workspaceRoot, '.horizon', 'skills') : '';

    // Highest priority first. We add to `skills` map only if not already set
    // for that base id; allScopes always gets every variant.
    const layers = [
      { dir: workspaceSkillsDir, scope: 'workspace' },
      { dir: this.userDir, scope: 'user' },
      { dir: this.builtinDir, scope: 'builtin' },
    ];
    for (const layer of layers) {
      for (const rec of this._scanDir(layer.dir, layer.scope)) {
        rec.enabled = !this.disabled.has(rec.id) && !this.disabled.has(`${rec.scope}:${rec.id}`);
        this.allScopes.set(`${rec.scope}:${rec.id}`, rec);
        if (!this.skills.has(rec.id)) this.skills.set(rec.id, rec);
      }
    }
    this._cacheKey = crypto.randomBytes(4).toString('hex');
    return this.list();
  }

  /**
   * Lightweight check — reloads if any SKILL.md mtime changed since the last
   * loadAll(). Called on every getMatchingSkills() so workspace edits land
   * without an app restart.
   */
  refreshIfStale() {
    // Cheap check: compute a digest of `${scope}:${dir}:${mtime}` across all
    // tracked records. If it matches `_cacheKey`-style hash, skip; else reload.
    let digestSrc = '';
    for (const rec of this.allScopes.values()) {
      try {
        const st = fs.statSync(path.join(rec.dir, 'SKILL.md'));
        digestSrc += `${rec.scope}:${rec.id}:${st.mtimeMs}|`;
      } catch (_) { digestSrc += `${rec.scope}:${rec.id}:gone|`; }
    }
    // Also include workspace root identity — switching workspaces invalidates.
    digestSrc += `ws:${this.workspaceProvider() || ''}`;
    const digest = crypto.createHash('sha1').update(digestSrc).digest('hex').slice(0, 16);
    if (digest !== this._mtimeDigest) {
      this._mtimeDigest = digest;
      this.loadAll();
    }
  }

  list() {
    // Return both per-id (highest-scope wins) AND a full variants list for the UI.
    // The Phase 2 hub will read this; for now skillsList IPC just exposes it.
    const out = [];
    for (const rec of this.allScopes.values()) {
      out.push({
        id: rec.id,
        scope: rec.scope,
        enabled: rec.enabled,
        name: rec.frontmatter.name,
        description: rec.frontmatter.description,
        version: rec.frontmatter.version || '0.1.0',
        tags: rec.frontmatter.tags || [],
        permissions: rec.frontmatter.permissions || [],
        helpers: rec.helpers.map(h => h.rel),
        hasHelpers: rec.helpers.length > 0,
        parseOk: rec.parseOk,
        parseErrors: rec.parseErrors,
        dir: rec.dir,
        active: this.skills.get(rec.id) === rec, // is this the variant used for matching?
      });
    }
    out.sort((a, b) => {
      if (a.id !== b.id) return a.id.localeCompare(b.id);
      const order = { workspace: 0, user: 1, builtin: 2 };
      return (order[a.scope] ?? 9) - (order[b.scope] ?? 9);
    });
    return out;
  }

  get(id) {
    return this.skills.get(id) || null;
  }

  /** Raw SKILL.md text for the editor. Returns '' when not found. */
  readSource(id, scope) {
    const rec = scope
      ? this.allScopes.get(`${scope}:${id}`)
      : this.skills.get(id);
    if (!rec) return '';
    try { return fs.readFileSync(path.join(rec.dir, 'SKILL.md'), 'utf8'); }
    catch (_) { return ''; }
  }

  /**
   * Write a skill source. Workspace + user scopes only — built-ins are read-only.
   * If `scope` is omitted, defaults to user.
   */
  writeSource(id, content, scope) {
    const target = scope || 'user';
    if (target === 'builtin') return { ok: false, error: 'built-in skills are read-only' };
    if (target !== 'workspace' && target !== 'user') return { ok: false, error: 'unknown scope' };

    const parsed = parseSkillMd(content);
    if (!parsed.ok) return { ok: false, error: 'invalid SKILL.md: ' + (parsed.errors || []).join('; ') };
    const newId = String(parsed.frontmatter.name || '');
    if (!NAME_RE.test(newId)) return { ok: false, error: 'frontmatter.name must be kebab-case 3-60 chars' };
    if (id && newId !== id) {
      return { ok: false, error: `frontmatter.name "${newId}" does not match skill id "${id}" — rename via Settings, not in place` };
    }

    let baseDir = '';
    if (target === 'workspace') {
      const ws = this.workspaceProvider();
      if (!ws) return { ok: false, error: 'no active workspace — open a folder first' };
      baseDir = path.join(ws, '.horizon', 'skills', newId);
    } else {
      if (!this.userDir) return { ok: false, error: 'user skills dir not configured' };
      baseDir = path.join(this.userDir, newId);
    }
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      fs.writeFileSync(path.join(baseDir, 'SKILL.md'), String(content), 'utf8');
    } catch (e) {
      return { ok: false, error: 'write failed: ' + e.message };
    }
    this.loadAll();
    return { ok: true, id: newId, scope: target, dir: baseDir };
  }

  /**
   * Install a skill from a bundle object: { frontmatter, body, helpers?, references? }.
   * Used by marketplace installs and share-URL imports. Target scope is always 'user'.
   */
  installFromBundle(bundle, opts = {}) {
    if (!bundle || typeof bundle !== 'object') return { ok: false, error: 'bundle required' };
    const fm = bundle.frontmatter || {};
    const id = String(fm.name || '');
    if (!NAME_RE.test(id)) return { ok: false, error: 'bundle.frontmatter.name invalid (kebab-case, 3-60 chars)' };

    if (!this.userDir) return { ok: false, error: 'user skills dir not configured' };
    const dir = path.join(this.userDir, id);

    // Anti-clobber: refuse to overwrite a workspace skill via a marketplace install
    // (workspace edits are sacred to the user). User-scope overwrite is OK with `force`.
    const existing = this.skills.get(id);
    if (existing && existing.scope === 'workspace' && !opts.force) {
      return { ok: false, error: 'a workspace skill with this id already exists' };
    }
    if (fs.existsSync(dir) && !opts.force) {
      return { ok: false, error: 'a user skill with this id already exists — pass force=true to overwrite' };
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
      const skillMd = buildSkillMd(fm, bundle.body || '');
      fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd, 'utf8');

      const helpers = Array.isArray(bundle.helpers) ? bundle.helpers.slice(0, MAX_HELPERS_PER_SKILL) : [];
      if (helpers.length) fs.mkdirSync(path.join(dir, 'helpers'), { recursive: true });
      for (const h of helpers) {
        const rel = safeRel(h?.path);
        if (!rel || !rel.startsWith('helpers/')) continue;
        const ext = path.extname(rel).toLowerCase();
        if (!VALID_HELPER_EXT.has(ext)) continue;
        const content = String(h.content || '');
        if (content.length > MAX_HELPER_BYTES) continue;
        fs.writeFileSync(path.join(dir, rel), content, 'utf8');
      }
      const references = Array.isArray(bundle.references) ? bundle.references.slice(0, 16) : [];
      if (references.length) fs.mkdirSync(path.join(dir, 'reference'), { recursive: true });
      for (const r of references) {
        const rel = safeRel(r?.path);
        if (!rel || !rel.startsWith('reference/')) continue;
        const ext = path.extname(rel).toLowerCase();
        if (!VALID_REFERENCE_EXT.has(ext)) continue;
        fs.writeFileSync(path.join(dir, rel), String(r.content || ''), 'utf8');
      }
    } catch (e) {
      return { ok: false, error: 'install failed: ' + e.message };
    }

    this.loadAll();
    return { ok: true, id, scope: 'user', dir };
  }

  uninstall(id, scope) {
    const target = scope === 'workspace' ? 'workspace' : 'user';
    const rec = this.allScopes.get(`${target}:${id}`);
    if (!rec) return { ok: false, error: `no ${target}-scope skill "${id}" found` };
    try {
      fs.rmSync(rec.dir, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: 'remove failed: ' + e.message };
    }
    this.loadAll();
    return { ok: true };
  }

  toggleEnable(id, scope) {
    const key = scope ? `${scope}:${id}` : id;
    const wasDisabled = this.disabled.has(key) || this.disabled.has(id);
    if (wasDisabled) {
      this.disabled.delete(key);
      this.disabled.delete(id); // clean legacy global-disable too
    } else {
      this.disabled.add(key);
    }
    this._saveDisabled();
    this.loadAll();
    return { ok: true, enabled: !this.disabled.has(key) };
  }

  /**
   * Resolve a helper path for safe execution by skill_run_helper.
   * Returns absolute path or null when the request is invalid.
   */
  resolveHelperPath(id, helperRel) {
    const rec = this.skills.get(id);
    if (!rec) return null;
    const rel = safeRel(helperRel);
    if (!rel || !rel.startsWith('helpers/')) return null;
    const ext = path.extname(rel).toLowerCase();
    if (!VALID_HELPER_EXT.has(ext)) return null;
    const abs = path.join(rec.dir, rel);
    // Final containment check — abs must live under rec.dir.
    const relCheck = path.relative(rec.dir, abs);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return null;
    if (!fs.existsSync(abs)) return null;
    return { absPath: abs, ext, skillDir: rec.dir, scope: rec.scope };
  }

  /**
   * Pick skills whose description matches the user's query, render them into
   * a single markdown block ready to inject into the system prompt.
   *
   * @returns {{ block: string, selected: object[], scored: object[] }}
   *   block — the markdown string (empty when nothing matched)
   *   selected — chosen entries [{ id, score, breakdown, scope, forced }]
   *   scored — full ranked list (used by the inspector)
   */
  getSkillsBlock(query, opts = {}) {
    this.refreshIfStale();
    const skills = this.list().filter(s => s.active); // only highest-scope variant participates
    const { selected, scored } = selectRelevantSkills(
      skills.map(s => ({
        ...s,
        frontmatter: {
          name: s.name,
          description: s.description,
          tags: s.tags,
        },
      })),
      query,
      opts
    );

    const parts = [];
    let totalBytes = 0;
    for (const entry of selected) {
      const rec = this.skills.get(entry.id);
      if (!rec) continue;
      const header = `### ${rec.frontmatter.name}\n_${rec.frontmatter.description}_\n\n`;
      const bodyFull = (rec.body || '').trim();
      const bodyBudget = Math.min(MAX_BODY_INJECT_BYTES, MAX_TOTAL_INJECT_BYTES - totalBytes - header.length);
      let bodyOut;
      let truncated = false;
      if (bodyBudget <= 200) {
        // No room for body — inject name+desc only so the agent knows the skill exists.
        bodyOut = '_(body omitted — context budget reached; ask the user to invoke this skill explicitly via `/skill ' + rec.id + '`)_';
        truncated = true;
      } else if (bodyFull.length > bodyBudget) {
        bodyOut = bodyFull.slice(0, bodyBudget) + '\n\n_[truncated for context budget]_';
        truncated = true;
      } else {
        bodyOut = bodyFull;
      }
      const helpersNote = rec.helpers.length
        ? `\n\n_Helpers available_ — call the \`skill_run_helper\` tool with \`skill="${rec.id}"\` and one of: ${rec.helpers.map(h => '`' + h.rel + '`').join(', ')}.`
        : '';
      const chunk = header + bodyOut + helpersNote + '\n';
      parts.push(chunk);
      totalBytes += chunk.length;
      entry.truncated = truncated;
      entry.bytes = chunk.length;
    }

    const block = parts.length
      ? parts.join('\n---\n\n').trimEnd()
      : '';

    return { block, selected, scored };
  }

  // ── Share URL helpers (mirror pluginManager.generateShareUrl / installFromShareUrl) ──

  generateShareUrl(id) {
    const rec = this.skills.get(id);
    if (!rec) return null;
    const helpers = [];
    for (const h of rec.helpers) {
      try { helpers.push({ path: h.rel, content: fs.readFileSync(path.join(rec.dir, h.rel), 'utf8') }); }
      catch (_) {}
    }
    const references = [];
    for (const r of rec.references) {
      try { references.push({ path: r.rel, content: fs.readFileSync(path.join(rec.dir, r.rel), 'utf8') }); }
      catch (_) {}
    }
    const bundle = {
      kind: 'horizon-skill',
      version: 1,
      frontmatter: rec.frontmatter,
      body: rec.body,
      helpers,
      references,
    };
    const data = Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64');
    return `horizon://skill/install?data=${data}`;
  }

  installFromShareUrl(url) {
    if (typeof url !== 'string') return { ok: false, error: 'url required' };
    const match = url.match(/[?&]data=([A-Za-z0-9+/=_-]+)/);
    if (!match) return { ok: false, error: 'invalid share URL — missing data param' };
    let bundle;
    try { bundle = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')); }
    catch (e) { return { ok: false, error: 'invalid bundle JSON: ' + e.message }; }
    if (bundle?.kind !== 'horizon-skill') return { ok: false, error: 'not a horizon-skill bundle' };
    return this.installFromBundle(bundle, { force: true });
  }

  /**
   * Copy bundled built-ins (in app resources) into the in-memory map — they
   * are read in place, no file copy needed; the loader picks them up via
   * the builtinDir scan. This method exists only as a parity-with-plugins
   * hook in case we ever need to materialise built-ins to a writable dir.
   */
  installAllBuiltins() {
    if (!this.builtinDir || !fs.existsSync(this.builtinDir)) {
      return { installed: [], skipped: [], failed: [] };
    }
    this.loadAll();
    const installed = [];
    for (const rec of this.allScopes.values()) {
      if (rec.scope === 'builtin') installed.push(rec.id);
    }
    return { installed, skipped: [], failed: [] };
  }
}

module.exports = {
  SkillsManager,
  MAX_BODY_INJECT_BYTES,
  MAX_TOTAL_INJECT_BYTES,
  MAX_HELPERS_PER_SKILL,
  MAX_HELPER_BYTES,
};

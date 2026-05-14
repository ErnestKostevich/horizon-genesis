'use strict';
/**
 * Horizon Project Config (PR-D3)
 * ──────────────────────────────
 * Per-workspace configuration loaded from `.horizon/` at the workspace
 * root. Mirrors the pattern Cursor uses (`.cursor/rules`) and Claude
 * Code uses (`CLAUDE.md` + hooks). Two files today:
 *
 *   .horizon/rules.md      Markdown text injected into the agent's
 *                          system prompt. Use it for project-wide
 *                          conventions ("always TypeScript strict",
 *                          "use lodash-es not lodash", etc).
 *
 *   .horizon/hooks.json    Lifecycle hooks. Shape:
 *                          { onSave: "command",
 *                            onCommit: "command",
 *                            onSend: "command" }
 *                          Each hook runs in the workspace via
 *                          wsShell with a one-time permission gate
 *                          (caller's responsibility — this module
 *                          only loads + serves the values).
 *
 * The renderer reads these via `H.projectConfigGet()` and the agent
 * loop injects `rules.md` content into its system prompt builder.
 */

const fs = require('fs');
const path = require('path');

const RULES_MAX_BYTES = 32_000;   // injection cap so a giant rules.md
                                  // doesn't eat the entire context window
const HOOKS_MAX_BYTES = 16_000;
const VALID_HOOKS = new Set(['onSave', 'onCommit', 'onSend', 'onAgentStart', 'onAgentEnd']);

class ProjectConfig {
  constructor() {
    this.cache = new Map(); // root → { rules, hooks, mtime, loadedAt }
  }

  _paths(root) {
    const dir = path.join(root, '.horizon');
    return {
      dir,
      rules: path.join(dir, 'rules.md'),
      hooks: path.join(dir, 'hooks.json'),
    };
  }

  /**
   * Load (or refresh) the project config for the given workspace root.
   * Cheap fs.statSync mtime check — re-reads only when files change.
   * @returns {object} { rules, hooks, exists, errors }
   */
  load(root) {
    if (!root || typeof root !== 'string') {
      return { rules: '', hooks: {}, exists: false, errors: ['root path required'] };
    }
    const paths = this._paths(root);
    let dirExists = false;
    try { dirExists = fs.existsSync(paths.dir) && fs.statSync(paths.dir).isDirectory(); }
    catch (_) { dirExists = false; }
    if (!dirExists) {
      return { rules: '', hooks: {}, exists: false, errors: [] };
    }
    const errors = [];
    let rules = '';
    let hooks = {};
    let mtime = 0;
    // rules.md
    try {
      if (fs.existsSync(paths.rules)) {
        const stat = fs.statSync(paths.rules);
        mtime = Math.max(mtime, stat.mtimeMs);
        if (stat.size > RULES_MAX_BYTES) {
          errors.push(`rules.md is ${stat.size} bytes — capped at ${RULES_MAX_BYTES} for context-safety. Truncating.`);
        }
        const fd = fs.openSync(paths.rules, 'r');
        try {
          const buf = Buffer.alloc(Math.min(stat.size, RULES_MAX_BYTES));
          fs.readSync(fd, buf, 0, buf.length, 0);
          rules = buf.toString('utf8');
        } finally { fs.closeSync(fd); }
      }
    } catch (e) { errors.push('rules.md read failed: ' + e.message); }
    // hooks.json
    try {
      if (fs.existsSync(paths.hooks)) {
        const stat = fs.statSync(paths.hooks);
        mtime = Math.max(mtime, stat.mtimeMs);
        if (stat.size > HOOKS_MAX_BYTES) {
          errors.push(`hooks.json is ${stat.size} bytes — refusing to load (>${HOOKS_MAX_BYTES})`);
        } else {
          const raw = fs.readFileSync(paths.hooks, 'utf8');
          let parsed;
          try { parsed = JSON.parse(raw); }
          catch (parseErr) { errors.push('hooks.json invalid JSON: ' + parseErr.message); parsed = {}; }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const k of Object.keys(parsed)) {
              if (!VALID_HOOKS.has(k)) {
                errors.push(`hooks.json: unknown hook "${k}" (valid: ${[...VALID_HOOKS].join(', ')})`);
                continue;
              }
              const v = parsed[k];
              if (typeof v !== 'string' || !v.trim()) {
                errors.push(`hooks.json: hook "${k}" must be a non-empty string command`);
                continue;
              }
              if (v.length > 1000) {
                errors.push(`hooks.json: hook "${k}" command too long (>1000 chars), skipping`);
                continue;
              }
              hooks[k] = v.trim();
            }
          }
        }
      }
    } catch (e) { errors.push('hooks.json read failed: ' + e.message); }

    const entry = { rules, hooks, exists: true, mtime, loadedAt: Date.now(), errors };
    this.cache.set(root, entry);
    return entry;
  }

  /** Returns cached config if fresh (mtime unchanged); reloads otherwise. */
  get(root) {
    const cached = this.cache.get(root);
    if (cached) {
      // Cheap freshness check — stat both files, compare mtime.
      try {
        const paths = this._paths(root);
        let mtime = 0;
        if (fs.existsSync(paths.rules)) mtime = Math.max(mtime, fs.statSync(paths.rules).mtimeMs);
        if (fs.existsSync(paths.hooks)) mtime = Math.max(mtime, fs.statSync(paths.hooks).mtimeMs);
        if (mtime === cached.mtime) return cached;
      } catch (_) { /* fall through to reload */ }
    }
    return this.load(root);
  }

  /**
   * Build the markdown block to inject into the agent's system prompt.
   * Returns empty string when no rules.md exists. Wrapped with
   * fence markers so the LLM can clearly see the boundary.
   */
  buildSystemBlock(root) {
    const cfg = this.get(root);
    if (!cfg.exists || !cfg.rules.trim()) return '';
    return `\n\n## Project rules (.horizon/rules.md)\n\n${cfg.rules.trim()}\n`;
  }

  /** Look up a single hook command. Returns '' when not configured. */
  getHook(root, hookName) {
    if (!VALID_HOOKS.has(hookName)) return '';
    const cfg = this.get(root);
    return (cfg.exists && cfg.hooks[hookName]) || '';
  }

  /** Write rules.md (creates .horizon/ if missing). */
  writeRules(root, content) {
    if (!root) return { ok: false, error: 'root path required' };
    const paths = this._paths(root);
    try {
      if (!fs.existsSync(paths.dir)) fs.mkdirSync(paths.dir, { recursive: true });
      const text = String(content || '');
      if (text.length > RULES_MAX_BYTES) {
        return { ok: false, error: `rules.md too large (${text.length} > ${RULES_MAX_BYTES})` };
      }
      fs.writeFileSync(paths.rules, text, 'utf8');
      this.cache.delete(root);
      return { ok: true, path: paths.rules, bytes: Buffer.byteLength(text, 'utf8') };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /** Write hooks.json (validates first). */
  writeHooks(root, hooks) {
    if (!root) return { ok: false, error: 'root path required' };
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
      return { ok: false, error: 'hooks must be an object' };
    }
    const cleaned = {};
    for (const [k, v] of Object.entries(hooks)) {
      if (!VALID_HOOKS.has(k)) continue;
      if (typeof v !== 'string' || !v.trim() || v.length > 1000) continue;
      cleaned[k] = v.trim();
    }
    const paths = this._paths(root);
    try {
      if (!fs.existsSync(paths.dir)) fs.mkdirSync(paths.dir, { recursive: true });
      fs.writeFileSync(paths.hooks, JSON.stringify(cleaned, null, 2), 'utf8');
      this.cache.delete(root);
      return { ok: true, path: paths.hooks, hooks: cleaned };
    } catch (e) { return { ok: false, error: e.message }; }
  }
}

module.exports = { ProjectConfig, VALID_HOOKS };

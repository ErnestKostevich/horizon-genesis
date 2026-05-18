'use strict';
/**
 * Horizon Workspace Memory (PHASE 8/8) — committable team knowledge.
 *
 * Lives at `<workspaceRoot>/.horizon/memory.json`. Unlike AgentMemory
 * (per-user, in userData), this file is meant to be committed to git so
 * a whole team shares the same conventions, glossary, and decisions.
 * Open the project → Horizon auto-loads → all team members benefit.
 *
 * Schema is intentionally simple: humans should be able to edit the JSON
 * in any editor without breaking anything. No timestamps required, no
 * IDs to keep stable, no embeddings — just structured prose.
 *
 *   {
 *     "version": 1,
 *     "workspace": {"name": "...", "owner": "..."},
 *     "conventions": [{"rule": "...", "examples": ["..."]}],
 *     "glossary":    {"ACRONYM": "definition"},
 *     "decisions":   [{"date": "YYYY-MM-DD", "summary": "...", "link": "..."}],
 *     "do_not":      ["never push to main directly", "..."]
 *   }
 *
 * Loaded on workspace open via projectConfig pattern; injected into the
 * agent's system prompt by agentLoop right after `.horizon/rules.md`.
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024;     // 256 KB hard cap — protects context
const MAX_INJECTION_CHARS = 12000; // truncate when injecting into prompt
const VALID_TYPE_KEYS = ['conventions', 'glossary', 'decisions', 'do_not'];

const EMPTY_SHAPE = Object.freeze({
  version: 1,
  workspace: {},
  conventions: [],
  glossary: {},
  decisions: [],
  do_not: [],
});

class WorkspaceMemory {
  constructor() {
    this.cache = new Map(); // root → { data, mtime, loadedAt, errors }
  }

  _paths(root) {
    const dir = path.join(root, '.horizon');
    return { dir, file: path.join(dir, 'memory.json') };
  }

  load(root) {
    if (!root || typeof root !== 'string') {
      return { ...EMPTY_SHAPE, exists: false, errors: ['root path required'] };
    }
    const { file } = this._paths(root);
    if (!fs.existsSync(file)) {
      return { ...EMPTY_SHAPE, exists: false, errors: [] };
    }
    const errors = [];
    let data = { ...EMPTY_SHAPE };
    let mtime = 0;
    try {
      const stat = fs.statSync(file);
      mtime = stat.mtimeMs;
      if (stat.size > MAX_BYTES) {
        errors.push(`memory.json is ${stat.size} bytes — capped at ${MAX_BYTES}`);
      } else {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          data.version = Number(parsed.version) || 1;
          data.workspace = (parsed.workspace && typeof parsed.workspace === 'object') ? parsed.workspace : {};
          data.conventions = Array.isArray(parsed.conventions) ? parsed.conventions.slice(0, 200) : [];
          data.glossary = (parsed.glossary && typeof parsed.glossary === 'object' && !Array.isArray(parsed.glossary)) ? parsed.glossary : {};
          data.decisions = Array.isArray(parsed.decisions) ? parsed.decisions.slice(0, 200) : [];
          data.do_not = Array.isArray(parsed.do_not) ? parsed.do_not.slice(0, 100) : [];
        } else {
          errors.push('memory.json must be a JSON object');
        }
      }
    } catch (e) { errors.push('memory.json read failed: ' + e.message); }

    const entry = { ...data, exists: true, mtime, loadedAt: Date.now(), errors };
    this.cache.set(root, entry);
    return entry;
  }

  get(root) {
    const cached = this.cache.get(root);
    if (cached) {
      try {
        const { file } = this._paths(root);
        if (fs.existsSync(file)) {
          const stat = fs.statSync(file);
          if (stat.mtimeMs === cached.mtime) return cached;
        } else if (!cached.exists) {
          return cached;
        }
      } catch (_) {}
    }
    return this.load(root);
  }

  /**
   * Render the workspace memory as a markdown block ready to inject
   * into the agent's system prompt. Empty string when no file or all
   * sections empty. Truncated to MAX_INJECTION_CHARS overall.
   */
  buildSystemBlock(root) {
    const data = this.get(root);
    if (!data.exists) return '';
    const lines = [];
    if (data.workspace?.name) lines.push(`- Workspace: ${data.workspace.name}${data.workspace.owner ? ` (${data.workspace.owner})` : ''}`);
    if (Array.isArray(data.conventions) && data.conventions.length) {
      lines.push('', '### Conventions');
      for (const c of data.conventions.slice(0, 40)) {
        if (typeof c === 'string') lines.push(`- ${c}`);
        else if (c?.rule) lines.push(`- ${c.rule}${Array.isArray(c.examples) && c.examples.length ? ` _(e.g. ${c.examples.slice(0, 2).map(e => '`' + e + '`').join(', ')})_` : ''}`);
      }
    }
    if (data.glossary && Object.keys(data.glossary).length) {
      lines.push('', '### Glossary');
      for (const [k, v] of Object.entries(data.glossary).slice(0, 30)) lines.push(`- **${k}** — ${v}`);
    }
    if (Array.isArray(data.do_not) && data.do_not.length) {
      lines.push('', '### Do NOT');
      for (const r of data.do_not.slice(0, 20)) lines.push(`- ${r}`);
    }
    if (Array.isArray(data.decisions) && data.decisions.length) {
      lines.push('', '### Recent decisions');
      for (const d of data.decisions.slice(-10).reverse()) {
        if (typeof d === 'string') lines.push(`- ${d}`);
        else if (d?.summary) lines.push(`- ${d.date ? `(${d.date}) ` : ''}${d.summary}${d.link ? ` — ${d.link}` : ''}`);
      }
    }
    if (!lines.length) return '';
    const body = lines.join('\n');
    const truncated = body.length > MAX_INJECTION_CHARS
      ? body.slice(0, MAX_INJECTION_CHARS) + '\n\n_[workspace memory truncated for context]_'
      : body;
    return `\n\n## Workspace memory (.horizon/memory.json)\n\n${truncated}\n`;
  }

  write(root, partial) {
    if (!root) return { ok: false, error: 'root path required' };
    const { dir, file } = this._paths(root);
    const current = this.get(root);
    const next = {
      version: Number(partial?.version) || current.version || 1,
      workspace: (partial?.workspace && typeof partial.workspace === 'object') ? partial.workspace : current.workspace || {},
      conventions: Array.isArray(partial?.conventions) ? partial.conventions : (current.conventions || []),
      glossary: (partial?.glossary && typeof partial.glossary === 'object' && !Array.isArray(partial.glossary)) ? partial.glossary : (current.glossary || {}),
      decisions: Array.isArray(partial?.decisions) ? partial.decisions : (current.decisions || []),
      do_not: Array.isArray(partial?.do_not) ? partial.do_not : (current.do_not || []),
    };
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const text = JSON.stringify(next, null, 2);
      if (text.length > MAX_BYTES) return { ok: false, error: `workspace memory exceeds ${MAX_BYTES} bytes` };
      fs.writeFileSync(file, text, 'utf8');
      this.cache.delete(root);
      return { ok: true, path: file };
    } catch (e) { return { ok: false, error: e.message }; }
  }
}

module.exports = { WorkspaceMemory, EMPTY_SHAPE, VALID_TYPE_KEYS };

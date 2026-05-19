// agentskills.io ⇄ Horizon SKILL.md converter — Phase 22.
//
// agentskills.io is a community-curated standard for portable agent
// "skills" (small Markdown docs with frontmatter that tell an LLM
// "use these instructions when the user asks about X"). Hermes Agent
// reads them natively; we use a similar-but-slightly-different
// SKILL.md shape (extra fields like `triggers`, `examples`).
//
// This module is a two-way converter so users can:
//   1. Import any agentskills.io bundle into Horizon (-> creates files
//      in workspace or user scope)
//   2. Export Horizon skills to the agentskills.io format for sharing
//
// Format differences we bridge:
//
//   agentskills.io frontmatter      Horizon SKILL.md frontmatter
//   ─────────────────────────       ─────────────────────────────
//   name           (required)       name           (required)
//   description    (required)       description    (required)
//   version        (optional)       version        (optional)
//   tags           (optional)       tags           (optional)
//   author         (optional)       — (we store author in catalog
//                                       metadata, not in the file)
//   homepage       (optional)       — (same — catalog-level field)
//   —                               triggers       (optional, our
//                                                  extension for routing)
//   —                               examples       (optional, our
//                                                  extension)
//
// On import, agentskills `author` / `homepage` get carried over to a
// non-standard `_origin` block in the YAML so we don't lose
// attribution. On export, our `triggers` / `examples` become an
// HTML comment block at the top so agentskills consumers see the
// content but the strict-mode parser doesn't choke.

const fs = require('fs');
const path = require('path');

// ── YAML helpers (intentionally minimal — front-matter only) ─────────
// agentskills.io files are plain Markdown with a `---`-fenced YAML
// header. We don't want to drag in `js-yaml` for this — the schema is
// flat key/value plus a couple of string-array fields.

function parseFrontMatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text };
  const yaml = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\n/, '');

  const meta = {};
  let currentList = null;
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('  - ') && currentList) {
      meta[currentList].push(line.slice(4).trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) { currentList = null; continue; }
    const key = m[1];
    const val = m[2].trim();
    if (!val) {
      meta[key] = [];
      currentList = key;
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
      currentList = null;
    }
  }
  return { meta, body };
}

function stringifyFrontMatter(meta, body) {
  const lines = ['---'];
  for (const [key, val] of Object.entries(meta)) {
    if (val == null) continue;
    if (Array.isArray(val)) {
      if (val.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of val) lines.push(`  - ${item}`);
    } else {
      // Quote if contains : or # for safety
      const needsQuote = /[:#]/.test(String(val));
      lines.push(`${key}: ${needsQuote ? JSON.stringify(val) : val}`);
    }
  }
  lines.push('---', '', body || '');
  return lines.join('\n');
}

// ── Import: agentskills.io → Horizon ────────────────────────────────

/**
 * Convert one agentskills.io SKILL.md text into Horizon shape.
 * Returns { id, content } ready for SkillsManager.writeSource(id, content, scope).
 */
function importOne(text) {
  const { meta, body } = parseFrontMatter(text);
  if (!meta.name) throw new Error('agentskills file missing required `name` field');
  if (!meta.description) throw new Error('agentskills file missing required `description` field');

  const horizonMeta = {
    name: meta.name,
    description: meta.description,
  };
  if (meta.version) horizonMeta.version = meta.version;
  if (meta.tags) horizonMeta.tags = Array.isArray(meta.tags) ? meta.tags : [];

  // Carry attribution into a _origin sub-block so we don't lose author
  // info but our own loader can ignore it.
  if (meta.author || meta.homepage) {
    horizonMeta._origin = {};
    if (meta.author) horizonMeta._origin.author = meta.author;
    if (meta.homepage) horizonMeta._origin.homepage = meta.homepage;
    horizonMeta._origin.imported_from = 'agentskills.io';
    horizonMeta._origin.imported_at = new Date().toISOString();
  }

  // Slugify the name → kebab-case id (matches our skill id rules)
  const id = String(meta.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!/^[a-z][a-z0-9-]{2,}$/.test(id)) {
    throw new Error(`Cannot derive valid skill id from name: "${meta.name}"`);
  }

  // _origin needs special YAML — flatten to a JSON-like single line.
  // (Our skillsManager only reads top-level keys, so the nested object
  // is preserved but ignored by the runtime.)
  let content;
  if (horizonMeta._origin) {
    const origin = horizonMeta._origin;
    delete horizonMeta._origin;
    content = stringifyFrontMatter(horizonMeta, body);
    // Inject _origin manually as a YAML comment under --- header
    content = content.replace(/^---\n/, `---\n# _origin: ${JSON.stringify(origin)}\n`);
  } else {
    content = stringifyFrontMatter(horizonMeta, body);
  }

  return { id, content, meta: horizonMeta };
}

/**
 * Walk a directory or zip-extracted folder of agentskills.io files,
 * import each into the given SkillsManager scope ('workspace'|'user').
 * Returns { imported: [...], errors: [...] }.
 */
function importDirectory(skillsManager, dirPath, scope = 'workspace') {
  const imported = [];
  const errors = [];
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return { imported, errors: [{ file: dirPath, error: 'not a directory' }] };
  }

  // Either a flat dir of *.md, or a tree of foo/SKILL.md files —
  // walk one level deep to support both layouts.
  const walk = (dir, depth = 0) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 2) walk(fp, depth + 1);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        try {
          const text = fs.readFileSync(fp, 'utf8');
          const { id, content } = importOne(text);
          const r = skillsManager.writeSource(id, content, scope);
          if (!r?.ok) throw new Error(r?.error || 'writeSource failed');
          imported.push({ file: fp, id });
        } catch (e) {
          errors.push({ file: fp, error: e.message });
        }
      }
    }
  };
  walk(dirPath);
  return { imported, errors };
}

// ── Export: Horizon → agentskills.io ────────────────────────────────

/**
 * Convert one Horizon SKILL.md text into agentskills.io shape.
 * `triggers` and `examples` (our extensions) are preserved as HTML
 * comments so agentskills strict parsers ignore them but humans see them.
 */
function exportOne(text) {
  const { meta, body } = parseFrontMatter(text);
  if (!meta.name || !meta.description) {
    throw new Error('Horizon SKILL.md missing name/description');
  }

  const agMeta = {
    name: meta.name,
    description: meta.description,
  };
  if (meta.version) agMeta.version = meta.version;
  if (meta.tags) agMeta.tags = Array.isArray(meta.tags) ? meta.tags : [];

  let preamble = '';
  if (meta.triggers || meta.examples) {
    preamble = '<!-- Horizon-extended fields (ignored by strict agentskills.io parsers):\n';
    if (meta.triggers) preamble += `  triggers: ${JSON.stringify(meta.triggers)}\n`;
    if (meta.examples) preamble += `  examples: ${JSON.stringify(meta.examples)}\n`;
    preamble += '-->\n\n';
  }

  return stringifyFrontMatter(agMeta, preamble + body);
}

/**
 * Export the given skills to an output directory in agentskills.io
 * layout (one .md file per skill, flat).
 */
function exportToDirectory(skillsManager, ids, outDir) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const errors = [];
  for (const id of ids) {
    try {
      const text = skillsManager.readSource(id);
      if (!text) throw new Error('skill not found');
      const out = exportOne(text);
      const fp = path.join(outDir, `${id}.md`);
      fs.writeFileSync(fp, out, 'utf8');
      written.push(fp);
    } catch (e) {
      errors.push({ id, error: e.message });
    }
  }
  return { written, errors };
}

module.exports = {
  importOne,
  importDirectory,
  exportOne,
  exportToDirectory,
  parseFrontMatter,
  stringifyFrontMatter,
};

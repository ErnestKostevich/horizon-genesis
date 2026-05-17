'use strict';
/**
 * Horizon Skills — SKILL.md parser
 *
 * Parses Claude Code-style skill bundles:
 *
 *   ---
 *   name: refactor-react
 *   description: Refactor React class components to hooks
 *   version: 0.1.0
 *   tags: [react, refactor]
 *   permissions: [filesystem.read]
 *   ---
 *   # Body
 *   Procedure the agent follows when this skill loads...
 *
 * Zero-dep YAML subset (mirrors projectConfig.js posture):
 *   - flat `key: value` pairs (strings, numbers, booleans)
 *   - inline arrays `tags: [a, b, c]`
 *   - quoted strings (single or double) for values with colons/special chars
 *   - no nested objects, no block scalars, no anchors
 *
 * If callers ever need richer YAML we swap this for `js-yaml` and the
 * interface stays the same — parseSkillMd(text) → {frontmatter, body}.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const ALLOWED_KEYS = new Set([
  'name', 'description', 'version', 'license', 'author',
  'tags', 'aliases', 'triggers', 'examples',
  'permissions', 'helpers', 'homepage',
]);

const NAME_RE = /^[a-z][a-z0-9-]{1,58}[a-z0-9]$/;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 500;
const BODY_MAX = 64_000;

function stripQuotes(value) {
  const v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

function parseScalar(raw) {
  const v = stripQuotes(raw);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~' || v === '') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

function parseInlineArray(raw) {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  // Split on commas not inside quotes — simple state machine.
  const out = [];
  let buf = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      out.push(parseScalar(buf));
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(parseScalar(buf));
  return out;
}

/**
 * Parse the YAML subset described above.
 * Returns { ok: true, value } on success, { ok: false, error } on failure.
 */
function parseFrontmatter(raw) {
  const out = {};
  const lines = String(raw || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) {
      return { ok: false, error: `line ${i + 1}: expected "key: value", got "${line.slice(0, 60)}"` };
    }
    const key = line.slice(0, colonIdx).trim();
    const valueRaw = line.slice(colonIdx + 1).trim();
    if (!ALLOWED_KEYS.has(key)) {
      // Unknown keys are dropped silently (forward-compat for future fields).
      continue;
    }
    if (valueRaw.startsWith('[')) {
      out[key] = parseInlineArray(valueRaw);
    } else {
      out[key] = parseScalar(valueRaw);
    }
  }
  return { ok: true, value: out };
}

/**
 * Validate frontmatter against the skill schema.
 * Returns { ok, errors[] } — errors empty when valid.
 */
function validateFrontmatter(fm) {
  const errors = [];
  if (!fm || typeof fm !== 'object') {
    errors.push('frontmatter must be an object');
    return { ok: false, errors };
  }
  const name = fm.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    errors.push('name: required, lowercase kebab-case, 3-60 chars (e.g. "refactor-react")');
  }
  const desc = fm.description;
  if (typeof desc !== 'string' || desc.length < DESCRIPTION_MIN || desc.length > DESCRIPTION_MAX) {
    errors.push(`description: required string, ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} chars`);
  }
  if (fm.tags !== undefined) {
    if (!Array.isArray(fm.tags) || fm.tags.some(t => typeof t !== 'string')) {
      errors.push('tags: must be an array of strings');
    }
  }
  for (const key of ['aliases', 'triggers', 'examples', 'permissions', 'helpers']) {
    if (fm[key] !== undefined && (!Array.isArray(fm[key]) || fm[key].some(v => typeof v !== 'string'))) {
      errors.push(`${key}: must be an array of strings`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Parse a SKILL.md document.
 * @param {string} text — raw file content
 * @returns {{ ok, frontmatter, body, rawFrontmatter, errors }}
 */
function parseSkillMd(text) {
  const src = String(text || '');
  if (src.length > BODY_MAX * 2) {
    return { ok: false, frontmatter: {}, body: '', rawFrontmatter: '', errors: [`SKILL.md too large (>${BODY_MAX * 2} bytes)`] };
  }
  const match = src.match(FRONTMATTER_RE);
  if (!match) {
    return { ok: false, frontmatter: {}, body: src, rawFrontmatter: '', errors: ['missing YAML frontmatter — file must start with "---\\n...\\n---"'] };
  }
  const rawFrontmatter = match[1];
  const bodyFull = match[2] || '';
  const parsed = parseFrontmatter(rawFrontmatter);
  if (!parsed.ok) {
    return { ok: false, frontmatter: {}, body: bodyFull, rawFrontmatter, errors: [parsed.error] };
  }
  const validation = validateFrontmatter(parsed.value);
  const body = bodyFull.length > BODY_MAX
    ? bodyFull.slice(0, BODY_MAX) + '\n\n<!-- [body truncated by Horizon: skill exceeded 64 KB] -->'
    : bodyFull;
  return {
    ok: validation.ok,
    frontmatter: parsed.value,
    body,
    rawFrontmatter,
    errors: validation.errors,
  };
}

/**
 * Serialize a frontmatter object back to YAML for the editor "save" path.
 * Keeps key order stable: name, description, version, tags, permissions, helpers.
 * Values with colons or starting with special chars are double-quoted.
 */
function serializeFrontmatter(fm) {
  const order = ['name', 'description', 'version', 'license', 'author', 'tags', 'aliases', 'triggers', 'examples', 'permissions', 'helpers', 'homepage'];
  const lines = [];
  for (const key of order) {
    if (fm[key] === undefined || fm[key] === null) continue;
    const value = fm[key];
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(v => formatScalarOut(v)).join(', ')}]`);
    } else {
      lines.push(`${key}: ${formatScalarOut(value)}`);
    }
  }
  return lines.join('\n');
}

function formatScalarOut(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  // Quote if it contains a colon, leading special char, or is empty.
  if (!s || /[:#&*!|>'"%@`,\[\]{}]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s); // JSON.stringify gives valid YAML-style double quotes for our subset
  }
  return s;
}

/**
 * Build the full SKILL.md text from frontmatter + body.
 */
function buildSkillMd(frontmatter, body) {
  const fm = serializeFrontmatter(frontmatter || {});
  const b = String(body || '').replace(/^\n+/, '');
  return `---\n${fm}\n---\n${b ? '\n' + b : ''}`;
}

module.exports = {
  parseSkillMd,
  parseFrontmatter,
  validateFrontmatter,
  serializeFrontmatter,
  buildSkillMd,
  NAME_RE,
  DESCRIPTION_MIN,
  DESCRIPTION_MAX,
  BODY_MAX,
};

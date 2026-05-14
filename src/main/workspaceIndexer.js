'use strict';
/**
 * Horizon Workspace Indexer (PR-D2)
 * ──────────────────────────────────
 * Lightweight symbol-table builder over a workspace folder. Walks
 * recognised source files and pulls function / class / const / interface
 * names out via per-language regex (NOT a full AST — that would need
 * @babel/parser, tree-sitter, etc which would balloon the install).
 *
 * Why regex is enough for the @symbol autocomplete the indexer powers:
 *  - We only need (name, file, line, kind, language) to surface
 *    candidates in the chat input. Type info / call-graph isn't needed.
 *  - Regex is honest about its limitations: misses dynamic/computed names,
 *    nested closures, decorators. The indexer flags itself as
 *    "approximate" so callers don't oversell it.
 *
 * Index structure (in-memory, no on-disk cache yet):
 *   {
 *     root: '/abs/path',
 *     scannedAt: '2026-05-14T20:51:00Z',
 *     fileCount: 412,
 *     symbolCount: 1834,
 *     symbols: [
 *       { name, file (relPath), line, kind, exported, language }
 *     ],
 *     truncated: false  // true when we hit the per-scan cap
 *   }
 *
 * Caps:
 *  - WALK_FILE_CAP   = 5000 — files visited per scan
 *  - SYMBOLS_CAP     = 8000 — symbols stored
 *  - PER_FILE_BYTES  = 256_000 — files larger than this get skipped
 *  - SYMBOLS_PER_FILE = 200 — per-file cap so one giant generated file
 *    doesn't dominate the table
 */

const fs = require('fs');
const path = require('path');

const WALK_FILE_CAP = 5000;
const SYMBOLS_CAP = 8000;
const PER_FILE_BYTES = 256_000;
const SYMBOLS_PER_FILE = 200;

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out',
  '.cache', '.idea', '.vscode', '__pycache__', '.venv', 'venv',
  'target', '.svelte-kit', '.turbo', '.parcel-cache', 'coverage',
  '.nuxt', '.expo', 'vendor',
]);

const LANGUAGE_BY_EXT = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  rb: 'ruby',
  php: 'php',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'csharp',
};

// Per-language symbol regex set. Each entry: { kind, re, exportedGroup? }.
// `re` MUST capture the symbol name as group 1 unless `nameGroup` is
// specified. `kind` is one of: function | class | interface | type |
// const | enum | struct | trait | method.
const LANG_REGEXES = {
  javascript: [
    { kind: 'function',  re: /^[ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/gm,           exported: /^[ \t]*export/ },
    { kind: 'class',     re: /^[ \t]*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)/gm,                                exported: /^[ \t]*export/ },
    { kind: 'const',     re: /^[ \t]*(?:export\s+(?:const|let|var)|const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\(|function|=>)/gm, exported: /^[ \t]*export/ },
    { kind: 'method',    re: /^[ \t]*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm },
  ],
  typescript: [
    { kind: 'function',  re: /^[ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/gm,           exported: /^[ \t]*export/ },
    { kind: 'class',     re: /^[ \t]*(?:export\s+(?:default\s+)?(?:abstract\s+)?)?class\s+([A-Za-z_$][\w$]*)/gm,                exported: /^[ \t]*export/ },
    { kind: 'interface', re: /^[ \t]*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm,                                            exported: /^[ \t]*export/ },
    { kind: 'type',      re: /^[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm,                                             exported: /^[ \t]*export/ },
    { kind: 'enum',      re: /^[ \t]*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/gm,                                    exported: /^[ \t]*export/ },
    { kind: 'const',     re: /^[ \t]*(?:export\s+(?:const|let|var)|const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/gm,                exported: /^[ \t]*export/ },
  ],
  python: [
    { kind: 'function',  re: /^[ \t]*(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm },
    { kind: 'class',     re: /^[ \t]*class\s+([A-Za-z_][\w]*)/gm },
  ],
  go: [
    { kind: 'function',  re: /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/gm, exported: /^func\s+(?:\([^)]*\)\s+)?[A-Z]/ },
    { kind: 'type',      re: /^type\s+([A-Za-z_][\w]*)\s+/gm,                exported: /^type\s+[A-Z]/ },
    { kind: 'const',     re: /^(?:var|const)\s+([A-Za-z_][\w]*)\s+/gm,       exported: /^(?:var|const)\s+[A-Z]/ },
  ],
  rust: [
    { kind: 'function',  re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/gm,                              exported: /^[ \t]*pub/ },
    { kind: 'struct',    re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/gm,                                       exported: /^[ \t]*pub/ },
    { kind: 'enum',      re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/gm,                                         exported: /^[ \t]*pub/ },
    { kind: 'trait',     re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/gm,                                        exported: /^[ \t]*pub/ },
    { kind: 'const',     re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_][\w]*)\s*:/gm,                         exported: /^[ \t]*pub/ },
  ],
  java: [
    { kind: 'class',     re: /^[ \t]*(?:public|protected|private|abstract|final|static|\s)*class\s+([A-Za-z_$][\w$]*)/gm,         exported: /public/ },
    { kind: 'interface', re: /^[ \t]*(?:public|protected|private|abstract|\s)*interface\s+([A-Za-z_$][\w$]*)/gm,                  exported: /public/ },
    { kind: 'method',    re: /^[ \t]*(?:public|protected|private|static|final|abstract|synchronized|\s)*[\w<>?,. ]+\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:throws\s+[\w, ]+)?\s*\{/gm },
  ],
  kotlin: [
    { kind: 'function',  re: /^[ \t]*(?:public|private|internal|protected|inline|suspend|\s)*fun\s+([A-Za-z_][\w]*)/gm },
    { kind: 'class',     re: /^[ \t]*(?:public|private|internal|protected|abstract|sealed|data|open|\s)*class\s+([A-Za-z_][\w]*)/gm },
  ],
  swift: [
    { kind: 'function',  re: /^[ \t]*(?:public|private|internal|fileprivate|open|\s)*func\s+([A-Za-z_][\w]*)/gm },
    { kind: 'class',     re: /^[ \t]*(?:public|private|internal|fileprivate|open|final|\s)*class\s+([A-Za-z_][\w]*)/gm },
    { kind: 'struct',    re: /^[ \t]*(?:public|private|internal|fileprivate|open|\s)*struct\s+([A-Za-z_][\w]*)/gm },
  ],
  ruby: [
    { kind: 'function',  re: /^[ \t]*def\s+(?:self\.)?([A-Za-z_][\w]*)/gm },
    { kind: 'class',     re: /^[ \t]*class\s+([A-Za-z_][\w]*)/gm },
    { kind: 'method',    re: /^[ \t]*module\s+([A-Za-z_][\w]*)/gm },
  ],
  php: [
    { kind: 'function',  re: /^[ \t]*(?:public|private|protected|static|\s)*function\s+([A-Za-z_][\w]*)/gm },
    { kind: 'class',     re: /^[ \t]*(?:abstract\s+|final\s+)?class\s+([A-Za-z_][\w]*)/gm },
  ],
  c: [
    { kind: 'function',  re: /^[ \t]*(?:static\s+|inline\s+|extern\s+)*[\w*\s]+\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*\{/gm },
    { kind: 'struct',    re: /^[ \t]*(?:typedef\s+)?struct\s+([A-Za-z_][\w]*)/gm },
  ],
  cpp: [
    { kind: 'function',  re: /^[ \t]*(?:static\s+|inline\s+|extern\s+|virtual\s+|constexpr\s+)*[\w:*&<>\s]+\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*(?:const)?\s*(?:override)?\s*\{/gm },
    { kind: 'class',     re: /^[ \t]*(?:template\s*<[^>]*>\s*)?class\s+([A-Za-z_][\w]*)/gm },
    { kind: 'struct',    re: /^[ \t]*(?:template\s*<[^>]*>\s*)?struct\s+([A-Za-z_][\w]*)/gm },
  ],
  csharp: [
    { kind: 'function',  re: /^[ \t]*(?:public|private|protected|internal|static|virtual|override|abstract|async|\s)+[\w<>?,.\[\] ]+\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*\{/gm },
    { kind: 'class',     re: /^[ \t]*(?:public|private|protected|internal|abstract|sealed|static|partial|\s)+class\s+([A-Za-z_][\w]*)/gm },
    { kind: 'interface', re: /^[ \t]*(?:public|private|protected|internal|\s)+interface\s+([A-Za-z_][\w]*)/gm },
  ],
};

class WorkspaceIndexer {
  constructor() {
    this.index = null; // current { root, ...payload }
    this.building = false;
    this.lastError = null;
  }

  /**
   * Walk the workspace and build a symbol table. Returns a status
   * object the caller can poll. Cheap on small repos (<1k files) — for
   * larger ones we rely on the file/symbol caps to keep memory bounded.
   * @param {string} root  absolute workspace path
   * @param {object} opts  { ignoreExtra: string[] = [] }
   */
  async build(root, opts = {}) {
    if (!root || typeof root !== 'string') {
      return { ok: false, error: 'root path required' };
    }
    if (!fs.existsSync(root)) {
      return { ok: false, error: 'root path does not exist' };
    }
    if (this.building) {
      return { ok: false, error: 'index already building', building: true };
    }
    this.building = true;
    this.lastError = null;
    const startedAt = Date.now();
    const ignoreExtra = new Set(Array.isArray(opts.ignoreExtra) ? opts.ignoreExtra : []);
    const files = [];
    let truncated = false;

    const walk = (dir) => {
      if (files.length >= WALK_FILE_CAP) { truncated = true; return; }
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (_) { return; }
      for (const ent of entries) {
        if (files.length >= WALK_FILE_CAP) { truncated = true; return; }
        const name = ent.name;
        if (name.startsWith('.') && name !== '.env.example' && name.length > 1) {
          // Hidden — skip unless it's a recognised dotfile we still
          // want (none for now; add explicit ones here later).
          continue;
        }
        if (ent.isDirectory()) {
          if (IGNORE_DIRS.has(name) || ignoreExtra.has(name)) continue;
          walk(path.join(dir, name));
        } else if (ent.isFile()) {
          const ext = name.split('.').pop()?.toLowerCase();
          if (ext && LANGUAGE_BY_EXT[ext]) {
            files.push(path.join(dir, name));
          }
        }
      }
    };
    walk(root);

    const symbols = [];
    let symbolsCapHit = false;
    for (const absFile of files) {
      if (symbols.length >= SYMBOLS_CAP) { symbolsCapHit = true; break; }
      let content = '';
      try {
        const stat = fs.statSync(absFile);
        if (stat.size > PER_FILE_BYTES) continue;
        content = fs.readFileSync(absFile, 'utf8');
      } catch (_) { continue; }
      const ext = absFile.split('.').pop()?.toLowerCase();
      const language = LANGUAGE_BY_EXT[ext];
      if (!language) continue;
      const langRules = LANG_REGEXES[language];
      if (!langRules) continue;
      const relFile = path.relative(root, absFile).replace(/\\/g, '/');
      let perFileCount = 0;
      for (const rule of langRules) {
        // Reset regex state — `re` is shared across files so lastIndex
        // would leak otherwise (we use /g flag).
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(content)) !== null) {
          if (perFileCount >= SYMBOLS_PER_FILE) break;
          if (symbols.length >= SYMBOLS_CAP) { symbolsCapHit = true; break; }
          const name = m[1];
          if (!name) continue;
          // Cheap line number — count newlines up to match index.
          const upTo = content.slice(0, m.index);
          const line = upTo.split('\n').length;
          // Exported flag: the rule's `exported` regex tested against
          // the matched line gives us a reliable signal.
          let exported = false;
          if (rule.exported) {
            const lineStart = upTo.lastIndexOf('\n') + 1;
            const lineText = content.slice(lineStart, content.indexOf('\n', m.index));
            exported = rule.exported.test(lineText);
          }
          symbols.push({
            name,
            file: relFile,
            line,
            kind: rule.kind,
            exported,
            language,
          });
          perFileCount++;
        }
        if (symbolsCapHit) break;
      }
    }

    this.index = {
      root,
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      fileCount: files.length,
      symbolCount: symbols.length,
      symbols,
      truncated: truncated || symbolsCapHit,
    };
    this.building = false;
    return {
      ok: true,
      root,
      fileCount: files.length,
      symbolCount: symbols.length,
      durationMs: this.index.durationMs,
      truncated: this.index.truncated,
    };
  }

  status() {
    if (!this.index) {
      return { ok: true, hasIndex: false, building: this.building, lastError: this.lastError };
    }
    const { root, scannedAt, fileCount, symbolCount, durationMs, truncated } = this.index;
    return {
      ok: true,
      hasIndex: true,
      building: this.building,
      root,
      scannedAt,
      fileCount,
      symbolCount,
      durationMs,
      truncated,
      lastError: this.lastError,
    };
  }

  /**
   * Fuzzy-ish query the symbol table. Cheap substring match (case-
   * insensitive). Future: bigram-based ranking when callers ask for it.
   * @param {string} q
   * @param {object} opts { kind?, language?, limit? = 30 }
   */
  query(q, opts = {}) {
    if (!this.index) return { ok: true, results: [], total: 0, hasIndex: false };
    const lim = Math.max(1, Math.min(200, Number(opts.limit || 30)));
    const ql = String(q || '').trim().toLowerCase();
    if (!ql) return { ok: true, results: this.index.symbols.slice(0, lim), total: this.index.symbols.length };
    const kindFilter = opts.kind ? new Set([].concat(opts.kind)) : null;
    const langFilter = opts.language ? new Set([].concat(opts.language)) : null;
    const matches = [];
    for (const sym of this.index.symbols) {
      if (kindFilter && !kindFilter.has(sym.kind)) continue;
      if (langFilter && !langFilter.has(sym.language)) continue;
      const lname = sym.name.toLowerCase();
      const idx = lname.indexOf(ql);
      if (idx === -1) continue;
      // Score: prefer prefix matches, then exported, then short names.
      const score = (idx === 0 ? 1000 : 500 - idx) + (sym.exported ? 50 : 0) - sym.name.length;
      matches.push({ sym, score });
      if (matches.length > 1500) break; // hard cap on candidates
    }
    matches.sort((a, b) => b.score - a.score);
    return {
      ok: true,
      results: matches.slice(0, lim).map((m) => m.sym),
      total: matches.length,
      hasIndex: true,
    };
  }

  clear() {
    this.index = null;
    this.lastError = null;
  }
}

module.exports = { WorkspaceIndexer, LANGUAGE_BY_EXT };

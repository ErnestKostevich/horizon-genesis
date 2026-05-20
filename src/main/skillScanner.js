'use strict';
/**
 * Horizon Skills — security scanner
 *
 * The "federated curator" safety net. When a user imports a SKILL.md from
 * an untrusted hub (agentskills.io, ClawHub, Hermes Skills Hub, random
 * GitHub repo), this module scans the content for patterns that suggest
 * the skill is either:
 *
 *   - actively malicious (destructive shell commands, exfiltration,
 *     credential probing, fork bombs)
 *   - prompt-injection laden (role overrides, "ignore previous", system
 *     impersonation strings designed to subvert the agent)
 *   - poorly reviewed but risky (filesystem traversal, chmod 777,
 *     typo-squat package references)
 *
 * It's deliberately conservative — false positives are cheap (user gets a
 * scan report and can override with --force), false negatives are
 * expensive (we silently install a fork bomb).
 *
 * Output contract:
 *   scanSkill(content, metadata?) → {
 *     risk: 'low' | 'medium' | 'high' | 'dangerous',
 *     findings: [{ severity, pattern, line, context, category }],
 *     summary: { total, dangerous, high, medium, low }
 *   }
 *
 * Risk computation:
 *   - ANY 'dangerous' finding             → risk = dangerous (BLOCK install)
 *   - ≥3 'high' findings                  → risk = high
 *   - 1-2 'high' OR ≥3 'medium' findings  → risk = medium
 *   - otherwise                           → risk = low
 *
 * Zero-dep (regex only). Keep it that way — this code runs on every
 * import and we don't want to drag in a parser dependency.
 */

const MAX_CONTEXT_CHARS = 160;
const MAX_FINDINGS = 200; // hard cap so a giant garbage file can't OOM us

// ── Pattern catalog ──────────────────────────────────────────────────
//
// Each rule: { id, severity, regex, category, description, flags? }
//
// `regex` runs against each line (multiline=false). For patterns that
// must span lines (e.g. base64 blobs), set `multiline: true` and we'll
// scan the whole content as one string.
//
// `severity` levels:
//   - dangerous  → instant block (fork bombs, dd of=/dev/sda, mkfs)
//   - high       → big red sign — credential theft, exfiltration, root
//                  escalation, untrusted curl|bash
//   - medium     → suspicious but contextual — rm -rf in $HOME, .env
//                  reads, chmod 777
//   - low        → noteworthy patterns we want to surface but rarely
//                  block on (e.g. references to network calls)
//
// We err on the side of flagging — the user always has the final say
// via `--force`.

const RULES = [
  // ── Resource exhaustion / fork bombs (DANGEROUS) ────────────────────
  {
    id: 'fork-bomb',
    severity: 'dangerous',
    category: 'resource-exhaustion',
    description: 'fork bomb',
    // Classic Unix fork bomb plus a few common encodings/spellings.
    regex: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  },
  {
    id: 'dd-disk-wipe',
    severity: 'dangerous',
    category: 'destructive-shell',
    description: 'raw disk overwrite (dd to a block device)',
    regex: /\bdd\b[^\n;|]*(?:of=\/dev\/[sh]d[a-z]|of=\/dev\/nvme|of=\/dev\/disk)/i,
  },
  {
    id: 'mkfs',
    severity: 'dangerous',
    category: 'destructive-shell',
    description: 'filesystem format (mkfs)',
    regex: /\bmkfs(?:\.\w+)?\s+\/dev\//,
  },
  {
    id: 'redirect-to-block-device',
    severity: 'dangerous',
    category: 'destructive-shell',
    description: 'redirect to raw block device',
    regex: />\s*\/dev\/[sh]d[a-z]\b|>\s*\/dev\/nvme/,
  },
  {
    id: 'rm-root',
    severity: 'dangerous',
    category: 'destructive-shell',
    description: 'recursive removal of system root',
    // `rm -rf /` or `rm -rf /*` — both with various flag orderings.
    regex: /\brm\s+(?:-[rfRF]+\s+)+\/(?:\s|\*|$)/,
  },

  // ── Credential probing (HIGH) ───────────────────────────────────────
  {
    id: 'ssh-private-key',
    severity: 'high',
    category: 'credential-probe',
    description: 'reference to SSH private key',
    regex: /\.ssh\/id_(?:rsa|ed25519|ecdsa|dsa)\b/,
  },
  {
    id: 'aws-credentials',
    severity: 'high',
    category: 'credential-probe',
    description: 'reference to AWS credentials file',
    regex: /\.aws\/credentials\b/,
  },
  {
    id: 'gcloud-credentials',
    severity: 'high',
    category: 'credential-probe',
    description: 'reference to gcloud application default credentials',
    regex: /\.config\/gcloud\/application_default_credentials/,
  },
  {
    id: 'env-file-read',
    severity: 'medium',
    category: 'credential-probe',
    description: 'reads a .env file (may exfiltrate secrets)',
    // Look for shell-style reads of .env, not just mentioning the word.
    regex: /\b(?:cat|less|more|head|tail|source|\.)\s+(?:[./\w-]*\/)?\.env(?:\s|$|\.|;|\||\|\|)/,
  },
  {
    id: 'shadow-passwd',
    severity: 'high',
    category: 'credential-probe',
    description: 'reference to /etc/passwd or /etc/shadow',
    regex: /\/etc\/(?:passwd|shadow|sudoers)\b/,
  },
  {
    id: 'browser-cookies',
    severity: 'high',
    category: 'credential-probe',
    description: 'reference to browser cookie/credential store',
    regex: /(?:Cookies|Login Data|Web Data)["']?\s*$|Library\/Application Support\/Google\/Chrome|AppData\/Local\/Google\/Chrome\/User Data/,
  },
  {
    id: 'keychain-extract',
    severity: 'high',
    category: 'credential-probe',
    description: 'macOS keychain extraction',
    regex: /\bsecurity\s+(?:find-generic-password|find-internet-password|dump-keychain)\b/,
  },

  // ── Network exfiltration (HIGH) ─────────────────────────────────────
  {
    id: 'curl-pipe-bash',
    severity: 'high',
    category: 'network-exfil',
    description: 'piping remote script directly to a shell',
    // Matches `curl X | sh` / `wget X | bash` and variants.
    regex: /\b(?:curl|wget|fetch)\b[^\n|;]*\|\s*(?:sh|bash|zsh|ksh|dash|python|perl|node|ruby)\b/,
  },
  {
    id: 'nc-reverse-shell',
    severity: 'dangerous',
    category: 'network-exfil',
    description: 'netcat reverse-shell pattern',
    regex: /\bnc(?:at)?\b[^\n;|]*\s-e\s|\bbash\s+-i\s+>&\s*\/dev\/tcp\//,
  },
  {
    id: 'base64-exec',
    severity: 'high',
    category: 'network-exfil',
    description: 'base64-decoded payload piped to a shell',
    regex: /base64\s+(?:-d|--decode|-D)[^\n|;]*\|\s*(?:sh|bash|python|perl|node|ruby)\b/,
  },
  {
    id: 'eval-from-network',
    severity: 'high',
    category: 'network-exfil',
    description: 'eval of remote content',
    regex: /\beval\s*\(\s*(?:require\(['"][^'"]*request|fetch|axios|curl|wget|XMLHttpRequest)/,
  },

  // ── Permission escalation (HIGH) ────────────────────────────────────
  {
    id: 'chmod-world-writable',
    severity: 'high',
    category: 'privilege-escalation',
    description: 'world-writable / world-executable permissions',
    regex: /\bchmod\s+(?:-[Rr]\s+)?(?:777|666|a\+rwx|o\+w)\b/,
  },
  {
    id: 'chown-root',
    severity: 'high',
    category: 'privilege-escalation',
    description: 'change ownership to root',
    regex: /\bchown\s+(?:-[Rr]\s+)?root[:\s]/,
  },
  {
    id: 'setuid-bit',
    severity: 'high',
    category: 'privilege-escalation',
    description: 'setuid/setgid bit on a binary',
    regex: /\bchmod\s+(?:-[Rr]\s+)?[ug]\+s\b|\bchmod\s+(?:-[Rr]\s+)?[0-9]?4\d{3}\b/,
  },
  {
    id: 'sudo-no-password',
    severity: 'high',
    category: 'privilege-escalation',
    description: 'sudo NOPASSWD configuration',
    regex: /\bNOPASSWD\s*:|sudoers\.d\/|visudo\b/,
  },

  // ── Destructive shell (MEDIUM / HIGH) ───────────────────────────────
  {
    id: 'rm-rf-home',
    severity: 'high',
    category: 'destructive-shell',
    description: 'recursive removal of $HOME or user directory',
    regex: /\brm\s+(?:-[rfRF]+\s+)+(?:\$HOME|~\/|\$\{HOME\})/,
  },
  {
    id: 'rm-rf-generic',
    severity: 'medium',
    category: 'destructive-shell',
    description: 'recursive force removal (rm -rf)',
    // Catches `rm -rf <something>` not already covered by the more
    // specific rm rules above. Medium because legitimate skills DO
    // sometimes call rm -rf on a tmp dir, so we surface but don't block.
    regex: /\brm\s+(?:-[rfRF]+\s*)+\S/,
  },
  {
    id: 'shutdown-reboot',
    severity: 'medium',
    category: 'destructive-shell',
    description: 'system shutdown or reboot',
    regex: /\b(?:shutdown|reboot|halt|poweroff)\s+(?:-[hr]|now|\+\d+)/,
  },
  {
    id: 'kill-pid-1',
    severity: 'high',
    category: 'destructive-shell',
    description: 'kill of init / pid 1',
    regex: /\bkill\s+(?:-9\s+)?1\b/,
  },

  // ── Filesystem traversal (MEDIUM) ───────────────────────────────────
  {
    id: 'traversal-deep',
    severity: 'medium',
    category: 'fs-traversal',
    description: 'deep path traversal sequence',
    // 3+ consecutive `../` runs raise eyebrows in a skill body — these
    // belong in CWE-22 exploit demos, not user instructions.
    regex: /(?:\.\.[\\/]){3,}/,
  },
  {
    id: 'windows-system32',
    severity: 'medium',
    category: 'fs-traversal',
    description: 'reference to Windows system directory',
    regex: /C:[\\/]Windows[\\/]System32\b/i,
  },

  // ── Prompt injection (HIGH) ─────────────────────────────────────────
  {
    id: 'ignore-previous',
    severity: 'high',
    category: 'prompt-injection',
    description: 'classic prompt-injection trigger',
    regex: /\bignore\s+(?:all\s+|the\s+|your\s+)?(?:previous|prior|above)\s+(?:instructions|prompts|messages|rules)/i,
  },
  {
    id: 'role-override',
    severity: 'high',
    category: 'prompt-injection',
    description: 'role override / system impersonation',
    regex: /^\s*(?:System|Assistant|Developer)\s*:\s*(?:you\s+are|act\s+as|pretend|override)|^<\|system\|>|\[INST\]\s*system/im,
  },
  {
    id: 'jailbreak-persona',
    severity: 'high',
    category: 'prompt-injection',
    description: 'jailbreak persona reference',
    regex: /\b(?:DAN\s+mode|do\s+anything\s+now|jailbreak\s+mode|developer\s+mode\s+enabled|unfiltered\s+mode)\b/i,
  },
  {
    id: 'override-safety',
    severity: 'high',
    category: 'prompt-injection',
    description: 'instruction to bypass safety / ethics',
    regex: /\b(?:disregard|bypass|disable|turn\s+off)\s+(?:your\s+|all\s+)?(?:safety|ethics|guardrails|filters|restrictions)/i,
  },
  {
    id: 'leak-system-prompt',
    severity: 'medium',
    category: 'prompt-injection',
    description: 'request to leak system prompt',
    regex: /\b(?:reveal|show|print|output|leak|repeat)\s+(?:your\s+|the\s+|full\s+)?(?:system\s+prompt|initial\s+prompt|instructions\s+above)/i,
  },

  // ── Supply chain (MEDIUM) ───────────────────────────────────────────
  // Known typo-squat / malicious package names that have been seen in
  // recent npm/PyPI campaigns. Not exhaustive — this is a "rough
  // signal" check, not a CVE feed.
  {
    id: 'typosquat-npm',
    severity: 'medium',
    category: 'supply-chain',
    description: 'reference to known typo-squatted npm package',
    regex: /\bnpm\s+install\s+(?:-g\s+)?(?:lodahs|expres|requst|loadsh|cors-anywhere-easy|node-ipc-fork|electorn|reaqct|axiosis|momnt|chalkk)\b/i,
  },
  {
    id: 'typosquat-pypi',
    severity: 'medium',
    category: 'supply-chain',
    description: 'reference to known typo-squatted PyPI package',
    regex: /\bpip\s+install\s+(?:-U\s+)?(?:reqursts|reqeusts|urlib3|djnago|pythn|tensorfow|colourama|pyhton-dateutil)\b/i,
  },
  {
    id: 'npm-postinstall-hook',
    severity: 'low',
    category: 'supply-chain',
    description: 'mentions npm postinstall scripts (often abused)',
    regex: /"postinstall"\s*:|npm install.*--ignore-scripts/,
  },

  // ── Suspicious domain refs (LOW) ────────────────────────────────────
  {
    id: 'pastebin-raw',
    severity: 'medium',
    category: 'network-exfil',
    description: 'reference to pastebin raw URL (common malware delivery)',
    regex: /\b(?:pastebin\.com\/raw|hastebin\.com\/raw|0x0\.st|transfer\.sh|ix\.io|temp\.sh)\b/,
  },
  {
    id: 'ngrok-tunnel',
    severity: 'medium',
    category: 'network-exfil',
    description: 'ngrok/serveo tunnel reference',
    regex: /\b(?:[\w-]+\.ngrok\.io|[\w-]+\.ngrok-free\.app|[\w-]+\.serveo\.net|[\w-]+\.lhr\.life)\b/,
  },
];

// Patterns that scan the WHOLE document (multiline). Used for things
// like big base64 blobs that span many lines.
const MULTILINE_RULES = [
  {
    id: 'huge-base64-blob',
    severity: 'medium',
    category: 'obfuscation',
    description: 'large base64-encoded blob (possible hidden payload)',
    // 400+ chars of base64 alphabet in one stretch is rare in legit docs.
    regex: /[A-Za-z0-9+/]{400,}={0,2}/,
  },
  {
    id: 'hex-shellcode',
    severity: 'medium',
    category: 'obfuscation',
    description: 'long hex blob (possible shellcode)',
    regex: /(?:\\x[0-9a-f]{2}){40,}/i,
  },
];

function snippet(line, max = MAX_CONTEXT_CHARS) {
  const s = String(line || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

/**
 * Scan a skill body (and optionally its frontmatter metadata) for risky
 * patterns. Returns a report; never throws.
 *
 * @param {string} content — SKILL.md text or skill body
 * @param {object} [metadata] — parsed frontmatter (optional, used for
 *   permissions cross-check; not required for correctness)
 * @returns {{ risk, findings, summary }}
 */
function scanSkill(content, metadata = null) {
  const text = String(content == null ? '' : content);
  const findings = [];
  const lines = text.split(/\r?\n/);

  // Per-line scan (the bulk of our rules).
  outer:
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const rule of RULES) {
      if (findings.length >= MAX_FINDINGS) break outer;
      const m = rule.regex.exec(line);
      if (m) {
        findings.push({
          id: rule.id,
          severity: rule.severity,
          category: rule.category,
          description: rule.description,
          line: i + 1,
          context: snippet(line),
          match: m[0].slice(0, 80),
        });
      }
    }
  }

  // Whole-document multiline scan.
  for (const rule of MULTILINE_RULES) {
    if (findings.length >= MAX_FINDINGS) break;
    const m = rule.regex.exec(text);
    if (m) {
      const before = text.slice(0, m.index);
      const lineNo = before.split(/\r?\n/).length;
      findings.push({
        id: rule.id,
        severity: rule.severity,
        category: rule.category,
        description: rule.description,
        line: lineNo,
        context: snippet(m[0]),
        match: m[0].slice(0, 80),
      });
    }
  }

  // Metadata cross-check — if the skill declares permissions that don't
  // match its content, surface it. Specifically: filesystem.write
  // declared but body only reads → that's fine; body has rm -rf but no
  // permission declared → low-severity heads-up.
  if (metadata && typeof metadata === 'object') {
    const perms = Array.isArray(metadata.permissions) ? metadata.permissions : [];
    const hasNetwork = perms.some(p => /network|http|fetch/i.test(p));
    const hasShell = perms.some(p => /shell|exec|run_shell/i.test(p));
    const mentionsNetwork = /\b(?:curl|wget|fetch|axios|XMLHttpRequest)\b/.test(text);
    const mentionsShell = /\b(?:bash|sh|exec|spawn|run_shell|child_process)\b/.test(text);
    if (mentionsNetwork && !hasNetwork && findings.length < MAX_FINDINGS) {
      findings.push({
        id: 'undeclared-network',
        severity: 'low',
        category: 'metadata-mismatch',
        description: 'body uses network calls but no `network` permission declared',
        line: 0,
        context: '(see frontmatter `permissions:` block)',
        match: '',
      });
    }
    if (mentionsShell && !hasShell && findings.length < MAX_FINDINGS) {
      findings.push({
        id: 'undeclared-shell',
        severity: 'low',
        category: 'metadata-mismatch',
        description: 'body invokes shell commands but no `shell` permission declared',
        line: 0,
        context: '(see frontmatter `permissions:` block)',
        match: '',
      });
    }
  }

  const summary = { total: findings.length, dangerous: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) summary[f.severity] = (summary[f.severity] || 0) + 1;

  let risk;
  if (summary.dangerous > 0) risk = 'dangerous';
  else if (summary.high >= 3) risk = 'high';
  else if (summary.high >= 1 || summary.medium >= 3) risk = 'medium';
  else risk = 'low';

  return { risk, findings, summary };
}

module.exports = {
  scanSkill,
  // Exported for tests + power users who want to extend the rule set.
  RULES,
  MULTILINE_RULES,
};

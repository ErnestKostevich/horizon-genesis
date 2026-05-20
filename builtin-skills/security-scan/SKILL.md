---
name: security-scan
description: |
  Local secret, CVE, and injection scan over the current git diff or a
  specified file set. Activate when the user says "scan for secrets",
  "is this safe to commit", "check for vulnerabilities", "security audit",
  before publishing/deploying, or when a diff touches auth/crypto/input code.
license: BUSL-1.1
metadata:
  category: code
  version: 1.0.0
  author: Horizon AI
---

# Local security scan

Run before commits, before deploys, and before merging PRs that touch
sensitive surface area. Use `run_shell` for tooling and `grep` for
pattern searches.

## Procedure

1. **Scope the scan.** Default to `git diff --cached` if there are staged
   changes, otherwise `git diff main...HEAD`. If the user names a path,
   honor it. Confirm the scope with one line ("scanning 14 files,
   ~340 lines changed") before proceeding.
2. **Secret scan.** Use `grep` with patterns for: `AKIA[0-9A-Z]{16}` (AWS),
   `ghp_[A-Za-z0-9]{36}` (GitHub), `sk-[A-Za-z0-9]{32,}` (OpenAI/Stripe),
   `-----BEGIN.*PRIVATE KEY-----`, hardcoded `password\s*=`, JWT-like
   `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.`. If the repo has `gitleaks`
   or `trufflehog` installed, prefer those via `run_shell`.
3. **Dependency CVEs.** Run `npm audit --json` / `pip-audit --format json`
   / `cargo audit` based on detected manifest. Surface only HIGH and
   CRITICAL. Mention the fix command (`npm audit fix`, etc.).
4. **Injection patterns.** Search the diff for: raw SQL string
   concatenation (`"SELECT * FROM " +`), `eval(`, `child_process.exec(`
   with user input, `dangerouslySetInnerHTML`, `v-html`, unescaped
   template variables in HTML.
5. **AuthZ/AuthN smells.** Flag: missing `req.user` checks before
   sensitive ops, `===` swapped for `==` in token comparisons,
   `Math.random()` used for tokens/IDs, hardcoded admin emails.
6. **Report.** Group by severity (CRITICAL / HIGH / MEDIUM / LOW).
   Show file:line and one-sentence reasoning per finding. If clean,
   say "no findings" — do not invent issues to seem thorough.

## Anti-patterns to avoid

- Don't output a full secret value, even when flagging it — mask middle chars.
- Don't run scans against `node_modules/` or `.git/`.
- Don't suggest pinning to vulnerable versions to silence audit warnings.

## Example invocation

> User: "Scan this diff before I push"

Response: identify staged scope, run secret regex sweep + `npm audit`,
report `CRITICAL: src/api.js:88 — AWS key hardcoded (AKIA****ABCD)`
and `HIGH: lodash@4.17.10 → CVE-2021-23337 (fix: npm update lodash)`.
Recommend `git reset HEAD~1` if commit already includes a secret.

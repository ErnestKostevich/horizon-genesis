---
name: dependency-audit
description: |
  Audit npm, pip, or cargo dependencies for CVEs, license issues, and
  duplicate versions. Activate when the user says "audit deps",
  "check vulnerabilities", "what's outdated", "dedupe my packages",
  "license check", "is this package safe", or before a release/publish.
license: BUSL-1.1
metadata:
  category: code
  version: 1.0.0
  author: Horizon AI
---

# Dependency audit

Dependencies are the largest attack surface in most projects. Audit
before every release and before adopting any new package. Use
`run_shell` for tool invocations, `read_file` for manifest inspection.

## Procedure

1. **Detect the manifest.** Look for `package.json`, `requirements.txt`,
   `pyproject.toml`, `Pipfile`, `Cargo.toml`, `go.mod`. If multiple,
   ask which to audit, or audit all and group the report by ecosystem.
2. **Run the native auditor.**
   - npm: `npm audit --json --omit=dev` (use `--include=dev` if the
     user wants dev deps included)
   - pip: `pip-audit --format json` or `safety check --json`
   - cargo: `cargo audit --json`
   - go: `govulncheck ./...`
   Report only HIGH and CRITICAL by default. The user can ask for the
   full list.
3. **Check for outdated.** `npm outdated`, `pip list --outdated`. Note
   the gap between current and latest — major-version gaps deserve
   attention.
4. **License check.** For npm, run `npx license-checker --summary` (or
   `license-checker-rseidelsohn` if installed). Flag any GPL, AGPL,
   or SSPL deps if the project is permissive-licensed. Flag unknown
   or missing licenses.
5. **Deduplicate.** Run `npm ls <package>` for any package that appears
   multiple times. Suggest `npm dedupe` if multiple minor versions of
   the same package exist. Same idea for pip: detect transitive
   duplicates.
6. **Supply-chain checks.** Use `grep` to flag suspicious patterns:
   - packages added in the last 7 days (high typosquat risk)
   - packages with single maintainer + low download count
   - install scripts: `npm pkg get scripts.preinstall scripts.postinstall`
7. **Report.** Group by severity. Per finding: package, version,
   advisory ID (CVE-... or GHSA-...), fix command, breaking-change
   warning if the fix is a major bump.

## Anti-patterns to avoid

- Don't auto-run `npm audit fix --force` — it can introduce breaking changes.
- Don't ignore advisories without recording an exception (npm overrides,
  pip ignore list) with a justification.
- Don't update everything at once — group by reason (security / feature /
  dev tooling) and PR them separately.

## Example invocation

> User: "Audit my deps before release"

Response: detect `package.json`, run `npm audit --json`, run
`npm outdated`, run `license-checker --summary`, report:
"CRITICAL: lodash 4.17.10 → CVE-2021-23337, fix `npm i lodash@4.17.21`.
HIGH: 2 advisories. License: 1 AGPL package (markdown-pdf) — review.
Outdated: 14 minor, 3 major. Duplicates: react appears as 17.0.2 and
18.2.0 — consolidate."

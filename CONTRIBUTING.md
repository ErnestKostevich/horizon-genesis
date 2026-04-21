# Contributing to Horizon Genesis

Thanks for considering a contribution. Horizon is small, opinionated, and maintained by one person — so please read this before opening a PR.

## Before you start

- **Open an issue first** for anything non-trivial (new feature, refactor, dependency bump). Saves us both time if the direction is wrong.
- Small fixes (typos, obvious bugs, doc clarifications) — just send the PR.

## Dev setup

```bash
git clone https://github.com/ErnestKostevich/horizon-genesis.git
cd horizon-genesis
npm install
```

Requires Node 18+ and npm 9+.

### Unlock the source-preview gate (contributors only)

The app checks for `src/main/build-info.json` at startup. That file is **only created by CI** during a tagged release build — so if you just run `npm start` from a fresh clone, you'll see the source-preview window and the app will exit.

To run locally for development, create the marker file by hand:

```bash
# from the repo root
cat > src/main/build-info.json <<'EOF'
{
  "official": true,
  "version": "dev",
  "sha": "local",
  "buildDate": "1970-01-01T00:00:00Z",
  "runner": "local",
  "workflow": "dev",
  "runId": "0"
}
EOF
```

Now `npm start` launches the full app. The file is listed in `.gitignore`, so git won't pick it up — but **double-check** with `git status` before every commit. Committing this file would mean fork builds could masquerade as official, which defeats the whole point of the gate.

The app runs without any env vars or API keys — you configure providers inside the app (BYOK).

## Project layout

```
src/main/           Electron main process (IPC, plugin runtime, AI providers)
src/renderer/       UI (chat, setup — plain HTML/CSS/JS, no build step)
builtin-plugins/    Ships-with-the-app plugins
assets/             Installer icons
.github/workflows/  CI build for Windows + macOS
```

## What I accept

- Bug fixes with clear repro steps
- Provider additions (new LLM API integrations) — must follow BYOK model, no routing through Horizon servers
- New built-in plugins — small, useful, no external dependencies
- Platform fixes (macOS-specific, Windows-specific issues)
- Tests and cleanups

## What I probably won't merge

- Telemetry / analytics / phone-home features
- Monetization code in the desktop app (monetization lives in the marketplace, not here)
- Large framework changes (e.g. "let's rewrite in TypeScript") without discussion
- Features that require always-on internet

## Code style

- Follow existing style — 2-space indent, single quotes, no semicolons in some places (I know, sorry)
- Keep the renderer pages as plain HTML — no React, no bundler, no build step
- Keep dependencies minimal: every `npm install <x>` adds supply-chain risk

## Pull request checklist

- [ ] Tested on your OS (Windows / macOS)
- [ ] No new top-level dependencies without discussion
- [ ] No hardcoded secrets, API keys, or user-specific paths
- [ ] `src/main/build-info.json` is **not** in your diff (it's gitignored, but verify)
- [ ] CHANGELOG.md entry under `[Unreleased]` if it's user-facing
- [ ] Commit message explains the *why*, not just the *what*

## Reporting security issues

Do NOT open a public issue for security problems. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree your contributions will be licensed under the [MIT License](LICENSE).

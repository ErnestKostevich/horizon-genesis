# Horizon Genesis

> Desktop AI agent with personas, plugins, workflows, and computer use.
> Local-first. Bring-your-own-keys. MIT.

Horizon Genesis is an Electron-based AI agent that runs on your machine. You choose the model, you choose the provider, you keep the keys. It drives your browser, your files, and any plugin you install — but only with the permissions you grant.

- **Website:** https://horizonaai.dev
- **Marketplace:** https://horizonaai.dev/browse
- **Download:** https://horizonaai.dev/#download
- **Docs:** https://horizonaai.dev/docs

---

## ⚠️ Read this first — source is for review only

This repository is a **source preview**. The code here is MIT-licensed so you can audit it, learn from it, and contribute — but **cloning and running it won't launch a working app**. When started from a source clone, the app opens a notice window pointing you to the official installer.

**The only runnable builds ship from [GitHub Releases](https://github.com/ErnestKostevich/horizon-genesis/releases/latest).** Those are produced by this repo's CI from this exact source — same code, just stamped with an official build marker during the CI workflow.

**Why this split?**
- Code is transparent (you can read every line before installing anything)
- Official releases have an integrity marker — you know what you're running came from CI, not from some modified fork
- Prevents drive-by "clone-and-run" impersonation of the real app

If you're a contributor who needs to run locally, see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Features

- Personas (swap prompt, tools, provider on the fly)
- No-code workflows
- Plugin system with permission manifests (Built-in, Demo, Community tiers)
- Computer use (see screen, click, type — scoped and pause-able)
- MCP server support
- Google / Spotify / browser automation out of the box

## Install (official builds)

Grab the installer from [the latest release](https://github.com/ErnestKostevich/horizon-genesis/releases/latest):

- **Windows:** `Horizon-AI-Setup-x.y.z.exe` (NSIS, x64)
- **macOS:** `Horizon-AI-x.y.z.dmg` (Intel + Apple Silicon, unsigned — right-click → Open)

Or install marketplace plugins via `horizon://` deep links from the site.

## How the build gate works

The app checks for `src/main/build-info.json` at startup. This file is **only created by [the release workflow](.github/workflows/release.yml)** — it's gitignored, never committed, never produced by a local `npm run build:*`. Its absence is the signal: "this isn't an official build, show the preview and exit."

The workflow stamps the file with the tag, commit SHA, build timestamp, and runner — so you can trace any installer back to its exact source commit.

## Configuration

Official builds run without any env vars. To point at a self-hosted marketplace instead of the default, configure in-app (Settings → Marketplace) or set:

| Var | Default | Purpose |
|---|---|---|
| `HORIZON_MARKETPLACE_URL` | `https://api.horizonaai.dev` | Marketplace REST API base |
| `HORIZON_MARKETPLACE_WEB_URL` | auto-derived (strips `api.`) | Web URL for "open dashboard" links |

Model provider keys are stored locally, encrypted via the OS keychain (safeStorage). Nothing is sent to a Horizon server — the app only talks to the marketplace when you install or publish plugins.

## Architecture

```
┌────────────────────┐   ┌───────────────────┐   ┌──────────────────┐
│ Horizon Desktop    │   │ Plugins           │   │ Marketplace      │
│ (this repo)        │◄──┤ manifest+handler  │◄──┤ (separate repo)  │
│ Electron · JS      │   │ permission-gated  │   │ FastAPI+React    │
│ your machine       │   │ local install     │   │ public catalog   │
└────────────────────┘   └───────────────────┘   └──────────────────┘
```

The marketplace is a separate, private service. Zero agent traffic flows through it — it only handles plugin discovery, install, and publishing.

## Repo layout

```
src/main/          Electron main process, IPC, plugin runtime, providers
src/renderer/      Chat UI, setup, source-preview page (plain HTML)
builtin-plugins/   Ships-with-the-app plugins (e.g. spotify-control)
assets/            Icons for installers
.github/workflows/ CI: release build for Windows + macOS
```

## Contributing

Small fixes welcome. Open an issue first for anything non-trivial. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Found a vulnerability? Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE). You can read, fork, and learn from the code. For runnable builds, use the [official releases](https://github.com/ErnestKostevich/horizon-genesis/releases/latest).

## Author

Built by [Ernest Kostevich](https://github.com/ErnestKostevich).

# `docs/` — what's in here

Five files. Pick the one that matches what you need:

| File | For who | What it's for |
|---|---|---|
| **[getting-started.md](getting-started.md)** | Users | Install + first-run setup for desktop app and CLI |
| **[cli.md](cli.md)** | CLI users | Every subcommand + flag + output format |
| **[deploy.md](deploy.md)** | Server admins | Run Horizon on a VPS — systemd + nginx + TLS + cron |
| **[competitive-analysis.md](competitive-analysis.md)** | Curious readers | Honest by-feature comparison vs Hermes Agent |
| **[ultrareview-2026-05.md](ultrareview-2026-05.md)** | The maintainer + designers | Current design-redesign roadmap (Electron + CLI + site) |

User-facing documentation — full Table of Contents, screenshots,
tutorials — lives in the dedicated repository:

→ **[github.com/ErnestKostevich/Horizon-Agent-Docs](https://github.com/ErnestKostevich/Horizon-Agent-Docs)**

Or read it hosted at **[horizonaai.dev/docs](https://horizonaai.dev/docs)**.

This `docs/` folder in the main repo stays small on purpose — it's
the **technical reference** that ships alongside the source code.
The user-facing guides live separately so end users don't have to
clone a 200 MB source tree to read installation instructions.

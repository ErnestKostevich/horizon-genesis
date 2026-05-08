# Native PTY Terminal

Horizon Code Mode uses `@xterm/xterm` in the renderer. In the main process it now tries to use the optional native `node-pty` backend first, then falls back to the pipe-backed shell transport if the native module is unavailable for the current Electron ABI.

This keeps development and portable builds reliable while still enabling real ConPTY/PTY behavior on machines with a working native toolchain.

## Rebuild

After installing dependencies, rebuild the native module for Electron:

```powershell
npm run rebuild:native
```

The app will report `native PTY` in the Code Mode terminal when this succeeds. If it reports `fallback shell pipe`, the terminal still works, but resize and full interactive terminal behavior are limited.

## Windows Toolchain

For Windows builds, `node-pty` needs Visual Studio Build Tools with Desktop C++ components. On this machine the failing rebuild error was:

```text
MSB8040: this project requires Spectre-mitigated libraries
```

Install the matching Spectre libraries for the active MSVC toolset. For Visual Studio Build Tools 2026 with MSVC `14.50`, the component id is:

```text
Microsoft.VisualStudio.Component.VC.14.50.18.0.x86.x64.Spectre
```

After installing that component, rerun:

```powershell
npm run rebuild:native
npm run build:win:portable
```


# Desktop Runtime Strategy

Horizon keeps Electron for the 1.0.0 rescue build because the product already ships a large renderer, plugin hub, local HTTP bridge, protocol handlers, and installer pipeline. Rewriting the shell before trust bugs are closed would create more release risk than it removes.

## Immediate 1.0 hardening

- Keep `webSecurity: true`.
- Keep preload API allowlisted.
- Pause heavy animation when the window is hidden.
- Keep community plugin execution limited to explicit installed handlers.
- Use `horizon://auth/desktop` for website OAuth token handoff.
- Treat local models as optional connectors: the user installs Ollama or LM Studio, then Horizon tests the local OpenAI-compatible endpoint.

## Native migration path

Tauri v2 is the preferred candidate for a lighter shell after 1.0 because it can preserve most frontend UI while moving the shell to Rust and the OS WebView. Migration should be staged:

1. Extract renderer app into a framework-neutral package.
2. Move preload IPC contracts into a typed command layer.
3. Port settings, key storage, protocol handling, and local model checks.
4. Port computer-use and plugin sandbox separately.
5. Keep Electron as the stable channel until parity is proven.

## Release rule

Do not start a native rewrite until wallet, auth, publish/moderation, billing, update, and plugin trust flows pass smoke tests on the Electron build.

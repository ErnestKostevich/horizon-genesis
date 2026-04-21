# Changelog

All notable changes to Horizon Genesis will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-04-21

First public open-source release.

### Added
- Electron-based desktop AI agent (Windows + macOS)
- Personas system — swap prompt, tools, and provider on the fly
- Plugin runtime with permission manifests (built-in, demo, community tiers)
- No-code workflow engine with visual editor
- Computer use — screen capture, OCR, mouse + keyboard control
- MCP server support
- Browser automation (open URLs, search, site shortcuts)
- Google OAuth integration for Gmail and Calendar
- Spotify control plugin (BYOK, PKCE flow)
- Built-in marketplace client for installing community plugins via `horizon://` deep links
- 10+ AI provider integrations: Gemini, Claude, GPT-4o, Groq, DeepSeek, Mistral, Qwen, Grok, Perplexity, Cohere
- STT providers: Deepgram, Whisper, browser Web Speech API
- TTS providers: ElevenLabs, OpenAI, system voice, Kokoro (on-device)
- Screen recorder with AI narration
- Local-first memory (conversations, facts, nutrition log)
- GitHub Actions CI — automated Windows + macOS installer builds on tag push

### Security
- All API keys encrypted via OS keychain (`safeStorage` on top of `electron-store`)
- Per-plugin permission manifests; user approves before install
- No telemetry, no phone-home, no analytics

### Known limitations
- macOS builds are **unsigned** — right-click → Open to bypass Gatekeeper
- No Linux build yet (coming later if there's demand)
- No auto-update (manual download from Releases for now)

[Unreleased]: https://github.com/ErnestKostevich/horizon-genesis/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ErnestKostevich/horizon-genesis/releases/tag/v1.0.0

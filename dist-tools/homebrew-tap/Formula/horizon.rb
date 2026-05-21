# typed: false
# frozen_string_literal: true

# Horizon AI -- personal AI agent that runs on your machine.
#
# Tap:    ErnestKostevich/tap
# Repo:   https://github.com/ErnestKostevich/horizon-homebrew-tap
# Source: https://github.com/ErnestKostevich/horizon-genesis
#
# This formula installs the standalone CLI binary produced by `pkg`
# (Node 22 bundled, no Node toolchain needed on the user's machine).
#
# When the user runs `horizon`, it boots the same headless runtime the
# Electron desktop app uses -- 25 AI providers, full 8-type memory,
# skills, plugins, MCP, the lot.

class Horizon < Formula
  desc "Personal AI agent that runs on your machine -- local-first, BYOK"
  homepage "https://horizonaai.dev"
  version "0.0.1"
  license "BUSL-1.1"

  on_macos do
    on_arm do
      url "https://github.com/ErnestKostevich/horizon-genesis/releases/download/cli-v0.0.1/horizon-macos-arm64"
      sha256 "SHA256_PLACEHOLDER_ARM64"
    end
    on_intel do
      url "https://github.com/ErnestKostevich/horizon-genesis/releases/download/cli-v0.0.1/horizon-macos-x64"
      sha256 "SHA256_PLACEHOLDER_X64"
    end
  end

  on_linux do
    url "https://github.com/ErnestKostevich/horizon-genesis/releases/download/cli-v0.0.1/horizon-linux-x64"
    sha256 "SHA256_PLACEHOLDER_LINUX"
  end

  def install
    # The release asset is the bare binary -- no archive to extract.
    # `Dir["*"]` picks up whatever pkg dropped in the cache (single file)
    # and installs it as `horizon` in the Homebrew bin dir.
    bin.install Dir["*"].first => "horizon"
  end

  def caveats
    <<~EOS
      Horizon stores API keys and memory in your OS user data directory:
        macOS:  ~/Library/Application Support/horizon-ai/
        Linux:  ~/.config/horizon-ai/

      First-time setup (pick a provider, paste your key, 30 seconds):
        horizon setup

      Then either launch the interactive TUI:
        horizon

      Or run a one-shot task:
        horizon "find all TODOs in this repo and group them"

      Full docs:        https://horizonaai.dev/docs
      Report bugs:      https://github.com/ErnestKostevich/horizon-genesis/issues
      License:          BUSL-1.1 (personal + non-commercial use is free)
    EOS
  end

  test do
    # `horizon version` returns the binary's build identity and exits 0.
    # Smoke-checks the binary actually loads its bundled assets.
    assert_match "Horizon", shell_output("#{bin}/horizon version 2>&1")
  end
end

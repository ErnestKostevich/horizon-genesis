# Horizon AI -- Homebrew Tap

This directory contains the canonical Homebrew formula for the Horizon
AI CLI. The actual tap repo lives at:

> https://github.com/ErnestKostevich/horizon-homebrew-tap

## Layout

```
Formula/
  horizon.rb     # the Homebrew formula
```

## Publishing workflow

The horizon-genesis monorepo is the source of truth. When a new CLI
release is cut:

1. The release workflow uploads `horizon-macos-arm64`,
   `horizon-macos-x64`, and `horizon-linux-x64` to the
   `cli-v<version>` GitHub release.
2. Run `node dist-tools/update-hashes.js` against the new release tag.
   The script computes SHA256 for each asset and rewrites the
   `sha256` lines + `version` field in `Formula/horizon.rb`.
3. Copy `Formula/horizon.rb` into the `ErnestKostevich/horizon-homebrew-tap`
   repo on the `main` branch and push.

That's it -- Homebrew picks up the new version on the user's next
`brew update`.

## User install

```bash
# One-time -- add the tap
brew tap ErnestKostevich/tap https://github.com/ErnestKostevich/horizon-homebrew-tap

# Install
brew install horizon

# First-run setup (interactive: pick provider, paste key)
horizon setup
```

## Maintainer notes

- The formula doesn't use `bottle` blocks because the upstream artefacts
  are already platform-specific binaries (no compilation step). Brew
  treats them as pre-built downloads.
- `version "0.0.1"` is overwritten by `update-hashes.js`. Don't hand-edit
  unless you're cutting a hotfix.
- The `test do` block runs `horizon version` -- requires the binary to
  load its bundled assets correctly. If that ever breaks, `brew test
  horizon` will catch it before the bottle ships.
- BUSL-1.1 is not a Homebrew-recognised SPDX shorthand for "open
  source", but `license "BUSL-1.1"` is still the right tag -- Homebrew
  CI may emit a warning we can ignore.

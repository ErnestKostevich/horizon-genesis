#!/usr/bin/env bash
# One-line installer for the Horizon CLI on Linux + macOS.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ErnestKostevich/horizon-genesis/main/scripts/install-cli.sh | bash
#
# What it does:
#   1. Checks Node 22+ is installed (prints instructions if not).
#   2. Clones the repo into ~/.horizon-cli (or pulls latest if it's already there).
#   3. Runs `npm ci --omit=dev` to skip Electron deps.
#   4. Symlinks `horizon`, `horizon-tui`, `horizon-serve` into ~/.local/bin/ (or /usr/local/bin/ if writable).
#
# Re-running is idempotent — pulls latest and re-links.

set -euo pipefail

REPO_URL="https://github.com/ErnestKostevich/horizon-genesis.git"
INSTALL_DIR="${HORIZON_INSTALL_DIR:-$HOME/.horizon-cli}"
BIN_TARGET=""

c_red()   { printf '\033[31m%s\033[0m' "$*"; }
c_green() { printf '\033[32m%s\033[0m' "$*"; }
c_cyan()  { printf '\033[36m%s\033[0m' "$*"; }
c_dim()   { printf '\033[2m%s\033[0m' "$*"; }
ok()    { echo "$(c_green '✓') $*"; }
info()  { echo "$(c_cyan 'ℹ') $*"; }
err()   { echo "$(c_red '✗') $*" >&2; }

# 1. Node check
if ! command -v node >/dev/null 2>&1; then
  err "Node.js not installed."
  echo "Install Node 22+ first:"
  echo "  • Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install nodejs"
  echo "  • macOS:         brew install node@22"
  echo "  • Or use nvm:    https://github.com/nvm-sh/nvm"
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node $NODE_MAJOR is too old. Horizon CLI needs Node 20+ (22 LTS recommended)."
  exit 1
fi
ok "Node $(node --version)"

# 2. Clone or pull
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin
  git -C "$INSTALL_DIR" reset --hard --quiet origin/main
else
  info "Cloning into $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" >/dev/null 2>&1
fi
ok "repo @ $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"

# 3. Install deps (CLI subset)
info "Installing dependencies (~30s, skips Electron)…"
cd "$INSTALL_DIR"
npm ci --omit=dev --silent >/dev/null
ok "dependencies installed"

# 4. Pick a bin target
if [ -w "/usr/local/bin" ]; then
  BIN_TARGET="/usr/local/bin"
elif [ -d "$HOME/.local/bin" ]; then
  BIN_TARGET="$HOME/.local/bin"
else
  mkdir -p "$HOME/.local/bin"
  BIN_TARGET="$HOME/.local/bin"
fi

# 5. Link
for cmd in horizon horizon-tui horizon-serve; do
  src="$INSTALL_DIR/bin/${cmd}.js"
  target="$BIN_TARGET/$cmd"
  chmod +x "$src"
  ln -sf "$src" "$target"
done
ok "binaries linked into $BIN_TARGET"

# 6. PATH check
if ! echo ":$PATH:" | grep -q ":$BIN_TARGET:"; then
  echo ""
  c_dim "Note: $BIN_TARGET isn't in your PATH. Add this to your shell config:"
  echo ""
  echo "  export PATH=\"$BIN_TARGET:\$PATH\""
  echo ""
fi

echo ""
ok "Horizon CLI ready"
echo ""
echo "  Try:"
echo "    $(c_cyan 'horizon version')             — print runtime status"
echo "    $(c_cyan 'horizon')                      — launch the TUI"
echo "    $(c_cyan 'horizon chat \"hi\"')           — single-turn chat"
echo "    $(c_cyan 'horizon serve --port 18789')  — start the HTTP API"
echo ""
echo "  $(c_dim 'Docs:  ') $INSTALL_DIR/docs/cli.md"
echo "  $(c_dim 'Server:') $INSTALL_DIR/docs/deploy.md"
echo ""

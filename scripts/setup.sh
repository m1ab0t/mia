#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIA_HOME="$HOME/.mia"

# ── Check prerequisites ─────────────────────────────────────────────

echo "==> Checking prerequisites..."

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed. Please install Node.js 18+ first."
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found v$(node -v))"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not installed."
  exit 1
fi

# ── Install system dependencies (native modules need libatomic) ──────

echo "==> Installing system dependencies..."
if command -v ldconfig >/dev/null 2>&1; then
  if ! ldconfig -p | grep -q libatomic.so.1; then
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get install -y libatomic1
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y libatomic
    elif command -v pacman >/dev/null 2>&1; then
      echo "    libatomic is included with gcc on Arch — skipping"
    else
      echo "    WARNING: libatomic not found and no known package manager detected."
      echo "    If the build fails, install libatomic manually."
    fi
  else
    echo "    libatomic already installed"
  fi
else
  echo "    Skipping libatomic check (ldconfig not available)"
fi

# ── Check for coding agents ──────────────────────────────────────────
#
# Mia requires at least one coding agent to handle coding tasks.
# We detect installed agents and provide install hints if none are found.

echo "==> Checking for coding agents..."

FOUND_AGENT=0

if command -v claude >/dev/null 2>&1; then
  echo "    ✓ claude (Claude Code)"
  FOUND_AGENT=1
fi

if command -v opencode >/dev/null 2>&1; then
  echo "    ✓ opencode"
  FOUND_AGENT=1
fi

if command -v gemini >/dev/null 2>&1; then
  echo "    ✓ gemini"
  FOUND_AGENT=1
fi

if command -v codex >/dev/null 2>&1; then
  echo "    ✓ codex"
  FOUND_AGENT=1
fi

if [ "$FOUND_AGENT" -eq 0 ]; then
  echo ""
  echo "  WARNING: No coding agents found in PATH."
  echo "  Mia needs at least one to handle coding tasks."
  echo ""
  echo "  Install one of:"
  echo "    npm install -g @anthropic-ai/claude-code   # Claude Code"
  echo "    npm install -g opencode-ai                 # opencode"
  echo "    npm install -g @openai/codex               # Codex CLI"
  echo "    npm install -g @google/gemini-cli          # Gemini CLI"
  echo ""
  echo "  Continuing setup — install an agent and run 'mia setup' to configure."
  echo ""
fi

# ── Create ~/.mia directory (daemon PID, logs, .env) ────────────────

echo "==> Creating $MIA_HOME directory..."
mkdir -p "$MIA_HOME"

# ── Install npm dependencies ─────────────────────────────────────────

echo "==> Installing npm dependencies..."
npm install --prefix "$REPO_ROOT"

# ── Build CLI ────────────────────────────────────────────────────────

echo "==> Building CLI..."
npm run build --prefix "$REPO_ROOT"

# ── Link 'mia' command globally ──────────────────────────────────────

echo "==> Linking 'mia' command globally..."
(cd "$REPO_ROOT" && { npm link 2>/dev/null || sudo npm link --force; })

# ── Kill ALL stale daemon processes, then restart ────────────────────

MIA_BIN="$REPO_ROOT/dist/cli.js"
DAEMON_JS="$REPO_ROOT/dist/daemon.js"

echo "==> Ensuring only one daemon runs..."

# Kill every mia daemon process (stale or current)
STALE_PIDS=$(pgrep -f "$DAEMON_JS" 2>/dev/null || true)
if [ -n "$STALE_PIDS" ]; then
  echo "$STALE_PIDS" | xargs kill 2>/dev/null || true
  sleep 1
  # Force-kill any survivors
  REMAINING=$(pgrep -f "$DAEMON_JS" 2>/dev/null || true)
  if [ -n "$REMAINING" ]; then
    echo "$REMAINING" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
fi

# Clean up stale PID file
rm -f "$MIA_HOME/daemon.pid"

echo "==> Starting MIA daemon..."
unset CLAUDECODE
node "$MIA_BIN" start

# ── Done ─────────────────────────────────────────────────────────────

echo ""
echo "Setup complete!"
echo ""
if [ ! -f "$MIA_HOME/.env" ]; then
  echo "Next step: configure your API key"
  echo "  mia setup"
  echo ""
fi
echo "Usage:"
echo "  mia start    Start the daemon (P2P, scheduler)"
echo "  mia status   Check daemon status"
echo "  mia help     Show all commands"

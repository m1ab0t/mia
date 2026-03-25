#!/bin/bash
set -euo pipefail

# MIA Installer for macOS and Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/m1ab0t/mia/master/install.sh | bash

BOLD='\033[1m'
ACCENT='\033[38;2;138;180;248m'       # soft blue
INFO='\033[38;2;136;146;176m'         # muted slate
SUCCESS='\033[38;2;0;229;204m'        # cyan-bright
WARN='\033[38;2;255;176;32m'          # amber
ERROR='\033[38;2;230;57;70m'          # coral
MUTED='\033[38;2;90;100;128m'         # muted
NC='\033[0m'

OS="unknown"
MIA_HOME="$HOME/.mia"
INSTALL_DIR="${MIA_INSTALL_DIR:-$HOME/mia}"
REPO_URL="https://github.com/m1ab0t/mia.git"
VERBOSE="${MIA_VERBOSE:-0}"
DRY_RUN="${MIA_DRY_RUN:-0}"
NO_START="${MIA_NO_START:-0}"
HELP=0

# ── UI helpers ──────────────────────────────────────────────────────

ui_info()    { echo -e "${MUTED}·${NC} $*"; }
ui_success() { echo -e "${SUCCESS}✓${NC} $*"; }
ui_warn()    { echo -e "${WARN}!${NC} $*"; }
ui_error()   { echo -e "${ERROR}✗${NC} $*"; }
ui_section() { echo ""; echo -e "${ACCENT}${BOLD}$1${NC}"; }
ui_kv()      { printf "  ${MUTED}%-20s${NC} %s\n" "$1" "$2"; }

# ── Argument parsing ────────────────────────────────────────────────

print_usage() {
  cat <<EOF
MIA Installer (macOS + Linux)

Usage:
  curl -fsSL https://raw.githubusercontent.com/m1ab0t/mia/master/install.sh | bash
  # or with options:
  curl -fsSL ... | bash -s -- [options]

Options:
  --dir <path>        Install directory (default: ~/mia)
  --no-start          Skip starting the daemon after install
  --dry-run           Print what would happen (no changes)
  --verbose           Print debug output
  --help, -h          Show this help

Environment variables:
  MIA_INSTALL_DIR     Install directory (default: ~/mia)
  MIA_NO_START=1      Skip starting the daemon
  MIA_DRY_RUN=1       Dry run mode
  MIA_VERBOSE=1       Verbose output

Examples:
  # Standard install
  curl -fsSL https://raw.githubusercontent.com/m1ab0t/mia/master/install.sh | bash

  # Custom directory, skip daemon start
  curl -fsSL ... | bash -s -- --dir ~/projects/mia --no-start
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir)        INSTALL_DIR="$2"; shift 2 ;;
      --no-start)   NO_START=1; shift ;;
      --dry-run)    DRY_RUN=1; shift ;;
      --verbose)    VERBOSE=1; shift ;;
      --help|-h)    HELP=1; shift ;;
      *)            shift ;;
    esac
  done
}

# ── OS detection ────────────────────────────────────────────────────

detect_os() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
  elif [[ "$OSTYPE" == "linux-gnu"* ]] || [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    OS="linux"
  fi

  if [[ "$OS" == "unknown" ]]; then
    ui_error "Unsupported operating system: $OSTYPE"
    echo "  This installer supports macOS and Linux (including WSL)."
    exit 1
  fi

  ui_success "Detected: $OS"
}

# ── Privilege helpers ───────────────────────────────────────────────

is_root() { [[ "$(id -u)" -eq 0 ]]; }

require_sudo() {
  if [[ "$OS" != "linux" ]]; then return 0; fi
  if is_root; then return 0; fi
  if command -v sudo &>/dev/null; then
    if ! sudo -n true >/dev/null 2>&1; then
      ui_info "Administrator privileges required"
      sudo -v
    fi
    return 0
  fi
  ui_error "sudo is required for system installs on Linux"
  exit 1
}

run_as_root() {
  if is_root; then "$@"; else sudo "$@"; fi
}

# ── Node.js ─────────────────────────────────────────────────────────

node_major_version() {
  if ! command -v node &>/dev/null; then return 1; fi
  local version major
  version="$(node -v 2>/dev/null || true)"
  major="${version#v}"
  major="${major%%.*}"
  if [[ "$major" =~ ^[0-9]+$ ]]; then
    echo "$major"
    return 0
  fi
  return 1
}

check_node() {
  if command -v node &>/dev/null; then
    local major
    major="$(node_major_version || true)"
    if [[ -n "$major" && "$major" -ge 18 ]]; then
      ui_success "Node.js v$(node -v | tr -d 'v') found"
      return 0
    fi
    ui_info "Node.js $(node -v) found, but v18+ required"
    return 1
  fi
  ui_info "Node.js not found"
  return 1
}

install_node() {
  if [[ "$OS" == "macos" ]]; then
    if ! command -v brew &>/dev/null; then
      ui_info "Installing Homebrew first..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      if [[ -f "/opt/homebrew/bin/brew" ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
      elif [[ -f "/usr/local/bin/brew" ]]; then
        eval "$(/usr/local/bin/brew shellenv)"
      fi
    fi
    ui_info "Installing Node.js via Homebrew..."
    brew install node@22
    brew link node@22 --overwrite --force 2>/dev/null || true
    # Ensure brew node is on PATH
    local brew_prefix
    brew_prefix="$(brew --prefix node@22 2>/dev/null || true)"
    if [[ -n "$brew_prefix" && -x "${brew_prefix}/bin/node" ]]; then
      export PATH="${brew_prefix}/bin:$PATH"
    fi
  elif [[ "$OS" == "linux" ]]; then
    require_sudo
    if command -v apt-get &>/dev/null; then
      local tmp
      tmp="$(mktemp)"
      curl -fsSL https://deb.nodesource.com/setup_22.x -o "$tmp"
      run_as_root bash "$tmp"
      run_as_root apt-get install -y -qq nodejs
      rm -f "$tmp"
    elif command -v dnf &>/dev/null; then
      local tmp
      tmp="$(mktemp)"
      curl -fsSL https://rpm.nodesource.com/setup_22.x -o "$tmp"
      run_as_root bash "$tmp"
      run_as_root dnf install -y -q nodejs
      rm -f "$tmp"
    elif command -v pacman &>/dev/null; then
      run_as_root pacman -S --noconfirm nodejs npm
    else
      ui_error "Could not detect package manager for Node.js install"
      echo "  Install Node.js 18+ manually: https://nodejs.org"
      exit 1
    fi
  fi
  ui_success "Node.js installed"
}

# ── Git ─────────────────────────────────────────────────────────────

check_git() {
  if command -v git &>/dev/null; then
    ui_success "Git found"
    return 0
  fi
  ui_info "Git not found"
  return 1
}

install_git() {
  if [[ "$OS" == "macos" ]]; then
    # xcode-select includes git
    xcode-select --install 2>/dev/null || true
    if ! command -v git &>/dev/null && command -v brew &>/dev/null; then
      brew install git
    fi
  elif [[ "$OS" == "linux" ]]; then
    require_sudo
    if command -v apt-get &>/dev/null; then
      run_as_root apt-get update -qq
      run_as_root apt-get install -y -qq git
    elif command -v dnf &>/dev/null; then
      run_as_root dnf install -y -q git
    elif command -v pacman &>/dev/null; then
      run_as_root pacman -S --noconfirm git
    fi
  fi
  ui_success "Git installed"
}

# ── System dependencies ─────────────────────────────────────────────

install_system_deps() {
  if [[ "$OS" != "linux" ]]; then return 0; fi

  # libatomic is required by native Node modules (better-sqlite3, hyperswarm)
  if command -v ldconfig &>/dev/null; then
    if ! ldconfig -p 2>/dev/null | grep -q libatomic.so.1; then
      ui_info "Installing libatomic..."
      require_sudo
      if command -v apt-get &>/dev/null; then
        run_as_root apt-get install -y -qq libatomic1
      elif command -v dnf &>/dev/null; then
        run_as_root dnf install -y -q libatomic
      elif command -v pacman &>/dev/null; then
        ui_info "libatomic included with gcc on Arch — skipping"
      else
        ui_warn "libatomic not found and no known package manager detected"
        ui_warn "If the build fails, install libatomic manually"
      fi
      ui_success "System dependencies installed"
    else
      ui_success "libatomic already present"
    fi
  else
    ui_info "Skipping libatomic check (ldconfig not available)"
  fi
}

# ── Coding agents check ────────────────────────────────────────────

check_coding_agents() {
  local found=0

  if command -v claude &>/dev/null; then
    ui_success "claude (Claude Code) found"
    found=1
  fi
  if command -v gemini &>/dev/null; then
    ui_success "gemini (Gemini CLI) found"
    found=1
  fi
  if command -v opencode &>/dev/null; then
    ui_success "opencode found"
    found=1
  fi
  if command -v codex &>/dev/null; then
    ui_success "codex found"
    found=1
  fi

  if [[ "$found" -eq 0 ]]; then
    echo ""
    ui_warn "No coding agents found in PATH"
    echo "  MIA needs at least one to handle coding tasks."
    echo ""
    echo "  Install one of:"
    echo "    npm install -g @anthropic-ai/claude-code   # Claude Code (recommended)"
    echo "    npm install -g opencode-ai                 # OpenCode"
    echo "    npm install -g @openai/codex               # Codex CLI"
    echo "    # gemini CLI                               # Gemini"
    echo ""
    echo "  Continuing — install an agent later and run 'mia setup'."
    echo ""
  fi
}

# ── Clone / update repository ──────────────────────────────────────

clone_or_update_repo() {
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    ui_info "Existing MIA checkout found at $INSTALL_DIR"
    if [[ -z "$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null || true)" ]]; then
      ui_info "Pulling latest changes..."
      git -C "$INSTALL_DIR" pull --rebase || true
    else
      ui_warn "Local changes detected — skipping git pull"
    fi
  else
    ui_info "Cloning MIA to $INSTALL_DIR..."
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
  ui_success "Source code ready"
}

# ── Build ───────────────────────────────────────────────────────────

build_mia() {
  ui_info "Installing npm dependencies..."
  npm install --prefix "$INSTALL_DIR"
  ui_success "Dependencies installed"

  ui_info "Building CLI..."
  npm run build --prefix "$INSTALL_DIR"
  ui_success "Build complete"
}

# ── Link globally ──────────────────────────────────────────────────

link_mia() {
  ui_info "Linking 'mia' command globally..."

  # Try npm link, fall back to sudo
  if (cd "$INSTALL_DIR" && npm link 2>/dev/null); then
    ui_success "'mia' linked globally"
    return 0
  fi

  if [[ "$OS" == "linux" ]]; then
    require_sudo
    (cd "$INSTALL_DIR" && sudo npm link --force)
  elif [[ "$OS" == "macos" ]]; then
    (cd "$INSTALL_DIR" && sudo npm link --force)
  fi
  ui_success "'mia' linked globally"
}

# ── Create runtime directory ───────────────────────────────────────

setup_mia_home() {
  mkdir -p "$MIA_HOME"
  ui_success "~/.mia directory ready"
}

# ── Kill stale daemons ──────────────────────────────────────────────

kill_stale_daemons() {
  local daemon_js="$INSTALL_DIR/dist/daemon.js"
  local stale_pids
  stale_pids="$(pgrep -f "$daemon_js" 2>/dev/null || true)"

  if [[ -n "$stale_pids" ]]; then
    ui_info "Stopping stale daemon processes..."
    echo "$stale_pids" | xargs kill 2>/dev/null || true
    sleep 1
    # Force-kill survivors
    local remaining
    remaining="$(pgrep -f "$daemon_js" 2>/dev/null || true)"
    if [[ -n "$remaining" ]]; then
      echo "$remaining" | xargs kill -9 2>/dev/null || true
      sleep 1
    fi
  fi

  rm -f "$MIA_HOME/daemon.pid"
}

# ── Start daemon ────────────────────────────────────────────────────

start_daemon() {
  if [[ "$NO_START" == "1" ]]; then
    ui_info "Skipping daemon start (--no-start)"
    return 0
  fi

  ui_info "Starting MIA daemon..."
  unset CLAUDECODE 2>/dev/null || true
  node "$INSTALL_DIR/dist/cli.js" start
  ui_success "Daemon started"
}

# ── P2P connection + QR ─────────────────────────────────────────

show_p2p_qr() {
  if [[ "$NO_START" == "1" ]]; then
    ui_info "Skipping P2P (daemon not started)"
    return 0
  fi

  # The daemon needs a few seconds to initialise P2P after starting.
  # Poll daemon.status.json until p2pKey appears or we time out.
  ui_info "Waiting for P2P connection..."
  local attempts=0
  local max_attempts=20  # 20 x 1s = 20s max wait
  local p2p_key=""

  while [[ $attempts -lt $max_attempts ]]; do
    if [[ -f "$MIA_HOME/daemon.status.json" ]]; then
      p2p_key="$(node -e "
        try {
          const s = require('fs').readFileSync('$MIA_HOME/daemon.status.json', 'utf8');
          const d = JSON.parse(s);
          if (d.p2pKey) process.stdout.write(d.p2pKey);
        } catch {}
      " 2>/dev/null || true)"
      if [[ -n "$p2p_key" ]]; then break; fi
    fi
    sleep 1
    attempts=$((attempts + 1))
  done

  if [[ -z "$p2p_key" ]]; then
    ui_warn "P2P not ready yet — run mia p2p qr later to pair"
    return 0
  fi

  ui_success "P2P online  ${MUTED}key ${p2p_key:0:16}...${NC}"

  # Render a compact QR code directly — skip the mia p2p qr wrapper
  # to avoid extra headers/separators that add visual noise.
  echo ""
  echo -e "  ${BOLD}Scan to pair with the MIA mobile app${NC}"
  echo ""
  node -e "
    const qr = require('qrcode-terminal');
    const key = Buffer.from('${p2p_key}', 'hex').toString('base64');
    qr.generate(key, { small: true }, (code) => {
      // Strip leading/trailing blank lines, indent for alignment
      const lines = code.split('\n').filter(l => l.trim().length > 0);
      console.log(lines.map(l => '  ' + l).join('\n'));
    });
  " 2>/dev/null || true
  echo ""
}

# ── Banner ──────────────────────────────────────────────────────────

print_banner() {
  echo ""
  echo -e "${ACCENT}${BOLD}"
  echo "  ╔══════════════════════════════╗"
  echo "  ║        MIA Installer         ║"
  echo "  ╚══════════════════════════════╝"
  echo -e "${NC}${MUTED}  AI coding agent · P2P sync · plugin system${NC}"
  echo ""
}

# ── Install plan ────────────────────────────────────────────────────

show_install_plan() {
  ui_section "Install plan"
  ui_kv "OS" "$OS"
  ui_kv "Install directory" "$INSTALL_DIR"
  ui_kv "Runtime directory" "$MIA_HOME"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    ui_kv "Mode" "update existing"
  else
    ui_kv "Mode" "fresh install"
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    ui_kv "Dry run" "yes"
  fi
  if [[ "$NO_START" == "1" ]]; then
    ui_kv "Start daemon" "no"
  fi
  echo ""
}

# ── Completion message ──────────────────────────────────────────────

print_completion() {
  local is_upgrade="$1"

  echo ""
  if command -v mia &>/dev/null; then
    local version
    version="$(mia --version 2>/dev/null | head -n1 || echo "installed")"
    echo -e "  ${SUCCESS}${BOLD}MIA installed successfully (${version})${NC}"
  else
    echo -e "  ${SUCCESS}${BOLD}MIA installed successfully${NC}"
  fi

  if [[ "$is_upgrade" == "true" ]]; then
    echo -e "  ${MUTED}Upgraded and ready to go.${NC}"
  else
    echo -e "  ${MUTED}Welcome. Let's build something.${NC}"
  fi

  echo ""

  if [[ ! -f "$MIA_HOME/.env" ]]; then
    echo -e "  ${WARN}Next step:${NC} configure your API key"
    echo "    mia setup"
    echo ""
  fi

  echo "  Usage:"
  echo "    mia start       # start the daemon"
  echo "    mia status      # check daemon status"
  echo "    mia p2p qr      # show QR code for mobile pairing"
  echo "    mia doctor      # health diagnostics"
  echo "    mia help        # all commands"
  echo ""

  echo -e "  ${MUTED}Docs: https://docs.mia.run${NC}"
  echo ""
}

# ── Main ────────────────────────────────────────────────────────────

main() {
  if [[ "$HELP" == "1" ]]; then
    print_usage
    return 0
  fi

  if [[ "$VERBOSE" == "1" ]]; then
    set -x
  fi

  print_banner
  detect_os

  local is_upgrade=false
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    is_upgrade=true
  fi

  show_install_plan

  if [[ "$DRY_RUN" == "1" ]]; then
    ui_success "Dry run complete (no changes made)"
    return 0
  fi

  # ── Step 1: Prerequisites ─────────────────────────────────────────
  ui_section "[1/6] Checking prerequisites"

  if ! check_node; then
    install_node
  fi

  if ! check_git; then
    install_git
  fi

  install_system_deps
  check_coding_agents

  # ── Step 2: Source code ───────────────────────────────────────────
  ui_section "[2/6] Getting source code"
  clone_or_update_repo

  # ── Step 3: Build ─────────────────────────────────────────────────
  ui_section "[3/6] Building MIA"
  build_mia

  # ── Step 4: Install ──────────────────────────────────────────────
  ui_section "[4/6] Installing"
  setup_mia_home
  link_mia

  # ── Step 5: Start ────────────────────────────────────────────────
  ui_section "[5/6] Starting up"
  kill_stale_daemons
  start_daemon

  # ── Step 6: P2P ─────────────────────────────────────────────────
  ui_section "[6/6] P2P connection"
  show_p2p_qr

  # ── Done ──────────────────────────────────────────────────────────
  print_completion "$is_upgrade"
}

parse_args "$@"
main

# mia

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Your AI coding assistant, controlled from your phone.

> Mia runs as a daemon on your dev machine, connects to your phone over encrypted P2P, and delegates tasks to best-in-class coding agents — all from your pocket.

## Table of Contents

- [mia](#mia)
  - [Table of Contents](#table-of-contents)
  - [What is Mia?](#what-is-mia)
  - [How It Works](#how-it-works)
  - [Coding Agent Plugins](#coding-agent-plugins)
  - [Installation](#installation)
  - [Docker](#docker)
  - [Quick Start](#quick-start)
  - [Usage](#usage)
    - [Mobile App](#mobile-app)
    - [CLI Interface](#cli-interface)
    - [Daemon Mode](#daemon-mode)
    - [Command Reference](#command-reference)
    - [P2P Networking](#p2p-networking)
  - [Configuration](#configuration)
  - [Architecture](#architecture)
  - [Acknowledgements](#acknowledgements)
  - [License](#license)

## What is Mia?

Mia is a mobile-first AI coding assistant. It runs as a background daemon on your machine, pairs with your phone over encrypted P2P networking, and delegates coding tasks to pluggable AI agents. No cloud servers. No intermediaries. Just your phone talking directly to your dev machine.

**Key Features:**
- **Mobile-First** — Control your coding assistant from your phone. Chat, switch agents, manage tasks — all from the Mia mobile app
- **Pluggable Agents** — Claude Code, Gemini, OpenCode, or OpenAI Codex — swap at any time from your phone or CLI
- **P2P Sync** — Real-time encrypted sync between your phone and dev machine via Hyperswarm DHT. No servers, no port forwarding
- **Persistent Memory** — Mia remembers context across sessions via SQLite FTS5 with BM25 ranking
- **AI Personas** — Create custom AI personalities with different system prompts, generate them from descriptions, or manage them from the mobile app
- **Workflow Commands** — `commit`, `standup`, `changelog`, scheduled tasks, and more
- **Daemon + Scheduler** — Background service with cron-based task scheduling

## How It Works

```
┌──────────────┐     Hyperswarm DHT     ┌──────────────┐
│  Your Phone  │◄══════════════════════►│  Mia Daemon  │
│  (Mia App)   │   Encrypted P2P conn   │  (your PC)   │
└──────────────┘                        └──────┬───────┘
                                               │
                                    ┌──────────┼──────────┐
                                    │          │          │
                                    ▼          ▼          ▼
                                 Plugins    Memory    Scheduler
                                 (Claude,   (SQLite   (cron
                                  Gemini,    FTS5)     tasks)
                                  Codex...)
```

1. Install Mia on your dev machine and run `mia setup`
2. Scan the QR code with the Mia mobile app
3. Chat with your AI coding assistant from anywhere — it has full access to your codebase

## Coding Agent Plugins

Mia treats each coding agent as a first-class plugin. Switch between them from the mobile app or CLI without changing your workflow.

| Plugin | Description | Requirements |
|--------|-------------|--------------|
| **Claude Code** | Anthropic's agentic coding assistant | `npm install -g @anthropic-ai/claude-code` |
| **Gemini** | Google Gemini via the `gemini` CLI | `gemini` CLI installed, Google account |
| **OpenCode** | Open-source, provider-agnostic coding agent | `npm install -g opencode-ai` |
| **OpenAI Codex** | OpenAI's coding agent | `npm install -g @openai/codex`, `OPENAI_API_KEY` |

## Installation

```bash
git clone https://github.com/m1ab0t/mia.git
cd mia
npm install
npm run build
npm link
```

## Docker

Run the daemon in a container with persistent data and P2P networking:

```bash
docker compose up -d

# Check status
docker compose logs mia
docker exec mia-daemon node dist/cli.js status
```

Or build and run manually:

```bash
docker build -t mia .
docker run -d --name mia-daemon \
  --network host \
  -v ~/.mia:/home/mia/.mia \
  --restart unless-stopped \
  mia
```

The host's `~/.mia` directory is bind-mounted into the container, so `mia setup` on the host configures the container too. `network_mode: host` is required for Hyperswarm's UDP hole-punching.

## Quick Start

```bash
mia setup   # first-time setup: configures auth, active plugin, and preferences
mia start   # start the background daemon
mia p2p qr  # show QR code — scan with the Mia mobile app
```

That's it. Open the Mia app on your phone, scan the QR code, and start chatting. Your AI assistant has full codebase context and can execute tasks on your machine.

You can also use Mia directly from the terminal:

```bash
mia chat                    # interactive chat
mia ask "explain the auth flow"
mia commit                  # AI-generated commit message
```

## Usage

### Mobile App

The Mia mobile app (React Native/Expo) is the primary way to interact with Mia. It connects to your daemon over encrypted P2P — no servers, no cloud.

**Features:**
- Real-time streaming AI responses
- Switch between coding agents (Claude Code, Gemini, Codex, OpenCode)
- Conversation management (create, rename, delete, search)
- AI persona management (create, edit, delete, generate from description)
- Scheduler management (create and monitor cron tasks)
- QR code pairing — scan once, auto-reconnects
- Full markdown rendering with syntax highlighting
- Inline tool output with collapsible summaries
- Slash commands (`/standup`, `/doctor`, `/usage`, `/memory`, `/config`, `/log`, `/recap`, `/changelog`, `/persona`, `/mode`, `/status`, `/update`, `/help`)

### CLI Interface

The CLI is used for setup, daemon management, and power-user workflows.

```bash
mia                  # interactive chat
mia chat             # same as above
mia ask "prompt"     # single prompt, non-interactive
git diff | mia ask --raw "write a commit message"

mia chat --resume chat-20240115-abc   # resume a conversation
mia chat --list                        # list saved conversations
```

### Daemon Mode

```bash
mia start    # start the background daemon
mia status   # check daemon status
mia logs     # stream logs
mia stop     # stop the daemon
mia restart
```

### Command Reference

| Command | Description |
|---------|-------------|
| `mia` / `mia chat` | Interactive multi-turn conversation |
| `mia ask <prompt>` | Single prompt, non-interactive |
| `mia setup` | First-time setup wizard |
| `mia start / stop / restart / status / logs` | Daemon lifecycle |
| `mia commit` | AI-generated commit message from staged diff |
| `mia standup` | AI standup from recent commits and mia activity |
| `mia changelog` | AI-generated changelog from git history |
| `mia doctor` | Workspace health diagnostics |
| `mia config [get\|set]` | View and edit runtime configuration |
| `mia logs` | Daemon log viewer |
| `mia log` | Recent dispatch history with git context |
| `mia usage [today\|week\|all]` | Token usage and activity stats |
| `mia memory [list\|search\|add\|stats]` | Persistent memory management |
| `mia plugin [list\|switch\|info\|test]` | Manage coding agent plugins |
| `mia persona [list\|set\|show]` | Manage AI personas |
| `mia scheduler [list\|add\|delete\|start\|stop\|test]` | Cron task management |
| `mia recap [--yesterday\|--date\|--json]` | Daily dispatch digest |
| `mia update` | Pull latest, rebuild, restart daemon |
| `mia self-rebuild` | Rebuild local code, graceful restart |
| `mia mode [coding\|general]` | Switch interaction mode (full context vs lightweight) |
| `mia p2p [status\|qr\|refresh]` | P2P connection and pairing |

Run `mia help` or `mia <command> --help` for full flag reference.

### P2P Networking

```bash
mia start          # daemon starts P2P automatically
mia p2p status     # connection status
mia p2p qr         # show QR code for mobile pairing
mia p2p refresh    # rotate seed and reconnect
```

## Configuration

Runtime config lives at `~/.mia/mia.json`. Secrets go in `~/.mia/.env`.

```bash
mia config set activePlugin gemini     # gemini | claude-code | opencode | codex
mia config set maxConcurrency 5
```

```bash
# ~/.mia/.env
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...          # or use Google OAuth via mia setup
MIA_MAX_ITERATIONS=15
```

Memory is stored at `~/.mia/memory.db`.

## Architecture

**Core:**
- **Plugin System**: Claude Code, Gemini, OpenCode, and Codex as independently-loadable plugins; hot-swap via mobile app or `SIGUSR2`
- **Modular Commands**: Each command is a focused module under `src/daemon/commands/`
- **Streaming**: Full streaming with delta accumulation; token tracking built-in

**Storage & Scheduling:**
- **Memory**: SQLite FTS5 with BM25 ranking for full-text search
- **Scheduler**: Cron-based task scheduling (`node-cron`)
- **Persistence**: Conversations, tool outputs, and personas persist across restarts

**P2P Networking:**
- **Hyperswarm DHT**: Secure, serverless peer-to-peer connections
- **Real-time Sync**: Message relay between mobile app and daemon
- **QR Pairing**: Zero-config via `qrcode-terminal`

**Stack:** TypeScript · ESM · Anthropic SDK · SQLite · Hyperswarm · Vitest · esbuild

## Acknowledgements

Mia's P2P networking is built on top of the work by the [Holepunch](https://holepunch.to) team. Massive thanks for making decentralised, encrypted networking accessible to everyone:

- [Hyperswarm](https://github.com/holepunchto/hyperswarm) (MIT)
- [HyperDB](https://github.com/holepunchto/hyperdb) (Apache-2.0)

## License

[Apache-2.0](LICENSE)

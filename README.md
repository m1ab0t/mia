# mia

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A distributed AI coding assistant with P2P networking, pluggable coding agent support, and developer workflow commands.

> mia knows your codebase, syncs across devices, and delegates specialized coding tasks to best-in-class coding agents.

## Table of Contents

- [What is mia?](#what-is-mia)
- [Coding Agent Plugins](#coding-agent-plugins)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Usage](#usage)
  - [CLI Interface](#cli-interface)
  - [Daemon Mode](#daemon-mode)
  - [Command Reference](#command-reference)
  - [Mobile App](#mobile-app)
  - [P2P Mode](#p2p-mode)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [License](#license)

## What is mia?

mia is a distributed AI coding agent that runs on your machine, syncs across devices via P2P networking, and delegates complex tasks to pluggable coding agents. Supports Claude (Anthropic) and Gemini (Google) as active backends, with more via the plugin system.

**Key Features:**
- **Pluggable Backends**: Claude Code, Gemini, OpenCode, or OpenAI Codex — switch at any time
- **AI Workflow Commands**: `commit`, `standup`, `changelog`, and more
- **P2P Sync**: Conversations sync in real-time across CLI and mobile using Hyperswarm DHT
- **Daemon + Scheduler**: Background service with cron-based task scheduling
- **Vector Memory**: Persistent memory across sessions via LanceDB with ONNX reranking

## Coding Agent Plugins

mia treats each coding agent as a first-class plugin. Switch between them at any time without changing your workflow.

| Plugin | Description | Requirements |
|--------|-------------|--------------|
| **Claude Code** | Anthropic's agentic coding assistant | `npm install -g @anthropic-ai/claude-code` |
| **Gemini** | Google Gemini via the `gemini` CLI | `gemini` CLI installed, Google account |
| **OpenCode** | Open-source, provider-agnostic coding agent | `npm install -g opencode-ai` |
| **OpenAI Codex** | OpenAI's coding agent | `npm install -g @openai/codex`, `OPENAI_API_KEY` |

```bash
mia plugin list
mia plugin switch gemini
mia plugin switch claude-code
mia plugin info gemini
```

## Installation

mia is installed from source.

```bash
git clone https://github.com/m1ab0t/mia.git
cd mia
npm install
npm run build
npm run link
```

## Quick Start

```bash
mia setup   # first-time setup: configures auth, active plugin, and preferences
mia         # start chatting
```

```
> Read the package.json and tell me about this project
> Refactor src/auth.ts to use async/await
> Run the tests and fix any failures
```

## Usage

### CLI Interface

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
| `mia log` | Recent dispatch history with git context |
| `mia usage [today\|week\|all]` | Token usage and activity stats |
| `mia memory [list\|search\|add\|stats]` | Persistent memory management |
| `mia plugin [list\|switch\|info\|test]` | Manage coding agent plugins |
| `mia scheduler [list\|add\|delete\|start\|stop\|test]` | Cron task management |
| `mia p2p [status\|qr\|refresh]` | P2P connection and pairing |

Run `mia help` or `mia <command> --help` for full flag reference.

### Mobile App

A React Native mobile client is available as a separate project. It connects to the daemon over Hyperswarm P2P — conversations continue seamlessly across devices.

**Features:**
- Real-time sync with the CLI daemon (no server required)
- QR code pairing — scan once, stays connected
- Live plugin switching via `mia plugin switch`
- Inline tool output with collapsible pill summaries
- Auto-reconnect on foreground, full markdown rendering

### P2P Mode

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

Memory is stored at `~/.mia/memory.lance`.

## Architecture

**Core:**
- **Plugin System**: Claude Code, Gemini (`gemini` CLI), OpenCode (`@opencode-ai/sdk`), and Codex as independently-loadable plugins; hot-swap via `SIGUSR2`
- **Modular Commands**: Each CLI command is a focused module under `src/daemon/commands/`
- **Streaming**: Full streaming with delta accumulation; token tracking built-in

**Storage & Scheduling:**
- **Memory**: LanceDB vector store with ONNX reranking
- **Scheduler**: Cron-based task scheduling (`node-cron`)
- **Persistence**: Intermediate tool outputs preserved across conversation switches

**P2P Networking:**
- **Hyperswarm DHT**: Secure, serverless peer-to-peer connections
- **Real-time Sync**: Message relay between CLI and mobile
- **QR Pairing**: Zero-config via `qrcode-terminal`

**Stack:** TypeScript · ESM · Anthropic SDK · LanceDB · Hyperswarm · Vitest · esbuild

## Acknowledgements

MIA's P2P networking is built on top of the work by the [Holepunch](https://holepunch.to) team. Massive thanks for making decentralised, encrypted networking accessible to everyone:

- [Hyperswarm](https://github.com/holepunchto/hyperswarm) (MIT)
- [HyperDB](https://github.com/holepunchto/hyperdb) (Apache-2.0)

## License

[Apache-2.0](LICENSE)

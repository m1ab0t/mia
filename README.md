# mia

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Anthropic](https://img.shields.io/badge/Anthropic-Claude-blue)](https://www.anthropic.com)

A distributed AI coding assistant with P2P networking, native tool calling, and pluggable coding agent support. Powered by Claude.

> mia knows your codebase, syncs across devices, and delegates specialized coding tasks to best-in-class coding agents.

## Table of Contents

- [What is mia?](#what-is-mia)
- [Features](#features)
- [Coding Agent Plugins](#coding-agent-plugins)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Built-in Tools](#built-in-tools)
- [Usage](#usage)
  - [CLI Interface](#cli-interface)
  - [Daemon Mode](#daemon-mode)
  - [AI Workflow Commands](#ai-workflow-commands)
  - [Developer Utilities](#developer-utilities)
  - [Full Command Reference](#full-command-reference)
  - [Authentication](#authentication)
  - [Mobile App](#mobile-app)
  - [P2P Mode](#p2p-mode)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

## What is mia?

mia is a distributed AI coding agent that runs on your machine, syncs across devices via P2P networking, and intelligently routes conversations between CLI and mobile interfaces. It uses the Anthropic Claude API and the **Hyperswarm** protocol for peer-to-peer agent communication.

When complex coding tasks require a specialized environment, mia **delegates to pluggable coding agents** such as Claude Code or OpenCode — treating each as a first-class plugin.

**Key Features:**
- **Claude-Powered**: Uses the Anthropic Claude API with support for Claude Max subscription auth
- **Pluggable Coding Agents**: Delegate specialized coding tasks to Claude Code, OpenCode, or OpenAI Codex
- **30+ AI Workflow Commands**: `commit`, `pr`, `review`, `test`, `debug`, `refactor`, `scaffold`, `migrate`, `plan`, `task`, and more
- **P2P Sync**: Conversations sync in real-time across CLI and mobile using Hyperswarm DHT
- **Daemon + Scheduler**: Background service with cron-based task scheduling
- **Vector Memory**: Persistent memory across sessions via LanceDB with ONNX reranking
- **Message Persistence**: Tool outputs preserved across conversation switches

## Features

**Core Capabilities:**
- **AI Workflow Commands**: 30+ commands covering your full dev workflow
- **P2P Sync**: Real-time conversation sync across devices using Hyperswarm DHT
- **Pluggable Coding Agents**: Claude Code, OpenCode, OpenAI Codex as first-class plugins
- **Daemon Scheduler**: Background tasks with cron scheduling
- **Token Efficient**: Minimal system prompt, native tool calling reduces overhead
- **Codebase Context**: Automatic injection of project structure, languages, and file paths
- **Message Persistence**: Intermediate tool outputs preserved across conversation switches

**LLM & Tools:**
- **Claude API**: Anthropic Claude via `@anthropic-ai/sdk`
- **Native Tool Calling**: OpenAI-compatible function calling for reliable execution
- **File Operations**: Execute shell commands, write files, and edit code
- **Code Editing**: `search_and_replace` and `apply_diff` for precise modifications
- **Memory & Scheduling**: Persistent vector memory (LanceDB) and cron-based tasks
- **Web Access**: Built-in web search and HTTP request capabilities
- **Semantic Search**: Natural-language code search across your codebase

**Interfaces:**
- **CLI**: Interactive terminal interface
- **Daemon Mode**: Background service
- **Mobile App**: React Native/Expo app with QR code pairing (separate repo: `mia-expo`)

## Coding Agent Plugins

mia supports **pluggable coding agents** for complex, multi-step coding tasks. Rather than being locked into a single coding agent, mia treats each as a first-class plugin.

| Plugin | Description | Requirements |
|--------|-------------|--------------|
| **Claude Code** | Anthropic's agentic coding assistant | `npm install -g @anthropic-ai/claude-code` |
| **OpenCode** | Open-source, provider-agnostic coding agent | `npm install -g opencode-ai` |
| **OpenAI Codex** | OpenAI's coding agent | `npm install -g @openai/codex`, `OPENAI_API_KEY` |

Switch between plugins at any time:

```bash
mia plugin list
mia plugin switch opencode
mia plugin switch claude-code
mia plugin info opencode
```

## Installation

mia is installed from source.

```bash
git clone https://github.com/rjmacarthy/mia.git
cd mia
npm install
npm run build
npm run link
```

Or use the automated setup script:

```bash
npm run setup
```

## Quick Start

1. **Install mia** (see above)

2. **Authenticate** with your Anthropic API key or Claude Max subscription:
   ```bash
   mia auth
   ```
   This walks you through linking a Claude Max/Pro subscription via `claude setup-token`, or lets you paste an API key directly. The token is saved to `~/.mia/.env`.

3. **Start mia**:
   ```bash
   mia
   ```

```
> Read the package.json and tell me about this project
> Create a new utility function in src/utils/
> Fix the bug in the authentication module
> Run the tests and show me the results
```

## Built-in Tools

| Tool | Description |
|------|-------------|
| `execute_command` | Run any shell command (cat, grep, ls, git, curl, etc.) |
| `write_to_file` | Create new files or overwrite existing ones |
| `search_and_replace` | Find and replace text in files (exact match) |
| `apply_diff` | Apply multi-line changes with line number context |
| `memory` | Store and retrieve persistent information across sessions |
| `scheduler` | Schedule cron-based tasks |
| `web` | Search the web and make HTTP requests |
| `attempt_completion` | Signal task completion with summary |

## Usage

### CLI Interface

```bash
# Start interactive chat
mia chat

# Or simply run mia with no arguments
mia

# Send a single prompt
mia ask "what does this codebase do"

# Pipe input
git diff | mia ask --raw "write a commit message"
```

**In-session commands:**

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `/tokens` | Show token usage statistics |
| `/exit` | Exit the application |

**Chat flags:**

```bash
mia chat --resume chat-20240115-abc   # resume a previous conversation
mia chat --list                        # list saved conversations
```

### Daemon Mode

Run mia as a background service:

```bash
mia start    # start the daemon
mia status   # check status
mia logs     # stream logs
mia stop     # stop the daemon
mia restart  # restart the daemon
```

### AI Workflow Commands

mia includes AI-powered commands that integrate directly into your development workflow.

#### mia commit

Generate a conventional commit message from your staged diff:

```bash
mia commit              # generate and confirm
mia commit --all        # stage everything first
mia commit --dry-run    # preview without committing
mia commit --push       # commit and push
mia commit --yes        # skip confirmation
mia commit --message-only  # print just the message (for piping)
```

#### mia pr

Generate a pull request title and description, then create it via `gh`:

```bash
mia pr                  # auto-detect base branch
mia pr --base main      # specify base branch
mia pr --draft          # create as a draft
mia pr --dry-run        # preview without creating
mia pr --push           # push branch before creating
mia pr --yes --web      # skip confirmation, open in browser
mia pr --title-only     # print just the title
```

#### mia review

AI code review with a structured verdict (LGTM / MINOR_ISSUES / NEEDS_WORK):

```bash
mia review              # review staged changes
mia review --staged     # staged changes only
mia review --unstaged   # unstaged changes only
mia review --base main  # branch diff vs base
mia review --file src/auth.ts  # scope to a single file
mia review --raw        # plain text for piping
```

#### mia standup

Generate an AI standup report from recent commits and mia activity:

```bash
mia standup                          # today (last 24 hours)
mia standup --yesterday              # yesterday's window
mia standup --hours 48               # custom look-back
mia standup --repos ~/a,~/b          # include multiple repos
mia standup --raw                    # plain text for piping
```

#### mia changelog

Generate an AI-powered changelog from your git history:

```bash
mia changelog                        # last tag to HEAD
mia changelog --from v1.0.0 --to v2.0.0
mia changelog --version 1.3.0
mia changelog --write                # prepend to CHANGELOG.md
mia changelog --dry-run
```

#### mia explain

AI explanation of any file, directory, function, or concept:

```bash
mia explain src/auth.ts
mia explain src/auth/
mia explain src/auth.ts --fn verifyToken
mia explain --query "how does the plugin delegation work"
mia explain src/auth.ts --depth deep   # shallow | normal | deep
```

#### mia test

Generate a test file for any source file:

```bash
mia test src/utils.ts               # print to stdout
mia test src/utils.ts --write       # write alongside source
mia test src/utils.ts --run         # write and run immediately
mia test src/utils.ts --output src/__tests__/utils.test.ts
mia test src/utils.ts --runner vitest  # vitest | jest | mocha | node
```

#### mia debug

AI error forensics — root cause, location, and fix:

```bash
mia debug "TypeError: foo is undefined"
mia debug --file src/auth.ts "null ref"
mia debug --depth deep "ECONNREFUSED"
npm test 2>&1 | mia debug --raw
```

#### mia refactor

AI-powered code refactoring with optional write-back:

```bash
mia refactor src/auth.ts "split into smaller functions"
mia refactor src/utils.ts --goal "modernize async/await"
mia refactor src/utils.ts "improve errors" --write
mia refactor src/db.ts --write --diff    # show coloured diff after write
```

#### mia scaffold

Generate a new file following your codebase patterns:

```bash
mia scaffold src/utils/date.ts "date formatting"
mia scaffold src/services/email.ts --desc "email sender"
mia scaffold src/utils/date.ts --write
```

#### mia migrate

AI codebase-wide migration — apply a consistent change across many files:

```bash
mia migrate "convert require() to import" --dir src
mia migrate "replace var with const" --dir src --write
mia migrate "add JSDoc" --files src/a.ts,src/b.ts
mia migrate "goal" --ext .ts,.js --max-files 30
```

#### mia suggest

AI proactive improvement suggestions across security, perf, types, tests, and maintainability:

```bash
mia suggest src/auth.ts
mia suggest src/auth.ts --category security
mia suggest src/ --limit 5
mia suggest src/auth.ts --apply    # refactor and write back high-priority fixes
```

#### mia plan

AI task decomposition — break a complex goal into numbered, prioritised steps:

```bash
mia plan "migrate from Express to Fastify"
mia plan "add OAuth" --depth deep
mia plan "add OAuth" --write          # save to plan.md
mia plan "add OAuth" --output my-plan.md
```

#### mia task

AI multi-step autonomous task execution:

```bash
mia task "add JWT auth to the API"
mia task "goal" --max-steps 5
mia task "goal" --dry-run             # plan only, no execution
mia task "add tests" --cwd ~/project
```

#### mia todo

Scan codebase for TODO/FIXME/HACK/XXX/BUG debt markers and optionally resolve them:

```bash
mia todo                              # scan all markers
mia todo --path src/auth/
mia todo --type fixme,bug
mia todo --fix 3                      # AI-resolve item #3
mia todo --analyze                    # AI-prioritise all markers
```

#### mia audit

Security audit — package vulnerabilities, secret scanning, AI-synthesized report:

```bash
mia audit
mia audit --dir ~/project
mia audit --no-secrets                # skip secret scanning
mia audit --raw > report.txt
mia audit --json
```

#### mia coverage

Coverage-aware test generation — reads Istanbul/v8 report, generates targeted tests:

```bash
mia coverage                          # process all under-covered files
mia coverage src/utils.ts             # target a specific file
mia coverage --threshold 90           # target files below 90%
mia coverage --write                  # write test files to disk
mia coverage --write --run            # write and run immediately
```

#### mia watch

Watch files and automatically dispatch AI prompts on save:

```bash
mia watch                             # review mode (default)
mia watch --mode test                 # review | test | fix | docs
mia watch --prompt "Review security implications of: {files}"
mia watch --debounce 3000 --min-interval 10000
mia watch --dry-run
```

#### mia fix

Run a command and automatically fix failures in a loop:

```bash
mia fix "npm test"
mia fix --max-retries 3 "npm test"
mia fix --prompt "this project uses pnpm" "pnpm test"
```

#### mia run

Run a command with optional auto-fix on failure:

```bash
mia run "npm test"
mia run "npm test" --max-retries 5
mia run "npm test" --no-fix
mia run "npm test" --yes
mia run "npm test" --timeout 60000
```

#### mia search

Semantic code search — find files by natural language:

```bash
mia search "where is auth handled"
mia search --files "auth" | xargs mia explain
mia search --limit 5 "payments"
mia search --pattern "*.ts" "async queue"
```

#### mia recap

Daily digest of dispatches, commits, and tools used:

```bash
mia recap
mia recap --yesterday
mia recap --date 2026-01-15
mia recap --json
```

### Developer Utilities

#### mia doctor

Workspace health diagnostics — daemon status, plugin availability, API key config, memory health, scheduler state:

```bash
mia doctor
```

#### mia config

View and edit mia's runtime configuration:

```bash
mia config                            # show all config
mia config get activePlugin
mia config set activePlugin opencode
mia config set maxConcurrency 5
```

#### mia log

Browse recent dispatch history with git context:

```bash
mia log                               # last 20 dispatches
mia log --n 50
mia log --failed
mia log --conv chat-20240115-abc
```

#### mia usage

View token usage and activity stats:

```bash
mia usage today
mia usage week
mia usage all
```

#### mia memory

View and manage mia's persistent memory:

```bash
mia memory list
mia memory search "pnpm"
mia memory add "this project uses pnpm workspaces"
mia memory stats
```

### Full Command Reference

| Command | Description |
|---------|-------------|
| `mia` / `mia chat` | Interactive multi-turn conversation |
| `mia ask <prompt>` | Send a single prompt to the active plugin |
| `mia start` | Start the daemon |
| `mia stop` | Stop the daemon |
| `mia restart` | Restart the daemon |
| `mia status` | Show daemon status |
| `mia logs` | Stream daemon logs |
| `mia auth` | Manage API keys / Claude Max auth |
| `mia setup` | First-time setup |
| `mia commit` | AI-generated commit message from staged diff |
| `mia pr` | AI-generated PR title and description, created via `gh` |
| `mia review` | AI code review with structured verdict |
| `mia standup` | AI standup from recent commits and mia activity |
| `mia changelog` | AI-generated changelog from git history |
| `mia explain <file\|dir>` | AI explanation of any file, directory, or concept |
| `mia test <file>` | AI-generated test file for a source file |
| `mia debug <error>` | AI error forensics — root cause, location, fix |
| `mia refactor <file>` | AI-powered code refactoring with optional write-back |
| `mia scaffold <path>` | AI code scaffolding from existing patterns |
| `mia migrate <goal>` | AI codebase-wide multi-file migration |
| `mia suggest <file\|dir>` | AI proactive code improvement suggestions |
| `mia plan <goal>` | AI task decomposition into actionable steps |
| `mia task <goal>` | AI multi-step autonomous task execution |
| `mia todo` | Scan and AI-resolve TODO/FIXME/HACK/XXX debt markers |
| `mia audit` | Security audit: package vulns, secret scanning |
| `mia coverage` | Coverage-aware test generation from Istanbul/v8 reports |
| `mia search <query>` | Semantic code search by natural language |
| `mia recap` | Daily digest: dispatches, commits, tools used |
| `mia watch` | Watch files and auto-dispatch AI prompts on save |
| `mia fix <cmd>` | Run a command and auto-fix failures in a loop |
| `mia run <cmd>` | Run a command with optional auto-fix |
| `mia doctor` | Workspace health diagnostics |
| `mia config` | View and edit configuration |
| `mia log` | Recent dispatch history with git context |
| `mia usage` | Token usage and activity stats |
| `mia memory` | View and manage persistent memory facts |
| `mia plugin` | List, switch, and inspect coding agent plugins |
| `mia scheduler` | Manage background scheduled tasks |
| `mia p2p` | P2P connection status and QR code |

### Authentication

```bash
mia auth
```

mia supports two auth methods:

1. **Claude Max/Pro subscription** — uses `claude setup-token` to generate a long-lived API token from your subscription (requires Claude CLI: `npm install -g @anthropic-ai/claude-code`)
2. **API key** — paste an Anthropic API key directly (`sk-ant-...`)

The token is saved to `~/.mia/.env` with `0600` permissions.

```bash
mia auth status   # check current auth
mia auth logout   # clear saved token
```

Or set the environment variable directly:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Mobile App

A React Native mobile client is available as a separate project (`mia-expo`). It connects to mia agents running in daemon mode using peer-to-peer networking — conversations seamlessly continue across devices.

**Mobile Features:**
- **P2P Sync**: Real-time sync with CLI daemon over Hyperswarm DHT (no server required)
- **QR Code Pairing**: Scan QR from CLI to connect instantly
- **Live Plugin Switching**: `mia plugin switch` updates the active agent in real-time
- **Collapsible Tool Output**: Tool executions appear inline, grouped into expandable pill summaries
- **Auto-Reconnect**: Reconnects to the daemon when the app returns to the foreground
- **Markdown Support**: Full markdown rendering for code blocks and formatting

### P2P Mode

Connect mobile apps or other mia instances over peer-to-peer networking:

```bash
mia start          # start daemon with P2P enabled
mia p2p status     # connection status
mia p2p qr         # show QR code for pairing
mia p2p refresh    # rotate seed and reconnect
```

P2P networking provides:
- Mobile-to-CLI communication without servers
- Secure peer-to-peer connections via Hyperswarm DHT
- Real-time message synchronisation
- Zero-configuration pairing via QR code

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Anthropic API key | Yes |
| `MIA_MAX_ITERATIONS` | Max tool iterations | No (default: 10) |

### Config File

`~/.mia/.env` for persistent configuration:

```bash
ANTHROPIC_API_KEY=sk-ant-your-key-here
MIA_MAX_ITERATIONS=15
```

Runtime config lives at `~/.mia/mia.json`. Use `mia config set` to edit it:

```bash
mia config set activePlugin opencode   # opencode | claude-code | codex
mia config set maxConcurrency 5
```

Memory is stored at `~/.mia/memory.lance`.

## Architecture

**Agent Core:**
- **Anthropic SDK**: Claude API via `@anthropic-ai/sdk`
- **Plugin-Based Coding Agents**: Claude Code, OpenCode (`@opencode-ai/sdk`), and Codex as independently-loadable plugins
- **Modular Command Architecture**: Each CLI command is a focused module under `src/daemon/commands/`
- **Native Tool Calling**: OpenAI-compatible function calling schema
- **Token Tracking**: Built-in token counting and context management
- **Streaming**: Full streaming support with delta accumulation

**Storage & Scheduling:**
- **Memory**: Vector-based persistent memory using LanceDB with ONNX reranking
- **Scheduler**: Cron-based task scheduling with node-cron
- **Message Persistence**: Intermediate tool outputs preserved across conversation switches

**P2P Networking:**
- **Hyperswarm DHT**: Secure peer-to-peer connections
- **Conversation Sync**: Real-time message relay between CLI and mobile
- **QR Code Pairing**: Zero-config device pairing via `qrcode-terminal`

**Tech Stack:**
- TypeScript (strict mode, ES2022, ESM)
- Anthropic Claude (`@anthropic-ai/sdk`)
- LanceDB + ONNX (vector memory and reranking)
- Hyperswarm (P2P networking)
- Vitest (unit testing)
- esbuild (bundling)

## Contributing

Contributions are welcome. Please open an issue or pull request.

## License

MIT

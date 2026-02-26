# mia

[![npm version](https://badge.fury.io/js/mia-agent.svg)](https://www.npmjs.com/package/mia-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Anthropic](https://img.shields.io/badge/Anthropic-Claude-blue)](https://www.anthropic.com)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT-green)](https://openai.com)
[![200+ LLMs](https://img.shields.io/badge/LLMs-200%2B-orange)](https://github.com/twinnydotdev/fluency.js)

A distributed, multi-provider AI coding assistant with P2P networking, native tool calling, trajectory-aware conversation management, and pluggable coding agent support.

> mia knows your codebase, syncs across devices, routes conversations intelligently, and delegates specialized coding tasks to best-in-class coding agents.

## Table of Contents

- [mia](#mia)
  - [Table of Contents](#table-of-contents)
  - [What is mia?](#what-is-mia)
    - [Why mia?](#why-mia)
  - [Features](#features)
  - [Supported Providers](#supported-providers)
  - [Coding Agent Plugins](#coding-agent-plugins)
    - [How Delegation Works](#how-delegation-works)
  - [Installation](#installation)
    - [Global Installation (Recommended)](#global-installation-recommended)
    - [Local Installation](#local-installation)
    - [From Source](#from-source)
  - [Quick Start](#quick-start)
    - [With Anthropic (Claude)](#with-anthropic-claude)
    - [With OpenAI (GPT)](#with-openai-gpt)
    - [With a Local Model (Ollama)](#with-a-local-model-ollama)
    - [Start coding (provider-agnostic)](#start-coding-provider-agnostic)
  - [Built-in Tools](#built-in-tools)
    - [Core Tools](#core-tools)
  - [Usage](#usage)
    - [CLI Interface](#cli-interface)
    - [Daemon Mode](#daemon-mode)
    - [AI Workflow Commands](#ai-workflow-commands)
      - [mia commit](#mia-commit)
      - [mia pr](#mia-pr)
      - [mia standup](#mia-standup)
      - [mia changelog](#mia-changelog)
      - [mia explain](#mia-explain)
      - [mia test](#mia-test)
      - [mia review](#mia-review)
      - [mia recap](#mia-recap)
      - [mia watch](#mia-watch)
      - [mia fix](#mia-fix)
      - [mia run](#mia-run)
    - [Developer Utilities](#developer-utilities)
      - [mia doctor](#mia-doctor)
      - [mia config](#mia-config)
      - [mia log](#mia-log)
      - [mia usage](#mia-usage)
      - [mia memory](#mia-memory)
    - [Full Command Reference](#full-command-reference)
    - [Authentication](#authentication)
    - [Library API](#library-api)
    - [Mobile App](#mobile-app)
    - [Telegram Bot](#telegram-bot)
    - [P2P Mode](#p2p-mode)
  - [Configuration](#configuration)
    - [Environment Variables](#environment-variables)
    - [Config File](#config-file)
  - [Architecture](#architecture)
  - [Contributing](#contributing)
  - [License](#license)

## What is mia?

mia is a distributed, **provider-agnostic** AI coding agent that runs on your machine, syncs across devices via P2P networking, and intelligently routes conversations between CLI and mobile interfaces. Built with [fluency.js](https://github.com/twinnydotdev/fluency.js) for multi-provider LLM support — including Anthropic, OpenAI, and 200+ additional LLMs — and the **Dyad protocol** for peer-to-peer agent communication.

When complex coding tasks require a specialized environment, mia **intelligently delegates to pluggable coding agents** such as Claude Code, OpenCode, or OpenAI Codex — treating each as a first-class plugin rather than a hard dependency. This means you choose the tools that fit your workflow.

**Unique Features:**
- **Provider-Agnostic by Design**: Swap between Anthropic, OpenAI, or any of 200+ supported LLMs without changing your workflow
- **Pluggable Coding Agents**: Delegate specialized coding tasks to Claude Code, OpenCode, OpenAI Codex, or any compatible agent
- **AI Workflow Commands**: `mia commit`, `mia pr`, `mia standup`, `mia changelog`, `mia explain`, `mia test`, `mia review`, and more
- **Trajectory Classification**: Automatically detects whether conversations belong on mobile or desktop
- **P2P Sync**: Conversations sync in real-time across CLI and mobile using Hyperswarm DHT
- **Daemon Scheduler**: Background task scheduling for periodic jobs (workspace snapshots, mobile builds)
- **Message Persistence**: Intermediate tool messages preserved across conversation switches

### Why mia?

- **Provider-Agnostic**: Use Anthropic, OpenAI, or 200+ other LLMs — switch providers without reconfiguring your workflow
- **Pluggable Coding Agents**: Intelligently delegate to Claude Code, OpenCode, or OpenAI Codex as specialized coding plugins
- **Developer Workflow Automation**: AI-powered commands for your entire Git workflow — commits, PRs, standups, changelogs, reviews
- **Distributed First**: Built for multi-device workflows — code on desktop, monitor on mobile
- **Token Efficient**: Compact system prompts and native tool calling reduce API costs
- **Context-Aware**: Automatic codebase context injection with workspace snapshots
- **Extensible**: Dyad protocol enables custom agent tools and P2P extensions
- **Multi-Interface**: CLI, daemon, Telegram bot, React Native mobile app, or library API
- **Zero-Config P2P**: QR code pairing, no servers, no cloud dependencies

## Features

**Core Capabilities:**
- **Multi-Provider LLM Support**: Anthropic (Claude), OpenAI (GPT), and 200+ LLMs via fluency.js
- **Pluggable Coding Agents**: Intelligent delegation to Claude Code, OpenCode, OpenAI Codex, or custom agents
- **AI Workflow Commands**: `commit`, `pr`, `standup`, `changelog`, `explain`, `test`, `review`, `recap`, `watch`, `fix`
- **Trajectory Classification**: AI-powered routing of conversations to CLI or mobile based on context
- **P2P Sync**: Real-time conversation sync across devices using Hyperswarm DHT
- **Message Persistence**: Intermediate tool outputs preserved across conversation switches
- **Daemon Scheduler**: Background tasks with cron scheduling (workspace snapshots, builds)
- **Token Efficient**: Minimal system prompt, native tool calling reduces overhead
- **Codebase Context**: Automatic injection of project structure, languages, and file paths

**LLM & Tools:**
- **Multi-Provider**: Supports 200+ LLMs from 10+ providers via fluency.js
- **Native Tool Calling**: OpenAI-compatible function calling for reliable execution
- **File Operations**: Execute shell commands, write files, and edit code
- **Code Editing**: search_and_replace and apply_diff for precise modifications
- **Memory & Scheduling**: Persistent memory (LanceDB) and cron-based tasks
- **Web Access**: Built-in web search and HTTP request capabilities

**Interfaces:**
- **CLI**: Interactive terminal interface with rich features
- **Daemon Mode**: Background service with API access
- **Mobile App**: React Native/Expo app with QR code pairing
- **Telegram Bot**: Chat with mia from Telegram
- **Library API**: Embed mia in Node.js applications

**Architecture:**
- **Dyad Protocol**: Custom P2P agent communication protocol
- **Plugin System**: Coding agent plugin architecture for delegating to specialized agents
- **Type-Safe**: Written in TypeScript with full type definitions
- **Setup Automation**: One-command setup script for fresh installations

## Supported Providers

mia is provider-agnostic by design. It uses [fluency.js](https://github.com/twinnydotdev/fluency.js) to support a wide range of LLM providers out of the box:

| Provider | Example Models | API Key Variable |
|----------|---------------|-----------------|
| **Anthropic** | claude-sonnet-4, claude-opus-4 | `ANTHROPIC_API_KEY` |
| **OpenAI** | gpt-4o, gpt-4-turbo, o1 | `OPENAI_API_KEY` |
| **Google** | gemini-pro, gemini-flash | `GOOGLE_API_KEY` |
| **Mistral** | mistral-large, mistral-small | `MISTRAL_API_KEY` |
| **Cohere** | command-r, command-r-plus | `COHERE_API_KEY` |
| **OpenRouter** | 100+ models via single API | `OPENROUTER_API_KEY` |
| **Ollama** | llama3, mistral, phi3 (local) | _(no key required)_ |
| **And more...** | 200+ models across 10+ providers | via fluency.js |

Set the relevant API key and specify your preferred model via `MIA_MODEL` or the `model` option in the Library API.

## Coding Agent Plugins

mia supports **pluggable coding agents** — specialized tools that handle complex, multi-step coding tasks through intelligent delegation. Rather than being locked into a single coding agent, mia treats each as a first-class plugin.

When mia determines that a task warrants a specialized coding environment (e.g., large refactors, multi-file edits, or interactive agentic sessions), it delegates intelligently to the configured coding agent plugin.

| Plugin | Description | Requirements |
|--------|-------------|--------------|
| **Claude Code** | Anthropic's agentic coding assistant — deep reasoning and multi-file editing | `npm install -g @anthropic-ai/claude-code`, `ANTHROPIC_API_KEY` |
| **OpenCode** | Open-source, provider-agnostic coding agent | `npm install -g opencode-ai` |
| **OpenAI Codex** | OpenAI's coding agent with GPT-4o backend | `npm install -g @openai/codex`, `OPENAI_API_KEY` |

### How Delegation Works

mia's trajectory classification engine analyzes each conversation and decides whether to:

1. **Handle the task natively** using mia's built-in tools (file ops, shell, search, memory)
2. **Delegate to a coding agent plugin** for tasks that benefit from a specialized agentic loop

This delegation is transparent — mia manages the handoff, collects results, and continues the conversation seamlessly. You interact with mia; mia coordinates with the best tool for the job.

## Installation

### Global Installation (Recommended)

```bash
npm install -g mia-agent
```

### Local Installation

```bash
npm install mia-agent
```

### From Source

```bash
git clone https://github.com/rjmacarthy/mia.git
cd mia
npm run setup  # Automated setup script
# Or manually:
npm install
npm run build
npm run link
```

## Quick Start

mia works with any supported LLM provider. Below are examples for Anthropic and OpenAI — pick the one that fits your setup.

### With Anthropic (Claude)

1. **Install mia**:
   ```bash
   npm install -g mia-agent
   ```

2. **Get an API key** from [Anthropic Console](https://console.anthropic.com/)

3. **Configure authentication**:
   ```bash
   mia auth
   # Or set the environment variable directly:
   export ANTHROPIC_API_KEY=your-key-here
   ```

4. **Start mia**:
   ```bash
   mia
   ```

### With OpenAI (GPT)

1. **Install mia**:
   ```bash
   npm install -g mia-agent
   ```

2. **Get an API key** from [OpenAI Platform](https://platform.openai.com/)

3. **Configure authentication**:
   ```bash
   export OPENAI_API_KEY=your-key-here
   export MIA_MODEL=gpt-4o
   ```

4. **Start mia**:
   ```bash
   mia
   ```

### With a Local Model (Ollama)

1. **Install [Ollama](https://ollama.com) and pull a model**:
   ```bash
   ollama pull llama3
   ```

2. **Start mia pointing at your local Ollama instance**:
   ```bash
   export MIA_MODEL=ollama/llama3
   mia
   ```

### Start coding (provider-agnostic)

Regardless of which provider you use, the workflow is the same:

```
> Read the package.json and tell me about this project
> Create a new utility function in src/utils/
> Fix the bug in the authentication module
> Run the tests and show me the results
```

## Built-in Tools

mia provides a streamlined set of powerful tools:

### Core Tools

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

The `execute_command` tool provides access to the full shell environment, enabling file reading (cat, head, tail), searching (grep, find), file operations (cp, mv, rm), system info (uname, free), networking (curl, ping), and more.

## Usage

### CLI Interface

The interactive CLI provides a rich terminal experience:

```bash
# Start interactive chat
mia chat

# Or simply run mia with no arguments
mia
```

**In-session commands:**

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `/tokens` | Show token usage statistics |
| `/exit` | Exit the application |

### Daemon Mode

Run mia as a background service:

```bash
# Start daemon
mia start

# Check status
mia status

# View logs
mia logs

# Stop daemon
mia stop

# Restart daemon
mia restart
```

### AI Workflow Commands

mia includes AI-powered commands that integrate directly into your development workflow.

#### mia commit

Generate a conventional commit message from your staged diff using AI:

```bash
# Stage everything and commit
mia commit --all

# Preview the message without committing
mia commit --dry-run

# Commit and push in one step
mia commit --push

# Skip the confirmation prompt
mia commit --yes

# Print just the message (for piping)
mia commit --message-only
```

#### mia pr

Generate a pull request title and description from your branch's commit history, then create it via `gh`:

```bash
# Auto-detect base branch and create PR
mia pr

# Specify base branch
mia pr --base main

# Create as a draft
mia pr --draft

# Preview content without creating
mia pr --dry-run

# Push the branch before creating
mia pr --push

# Skip confirmation, open in browser after creation
mia pr --yes --web
```

#### mia standup

Generate an AI standup report from recent commits and mia activity:

```bash
# Today's standup (last 24 hours)
mia standup

# Yesterday's window
mia standup --yesterday

# Custom look-back window
mia standup --hours 48

# Include activity from multiple repos
mia standup --repos ~/project-a,~/project-b

# Plain text for piping to Slack/Telegram
mia standup --raw
```

#### mia changelog

Generate an AI-powered changelog from your git history:

```bash
# From last tag to HEAD
mia changelog

# Between specific refs
mia changelog --from v1.0.0 --to v2.0.0

# Label the version
mia changelog --version 1.3.0

# Prepend to CHANGELOG.md
mia changelog --write

# Preview the prompt without dispatching
mia changelog --dry-run
```

#### mia explain

Get an AI explanation of any file, directory, function, or concept in your codebase:

```bash
# Explain a file
mia explain src/auth.ts

# Explain a whole directory
mia explain src/auth/

# Focus on a specific function or class
mia explain src/auth.ts --fn verifyToken

# Answer a conceptual question about the codebase
mia explain --query "how does the plugin delegation work"

# Control explanation depth
mia explain src/auth.ts --depth deep   # shallow | normal | deep
```

#### mia test

Generate a test file for any source file using AI:

```bash
# Generate tests for a source file (prints to stdout)
mia test src/utils.ts

# Write test file to disk alongside the source
mia test src/utils.ts --write

# Specify a custom output path
mia test src/utils.ts --output src/__tests__/utils.test.ts

# Preview the prompt without dispatching
mia test src/utils.ts --dry-run
```

#### mia review

Run an AI code review on your current diff or staged changes:

```bash
# Review staged changes
mia review

# Review a specific file
mia review src/auth.ts

# Review a full diff between refs
mia review --from main --to HEAD

# Output plain text for piping
mia review --raw
```

#### mia recap

Get an AI-generated daily digest of your dispatches, commits, and tool usage:

```bash
# Today's recap
mia recap

# Yesterday's recap
mia recap --yesterday

# Specific date
mia recap --date 2026-01-15

# Machine-readable JSON
mia recap --json
```

#### mia watch

Watch files and automatically dispatch AI prompts on save:

```bash
# Watch with default mode (code review on save)
mia watch

# Switch modes: review | test | fix | docs
mia watch --mode test

# Custom prompt template ({files} is substituted)
mia watch --prompt "Review security implications of: {files}"

# Tune debounce and minimum dispatch interval
mia watch --debounce 3000 --min-interval 10000

# Preview what would be dispatched without running
mia watch --dry-run
```

#### mia fix

Run a command and automatically fix failures in a loop:

```bash
# Run and auto-fix
mia fix "npm test"

# Limit fix cycles
mia fix --max-retries 3 "npm test"

# Add context for the fixer
mia fix --prompt "this project uses pnpm" "pnpm test"
```

#### mia run

Run a command with optional auto-fix on failure:

```bash
# Run once, fix on failure (default 3 retries)
mia run "npm test"

# More retries
mia run "npm test" --max-retries 5

# Run once without auto-fix
mia run "npm test" --no-fix

# Skip per-fix confirmation prompts
mia run "npm test" --yes

# Custom timeout
mia run "npm test" --timeout 60000
```

### Developer Utilities

#### mia doctor

Run a workspace health diagnostics check:

```bash
mia doctor
```

Reports on: daemon status, plugin availability, API key configuration, memory health, scheduler state, and codebase context.

#### mia config

View and edit mia's configuration:

```bash
# Show all current configuration
mia config

# Read a specific value
mia config get activePlugin

# Write a value
mia config set maxConcurrency 5
mia config set activePlugin opencode
```

#### mia log

Browse recent dispatch history with git context:

```bash
# Last 20 dispatches (default)
mia log

# Show more entries
mia log --n 50

# Filter to failed dispatches only
mia log --failed

# Filter by conversation ID
mia log --conv chat-20240115-abc
```

#### mia usage

View token usage and activity stats:

```bash
# Today's dispatches, duration, and tools used
mia usage today

# Last 7 days
mia usage week

# All available trace history
mia usage all
```

#### mia memory

View and manage mia's persistent memory:

```bash
# List recent facts
mia memory list

# Search by query
mia memory search "pnpm"

# Manually store a fact
mia memory add "this project uses pnpm workspaces"

# Show counts by memory type
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
| `mia auth` | Manage API keys |
| `mia setup` | First-time setup |
| `mia commit` | AI-generated commit message from staged diff |
| `mia pr` | AI-generated PR title and description, then create via gh |
| `mia standup` | AI standup from recent commits and mia activity |
| `mia changelog` | AI-generated changelog from git history |
| `mia explain <file\|dir>` | AI explanation of any file, directory, or concept |
| `mia test <file>` | AI-generated test file for a source file |
| `mia review` | AI code review of current diff |
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

Configure API keys for your chosen provider:

```bash
mia auth
```

Or create `~/.mia/.env` with the key(s) for your providers:

```bash
# Anthropic
ANTHROPIC_API_KEY=your-key-here

# OpenAI
OPENAI_API_KEY=your-key-here

# Google
GOOGLE_API_KEY=your-key-here
```

### Library API

Use mia programmatically in your Node.js applications. The `model` field accepts any fluency.js-compatible model string:

```typescript
import { Agent } from '@mia/cli';

// Using Anthropic
const agent = new Agent({
  model: 'claude-sonnet-4-20250514',
  apiKey: process.env.ANTHROPIC_API_KEY,
  workingDirectory: process.cwd(),
  maxIterations: 200,
  mode: 'coding', // or 'general'
});

// Using OpenAI — same API, different model
const agentOpenAI = new Agent({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  workingDirectory: process.cwd(),
  maxIterations: 200,
  mode: 'coding',
});

// Initialize (gathers codebase context)
await agent.init();

// Chat - agent uses native tool calling automatically
const response = await agent.chat('Read the package.json file');
console.log(response);

// Stream responses with callbacks
agent.onStreamToken = (token) => process.stdout.write(token);
agent.onToolCall = (name, params) => console.log(`Calling ${name}`);
agent.onToolResult = (name, result) => console.log(`Result: ${result}`);

const streamResponse = await agent.chat('Explain this codebase');
```

### Mobile App

A React Native mobile client is available as a separate project:

```bash
# From the mobile app repo:
npm run android        # Android device/emulator
npm run ios            # iOS simulator

# Build release APK for Android
npm run build:apk
# Output: android/app/build/outputs/apk/release/app-release.apk
```

**Mobile-Specific Features:**
- **Trajectory Routing**: Conversations marked as "mobile" are automatically routed to the app
- **P2P Sync**: Real-time sync with CLI daemon over Hyperswarm DHT (no server required)
- **QR Code Pairing**: Scan QR from CLI to connect instantly
- **Status Indicators**: Live connection status for P2P, Telegram, and scheduler
- **Conversation Management**: Persistent chat history with proper abort/queue handling
- **Inline Tool Calls**: Tool executions appear directly in the chat thread — no separate Tools view
- **Collapsible Tool Pills**: Consecutive same-type tool calls are grouped into expandable pill summaries
- **Auto-Reconnect**: Automatically reconnects to the daemon when the app returns to the foreground
- **Markdown Support**: Full markdown rendering for code blocks and formatting
- **Cross-Platform**: Built with Expo and React Native (iOS/Android)

The mobile app connects to mia agents running in daemon mode using peer-to-peer networking — conversations seamlessly continue across devices.

### Telegram Bot

Run mia as a Telegram bot:

```bash
npm run telegram
```

Configure via `~/.mia/.env`:
```bash
TELEGRAM_BOT_TOKEN=your-bot-token
```

### P2P Mode

Connect multiple mia instances or mobile apps over peer-to-peer networking using Hyperswarm:

```bash
# Start daemon with P2P enabled
mia start

# Connect mobile app by scanning QR code
# The CLI will display a QR code for easy pairing

# Check P2P connection status
mia p2p status

# Show QR code for pairing
mia p2p qr

# Rotate seed and reconnect
mia p2p refresh
```

P2P networking enables:
- Mobile app to CLI communication without servers
- Secure peer-to-peer connections using Hyperswarm DHT
- Real-time message synchronization with buffered newline-delimited framing
- Zero-configuration networking with QR code pairing

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude models) | If using Anthropic |
| `OPENAI_API_KEY` | OpenAI API key (for GPT / Codex models) | If using OpenAI |
| `GOOGLE_API_KEY` | Google API key (for Gemini models) | If using Google |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | For Telegram mode |
| `MIA_MODEL` | Default model to use (any fluency.js model string) | No |
| `MIA_MAX_ITERATIONS` | Max tool iterations | No (default: 10) |

### Config File

Create `~/.mia/.env` for persistent configuration:

```bash
# Provider API keys — set only those you use
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key

# Model selection — any fluency.js compatible model string
MIA_MODEL=claude-sonnet-4-20250514
# MIA_MODEL=gpt-4o
# MIA_MODEL=ollama/llama3

MIA_MAX_ITERATIONS=15

# Telegram (optional)
TELEGRAM_BOT_TOKEN=your-bot-token
```

Use `mia config set` to change settings at runtime:

```bash
# Switch active coding agent plugin
mia config set activePlugin opencode   # opencode | claude-code | codex

# Adjust concurrency
mia config set maxConcurrency 5
```

## Architecture

mia is built as a **distributed, provider-agnostic agent system** with the following layers:

**Agent Core:**
- **Multi-Provider LLM**: fluency.js powers support for Anthropic, OpenAI, Google, Mistral, Ollama, and 200+ additional LLMs with a unified API
- **Plugin-Based Coding Agents**: A harness engineering architecture enables intelligent dispatch to Claude Code, OpenCode, OpenAI Codex, or custom agents — each plugin is a first-class, independently loadable module
- **Trajectory Classification**: AI-powered analysis of conversation context to route messages to CLI, mobile, or a coding agent plugin
- **Modular Agent Architecture**: The agent core is split into focused modules (conversation, streaming, tool execution, scheduling) rather than a monolithic agent file
- **Conversation Management**: Persistent message storage with proper abort/queue handling
- **Native Tool Calling**: OpenAI-compatible function calling via fluency.js
- **Token Tracking**: Built-in token counting and context management
- **Streaming**: Full streaming support with delta accumulation

**Storage & Scheduling:**
- **Memory**: Vector-based persistent memory using LanceDB
- **Scheduler**: Cron-based task scheduling with node-cron (workspace snapshots, builds)
- **Message Persistence**: Intermediate tool outputs preserved across conversation switches

**P2P Networking (Dyad Protocol):**
- **Hyperswarm DHT**: Secure peer-to-peer connections
- **Conversation Sync**: Real-time message relay between CLI and mobile
- **QR Code Pairing**: Zero-config device pairing
- **No Server Required**: Fully decentralized architecture

**Tech Stack:**
- TypeScript (fully typed, modern ES modules)
- fluency.js (multi-provider LLM support — Anthropic, OpenAI, 200+ models)
- LanceDB (vector memory storage)
- Hyperswarm (P2P networking)
- Expo/React Native (mobile app)
- Vitest (unit testing)

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

MIT

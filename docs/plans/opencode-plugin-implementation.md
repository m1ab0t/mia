# OpenCode Plugin Implementation Plan

**Status:** Proposal
**Date:** 2026-02-18
**Author:** Mia (via nightly-improvement agent)
**Target package:** `packages/mia/src/plugins/implementations/opencode.plugin.ts`

---

## 1. Background & Motivation

Mia's harness engineering architecture defines a clean `CodingPlugin` interface that abstracts all coding agent execution behind a standard contract (`dispatch`, `abort`, `getSession`, etc.). Three plugins are registered at startup:

| Plugin | Status |
|---|---|
| `claude-code` | ✅ Fully implemented |
| `codex` | 🔴 Stub — throws `NotImplementedError` |
| `opencode` | 🔴 Stub — throws `NotImplementedError` |

This document describes the full implementation plan for `OpenCodePlugin`, enabling users to switch their active coding agent to [OpenCode](https://opencode.ai) via:

```bash
mia manage_config set activePlugin opencode
```

OpenCode is a Go-based, open-source terminal AI coding agent that supports 70+ LLM providers, LSP integration, MCP servers, and a headless `-p` mode well-suited for programmatic dispatch.

---

## 2. OpenCode CLI Interface Analysis

### 2.1 Non-Interactive (Headless) Mode

OpenCode's headless invocation mirrors the Claude Code pattern closely:

```bash
opencode -p "your prompt here" --output-format json --cwd /path/to/project
```

| Flag | Purpose |
|---|---|
| `-p / --prompt` | Non-interactive prompt (headless mode) |
| `--output-format` / `-f` | `text` (default) or `json` |
| `--quiet` / `-q` | Suppress spinner/animation output |
| `--debug` / `-d` | Enable verbose debug logging |
| `--cwd` / `-c` | Set working directory |

### 2.2 JSON Output Format

When invoked with `-f json`, OpenCode wraps its response in a JSON object. Based on source analysis and community testing, the expected envelope is:

```json
{
  "role": "assistant",
  "content": "...response text...",
  "model": "claude-sonnet-4-7",
  "sessionId": "uuid-string",
  "cost": { "input": 0.0012, "output": 0.003 },
  "tokens": { "input": 400, "output": 150 }
}
```

> **Note:** OpenCode does not yet support streaming NDJSON (`stream-json` format like Claude Code). Output arrives as a single JSON object after completion. This plan accounts for this by emitting all tokens via a single `onToken` call on completion.

### 2.3 Session Continuity

OpenCode uses a SQLite-backed session store (`.opencode/` directory). Sessions are identified by UUID. Resuming a session is done via a `--session` flag (exact flag name to be confirmed during implementation against the installed binary — fall back to `--session-id` if needed).

### 2.4 Model Selection

OpenCode supports provider-prefixed model strings identical to OpenRouter/Fluency conventions:

```bash
opencode -p "..." --model anthropic/claude-sonnet-4-7
opencode -p "..." --model openai/gpt-4o
```

### 2.5 System Prompt Injection

OpenCode supports system prompt files and inline prompt flags:

```bash
opencode -p "..." --system-prompt "You are a helpful assistant..."
```

---

## 3. Architecture Design

### 3.1 Class Structure

`OpenCodePlugin` will mirror `ClaudeCodePlugin` in structure while adapting to OpenCode's non-streaming JSON output protocol:

```
OpenCodePlugin
├── Lifecycle          initialize(), shutdown(), isAvailable()
├── Session mgmt       conversationSessions Map, completedSessions Set
├── Dispatch           dispatch() → _dispatchConversationTask()
├── Output parsing     _parseJsonOutput() — single-shot JSON envelope
├── Concurrency        Per-conversation queuing (matches ClaudeCodePlugin pattern)
├── Abort              abort(taskId), abortAll()
└── Info/cleanup       getRunningTaskCount(), cleanup()
```

### 3.2 Key Differences from ClaudeCodePlugin

| Concern | ClaudeCodePlugin | OpenCodePlugin |
|---|---|---|
| Output format | NDJSON stream (line-by-line) | Single JSON object on stdout |
| Token streaming | Real-time `onToken` per text block | Single `onToken` call with full response |
| Tool call events | Parsed from `assistant` message blocks | Parsed from JSON `toolCalls` array (if present) |
| Session flag | `--session-id <uuid>` / `--resume <uuid>` | `--session <uuid>` (or `--session-id` — confirm at runtime) |
| Auth stripping | Strips `ANTHROPIC_API_KEY`, `CLAUDECODE` | Strips agent-specific env vars if needed |
| Binary | `claude` (configurable) | `opencode` (configurable) |

### 3.3 Output Parsing Strategy

Since OpenCode outputs a single JSON object (no streaming), the plugin will:

1. Buffer all stdout until process closes
2. Parse the complete JSON envelope
3. Emit a single `onToken(fullResponse, taskId)` call
4. Extract tool call metadata if present in JSON
5. Emit `onDone` or `onError` accordingly

For future streaming support (if OpenCode adds NDJSON): the `_parseJsonOutput` method can be replaced with a line-based parser without changing the public interface.

---

## 4. Implementation Steps

### Step 1 — Implement `OpenCodePlugin` class

**File:** `packages/mia/src/plugins/implementations/opencode.plugin.ts`

Replace the current stub with a full implementation:

```typescript
import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { getErrorMessage } from '../../utils/error-message';
import type {
  CodingPlugin, CodingPluginCallbacks, DispatchOptions,
  PluginConfig, PluginContext, PluginDispatchResult
} from '../types';

interface TaskInfo {
  taskId: string;
  status: 'running' | 'completed' | 'error' | 'killed';
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  conversationId?: string;
  callbackEmitted?: boolean;
}

export class OpenCodePlugin implements CodingPlugin {
  readonly name = 'opencode';
  readonly version = '1.0.0';

  private config: PluginConfig | null = null;
  private tasks = new Map<string, TaskInfo>();
  private processes = new Map<string, ChildProcess>();
  private taskCallbacks = new Map<string, CodingPluginCallbacks>();

  // Session continuity
  private conversationSessions = new Map<string, string>();  // conversationId → sessionUUID
  private completedSessions = new Set<string>();
  private activeConversations = new Map<string, string>();   // conversationId → taskId
  private conversationQueues = new Map<string, Array<{
    prompt: string; context: PluginContext; options: DispatchOptions;
    callbacks: CodingPluginCallbacks;
    resolve: (r: PluginDispatchResult) => void;
    reject: (e: Error) => void;
  }>>();

  // ... (full implementation — see Step 1 detail below)
}
```

#### 1a. `initialize()` / `shutdown()` / `isAvailable()`

```typescript
async initialize(config: PluginConfig): Promise<void> {
  this.config = config;
}

async shutdown(): Promise<void> {
  await this.abortAll();
}

async isAvailable(): Promise<boolean> {
  try {
    const { execSync } = await import('child_process');
    execSync('opencode --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
```

#### 1b. Session management methods

```typescript
getSession(conversationId: string): string | undefined {
  return this.conversationSessions.get(conversationId);
}

clearSession(conversationId: string): void {
  const sessionId = this.conversationSessions.get(conversationId);
  if (sessionId) {
    this.completedSessions.delete(sessionId);
    this.conversationSessions.delete(conversationId);
  }
}

clearAllSessions(): void {
  this.conversationSessions.clear();
  this.completedSessions.clear();
}
```

#### 1c. `dispatch()` — Conversation queuing

```typescript
async dispatch(
  prompt: string,
  context: PluginContext,
  options: DispatchOptions,
  callbacks: CodingPluginCallbacks
): Promise<PluginDispatchResult> {
  const conversationId = options.conversationId;
  const activeTaskId = this.activeConversations.get(conversationId);
  if (activeTaskId && this.processes.has(activeTaskId)) {
    return new Promise((resolve, reject) => {
      const queue = this.conversationQueues.get(conversationId) ?? [];
      queue.push({ prompt, context, options, callbacks, resolve, reject });
      this.conversationQueues.set(conversationId, queue);
    });
  }
  return this._dispatchConversationTask(prompt, context, options, callbacks);
}
```

#### 1d. `_dispatchConversationTask()` — Core dispatch

Key logic:

1. **Concurrency check** — abort early if `runningCount >= maxConcurrency`
2. **Session resolution** — look up or create session UUID for `conversationId`
3. **Context assembly** — build system prompt from `PluginContext` (same pattern as ClaudeCodePlugin)
4. **CLI args construction:**

```typescript
const args: string[] = [
  '-p', prompt,
  '--output-format', 'json',
  '--quiet',
];

// Session resume or new
const sessionFlag = await this._getSessionFlag(); // detects --session vs --session-id
if (isResume && sessionId) {
  args.push(sessionFlag, sessionId);
} else {
  // New session — opencode generates its own UUID; we track after
}

// Working directory
args.push('--cwd', cwd);

// Model override
if (model) args.push('--model', model);

// System prompt
if (systemPrompt) args.push('--system-prompt', systemPrompt);

// Extra args from config
if (this.config?.extraArgs) args.push(...this.config.extraArgs);
```

5. **Spawn process** — capture stdout/stderr, handle close/error
6. **Buffer and parse** stdout as single JSON object
7. **Emit callbacks** and resolve promise

#### 1e. `_parseJsonOutput()` — JSON envelope parser

```typescript
private _parseJsonOutput(raw: string): {
  content: string;
  sessionId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  isError?: boolean;
  errorMessage?: string;
} {
  try {
    const parsed = JSON.parse(raw.trim());
    return {
      content: parsed.content ?? parsed.result ?? raw,
      sessionId: parsed.sessionId,
      costUsd: parsed.cost ? (parsed.cost.input ?? 0) + (parsed.cost.output ?? 0) : undefined,
      inputTokens: parsed.tokens?.input,
      outputTokens: parsed.tokens?.output,
      isError: parsed.error != null || parsed.role === 'error',
      errorMessage: parsed.error,
    };
  } catch {
    // Non-JSON output — treat as plain text response
    return { content: raw };
  }
}
```

#### 1f. `_getSessionFlag()` — Detect correct session flag at runtime

```typescript
private _sessionFlagCache: string | null = null;

private async _getSessionFlag(): Promise<string> {
  if (this._sessionFlagCache) return this._sessionFlagCache;
  try {
    const { execSync } = await import('child_process');
    const help = execSync('opencode --help 2>&1', { encoding: 'utf-8' });
    this._sessionFlagCache = help.includes('--session-id') ? '--session-id' : '--session';
  } catch {
    this._sessionFlagCache = '--session';
  }
  return this._sessionFlagCache;
}
```

#### 1g. `_onTaskFinished()` — Dequeue next conversation task

Identical pattern to `ClaudeCodePlugin._onTaskFinished()`.

#### 1h. `abort()` / `abortAll()` / `_kill()`

Identical pattern to `ClaudeCodePlugin` — SIGTERM with 5s SIGKILL fallback.

---

### Step 2 — Update `PluginConfig` defaults in `mia-config.ts`

Add a default OpenCode plugin config entry:

```typescript
// In DEFAULT_CONFIG.plugins:
'opencode': {
  name: 'opencode',
  enabled: true,
  binary: 'opencode',
  model: 'anthropic/claude-sonnet-4-7',
  maxConcurrency: 3,
  timeoutMs: 30 * 60 * 1000,
},
```

This ensures `opencode` shows up in config inspection even before the user enables it.

---

### Step 3 — Verify registration in daemon

**File:** `packages/mia/src/daemon/index.ts`

Confirm that `OpenCodePlugin` is registered at daemon startup (it likely already is via the existing plugin index). Verify the import and `registry.register(new OpenCodePlugin())` call exists.

If not present, add:

```typescript
import { OpenCodePlugin } from '../plugins/implementations/opencode.plugin';
// ...
registry.register(new OpenCodePlugin());
await registry.get('opencode')!.initialize(config.plugins?.['opencode'] ?? { name: 'opencode', enabled: true });
```

---

### Step 4 — Add `manage_config` support documentation

The existing `manage_config` tool already supports setting `activePlugin`. No code changes needed — just verify the tool's help text mentions `opencode` as a valid value.

User workflow after this PR:

```bash
# Check if opencode is available
mia "is the opencode plugin available?"

# Switch to opencode
mia manage_config set activePlugin opencode

# Verify
mia "what plugin am I using?"
```

---

### Step 5 — Add `isAvailable()` check in dispatcher

**File:** `packages/mia/src/plugins/dispatcher.ts`

Add a pre-dispatch availability check that surfaces a helpful error if `opencode` binary is not installed:

```typescript
// In dispatch(), after resolving the plugin:
if (!(await plugin.isAvailable())) {
  return {
    taskId: `unavailable-${Date.now()}`,
    success: false,
    output: `Plugin "${plugin.name}" is not available. Install it with: ${this._getInstallHint(plugin.name)}`,
    durationMs: 0,
  };
}
```

```typescript
private _getInstallHint(pluginName: string): string {
  const hints: Record<string, string> = {
    'opencode': 'curl -fsSL https://opencode.ai/install | sh',
    'claude-code': 'npm install -g @anthropic-ai/claude-code',
    'codex': 'npm install -g @openai/codex',
  };
  return hints[pluginName] ?? 'refer to the plugin documentation';
}
```

---

### Step 6 — TypeScript validation

```bash
cd packages/mia && npx tsc --noEmit
```

All types must pass with no errors.

---

### Step 7 — Manual integration test (when opencode is installed)

```bash
# Install opencode
curl -fsSL https://opencode.ai/install | sh

# Configure API key for opencode
opencode auth

# Test headless mode directly
opencode -p "write hello world in Go" -f json

# Switch Mia to use opencode
mia manage_config set activePlugin opencode

# Verify dispatch works
mia "create a simple express server in server.js"
```

---

## 5. File Change Summary

| File | Change |
|---|---|
| `packages/mia/src/plugins/implementations/opencode.plugin.ts` | Full implementation (replace stub) |
| `packages/mia/src/config/mia-config.ts` | Add `opencode` to `DEFAULT_CONFIG.plugins` |
| `packages/mia/src/daemon/index.ts` | Verify/add OpenCodePlugin registration |
| `packages/mia/src/plugins/dispatcher.ts` | Add `isAvailable()` pre-check + install hints |

**No new files required.** All changes are additive within the existing architecture.

---

## 6. Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| OpenCode JSON output format differs from assumed | Medium | `_parseJsonOutput` falls back to raw string on parse failure |
| Session flag name (`--session` vs `--session-id`) incorrect | Medium | `_getSessionFlag()` detects at runtime from `--help` output |
| OpenCode does not support `--system-prompt` flag | Low | Guarded by `if (systemPrompt)` — gracefully omitted |
| Streaming not available (single-shot only) | Known | Documented; `onToken` emits once with full response |
| No session resume in headless mode | Unknown | `clearSession()` clears state; new session created on next dispatch |

---

## 7. Future Enhancements (Out of Scope)

- **Streaming support** — If OpenCode adds NDJSON streaming, replace `_parseJsonOutput` with a line-by-line parser. The plugin interface remains unchanged.
- **MCP server bridging** — Mia's memory/context tools could be exposed as MCP servers for OpenCode to consume natively.
- **Tool call extraction** — If OpenCode's JSON output includes `toolCalls` metadata, emit granular `onToolCall`/`onToolResult` events for richer Mia UI feedback.
- **Cost tracking** — Surface token/cost metadata in Mia's status dashboard.
- **Codex plugin** — The same pattern applies to implement `CodexPlugin` once the Codex CLI headless interface stabilizes.

---

## 8. Acceptance Criteria

- [ ] `OpenCodePlugin.isAvailable()` returns `true` when `opencode` binary is in PATH
- [ ] `OpenCodePlugin.dispatch()` successfully runs a simple prompt and returns `success: true`
- [ ] Session continuity: second dispatch in same `conversationId` resumes previous session
- [ ] `OpenCodePlugin.abort(taskId)` terminates the child process within 5 seconds
- [ ] TypeScript compilation passes with `npx tsc --noEmit`
- [ ] `manage_config set activePlugin opencode` + subsequent coding task routes through OpenCodePlugin
- [ ] Fallback: if `opencode` binary not found, dispatcher returns helpful error with install hint
- [ ] Switching back to `claude-code` via `manage_config` works without restart

---

## 9. References

- [OpenCode GitHub](https://github.com/opencode-ai/opencode)
- [OpenCode Documentation](https://opencode.ai/docs/)
- [OpenCode Agents Docs](https://opencode.ai/docs/agents/)
- [ClaudeCodePlugin implementation](../packages/mia/src/plugins/implementations/claude-code.plugin.ts) — reference pattern
- [CodingPlugin interface](../packages/mia/src/plugins/types.ts)
- [PluginDispatcher](../packages/mia/src/plugins/dispatcher.ts)
- [MiaConfig](../packages/mia/src/config/mia-config.ts)

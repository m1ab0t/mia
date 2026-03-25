# Plugin System Architecture

Mia delegates AI coding tasks to pluggable _coding agents_ — CLI tools or SDK
clients that receive a prepared prompt and stream a response back to the daemon.
Each agent is wrapped by a **plugin**: a TypeScript class that implements the
`CodingPlugin` interface and handles the agent's specific startup, communication,
and shutdown protocol.

Four plugins ship with Mia:

| Plugin | Agent | Protocol |
|---|---|---|
| `claude-code` | [Claude Code CLI](https://claude.ai/download) | Spawn, NDJSON over stdout |
| `codex` | [OpenAI Codex CLI](https://github.com/openai/codex) | Spawn, NDJSON over stdout |
| `gemini` | [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Spawn, stream-json over stdout |
| `opencode` | [OpenCode SDK](https://github.com/sst/opencode) | HTTP/SSE via `@opencode-ai/sdk` |

---

## Table of Contents

- [Core interfaces](#core-interfaces)
- [Plugin lifecycle](#plugin-lifecycle)
- [Dispatch pipeline](#dispatch-pipeline)
- [Creating a spawn-based plugin](#creating-a-spawn-based-plugin)
- [Creating an SDK-based plugin](#creating-an-sdk-based-plugin)
- [Session management](#session-management)
- [Resilience mechanisms](#resilience-mechanisms)
- [Plugin configuration](#plugin-configuration)
- [Registering a new plugin](#registering-a-new-plugin)
- [Testing a plugin](#testing-a-plugin)

---

## Core interfaces

All types live in `src/plugins/types.ts`.

### `CodingPlugin`

The interface every plugin must implement:

```typescript
interface CodingPlugin {
  readonly name: string;    // "claude-code", "codex", "opencode", "gemini"
  readonly version: string;

  // Lifecycle
  initialize(config: PluginConfig): Promise<void>;
  shutdown(): Promise<void>;
  isAvailable(): Promise<boolean>;  // true iff the binary/API can be reached

  // Dispatch
  dispatch(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    callbacks: CodingPluginCallbacks
  ): Promise<PluginDispatchResult>;

  // Session management (optional)
  getSession?(conversationId: string): string | undefined;
  clearSession?(conversationId: string): void;
  clearAllSessions?(): void;

  // Abort
  abort(taskId: string): Promise<void>;
  abortAll(): Promise<void>;
  abortConversation?(conversationId: string): Promise<void>;

  // Metrics
  getRunningTaskCount(): number;
  cleanup(maxAgeMs?: number): number;
  releaseResultBuffers(graceMs?: number): number;
}
```

### `PluginContext`

Rich context prepared by the harness before every dispatch:

```typescript
interface PluginContext {
  memoryFacts: string[];        // Top-N facts retrieved from SQLite FTS5 memory
  codebaseContext: string;      // Language, frameworks, file count summary
  gitContext: string;           // Branch, recent commits, dirty-files list
  workspaceSnapshot: string;    // Working directory, entry points, recently modified
  projectInstructions: string;  // Content of CLAUDE.md / AGENTS.md + persona profile
  conversationSummary?: string; // Compacted prior conversation for long sessions
}
```

Context preparation is handled by `ContextPreparer` (`src/plugins/context-preparer.ts`).
In `general` mode (non-coding chat) the heavy fields (git, workspace, codebase) are
omitted to stay within the tighter token budget.

### `DispatchOptions`

Per-dispatch configuration:

```typescript
interface DispatchOptions {
  conversationId: string;         // Used to look up / persist sessions
  model?: string;                 // Override the plugin's default model
  systemPromptSuffix?: string;    // Appended to the base system prompt
  timeoutMs?: number;             // Override global timeout (default: 30 min)
  workingDirectory?: string;      // CWD for the spawned process
  skipMemoryExtraction?: boolean; // Skip post-dispatch fact extraction
  skipContext?: boolean;          // Use raw prompt only — no context at all
  mode?: 'coding' | 'general';   // Affects context preparation and tool use
  image?: { data: string; mimeType: string }; // Base64 image from mobile
}
```

### `CodingPluginCallbacks`

Streaming callbacks fired during dispatch:

```typescript
interface CodingPluginCallbacks {
  onToken(token: string, taskId: string): void;       // Each streaming text chunk
  onToolCall(name: string, input: Record<string, unknown>, taskId: string): void;
  onToolResult(name: string, result: string, taskId: string): void;
  onDone(result: string, taskId: string): void;       // Full final output
  onError(error: Error, taskId: string): void;
}
```

### `PluginError`

All plugin errors must be wrapped in `PluginError` (never plain `Error`):

```typescript
throw new PluginError(
  'Authentication failed',
  PluginErrorCode.PROVIDER_ERROR,
  this.name,
  { statusCode: 401 }
);
```

Error codes: `TIMEOUT`, `SPAWN_FAILURE`, `PROCESS_EXIT`, `BUFFER_OVERFLOW`,
`CONCURRENCY_LIMIT`, `PROVIDER_ERROR`, `SESSION_ERROR`, `ABORTED`, `UNKNOWN`.

The daemon router detects `instanceof PluginError` and emits a structured
`plugin_error` IPC message to the mobile app for display.

---

## Plugin lifecycle

```
daemon start
  │
  ├─ new ClaudeCodePlugin()
  ├─ new CodexPlugin()
  ├─ new OpenCodePlugin()
  ├─ new GeminiPlugin()
  │
  ├─ registry.register(plugin) × 4
  │
  └─ plugin.initialize(config) × 4   ← per-plugin config from mia.json
       Sets binary path, model, timeouts, system prompt, etc.

user sends message
  │
  └─ dispatcher.dispatch(prompt, conversationId, opts)
       │
       ├─ contextPreparer.prepare()   ← git, workspace, memory, instructions
       ├─ plugin.isAvailable()        ← cached, 60 s TTL
       ├─ plugin.dispatch()           ← streaming
       └─ memoryExtractor.extract()   ← fire-and-forget post-dispatch

daemon stop / restart
  │
  └─ plugin.shutdown() × 4
```

---

## Dispatch pipeline

The `PluginDispatcher` (`src/plugins/dispatcher.ts`) sits between the daemon
router and the individual plugin. Every incoming message flows through it:

```
routeMessage()
  │
  └─ dispatcher.dispatch(prompt, conversationId)
       │
       ├─ 1. Hot-swap check
       │     Read activePlugin from mia.json (5 s timeout).
       │     Allows `mia plugin switch` to take effect without restart.
       │
       ├─ 2. Build candidate list
       │     [activePlugin, ...fallbackPlugins] (if fallback enabled in config).
       │
       ├─ 3. Context preparation
       │     contextPreparer.prepare() — git, workspace, memory, conversation
       │     history.  Shared across all fallback attempts.
       │
       └─ 4. For each candidate plugin:
             │
             ├─ 4a. Availability check (cached 60 s)
             ├─ 4b. Circuit breaker check
             │       If 3 consecutive spawn failures → 5 min cooldown.
             ├─ 4c. plugin.dispatch(prompt, context, opts, callbacks)
             │       Streaming callbacks fire in real-time.
             ├─ 4d. On success:
             │       traceLogger.log() — write to ~/.mia/traces/YYYY-MM-DD.ndjson
             │       verifier.verify() — semantic checks, optional retry
             │       memoryExtractor.extract() — fire-and-forget fact extraction
             └─ 4e. On failure:
                     If fallback enabled, try next candidate.
                     Otherwise return failure result.
```

---

## Creating a spawn-based plugin

Most plugins spawn a CLI binary that emits NDJSON to stdout. Extend
`BaseSpawnPlugin` (`src/plugins/base-spawn-plugin.ts`) — it handles all
shared infrastructure (concurrency queue, session lookup, process spawn,
stdout/stderr parsing, timeout, kill, cleanup).

You only implement three abstract methods:

### 1. `buildCliArgs` — construct the argv array

```typescript
protected buildCliArgs(
  prompt: string,
  context: PluginContext,
  options: DispatchOptions,
  sessionId: string,
  isResume: boolean
): string[] {
  const systemPrompt = buildSystemPrompt(this.config?.systemPrompt, context, options);
  const args = ['--prompt', prompt, '--output-format', 'json'];
  if (systemPrompt) args.push('--system', systemPrompt);
  if (isResume && sessionId) args.push('--session', sessionId);
  if (options.model ?? this.config?.model) args.push('--model', options.model ?? this.config!.model!);
  return args;
}
```

- `sessionId` is the string to pass to `--resume` / `--session` (if the tool
  supports continuity). It is managed by `BaseSpawnPlugin` across daemon restarts
  via `~/.mia/plugin-sessions.json`.
- `isResume` is `true` when an existing session was found; `false` for a new
  conversation or after a session error.

### 2. `prepareEnv` — mutate the child environment

```typescript
protected prepareEnv(base: Record<string, string>): Record<string, string> {
  // Strip credentials not needed by this tool
  delete base.ANTHROPIC_API_KEY;
  // Merge plugin-specific env overrides from mia.json
  if (this.config?.env) Object.assign(base, this.config.env);
  return base;
}
```

`base` is a copy of `process.env` — mutate and return it.

### 3. `_handleMessage` — parse a single NDJSON line

```typescript
protected _handleMessage(
  taskId: string,
  rawMsg: unknown,
  callbacks: CodingPluginCallbacks
): void {
  const msg = rawMsg as Record<string, unknown>;
  switch (msg.type) {
    case 'token':
      callbacks.onToken(msg.text as string, taskId);
      this.tasks.get(taskId)!.resultBuffer =
        (this.tasks.get(taskId)!.resultBuffer ?? '') + (msg.text as string);
      break;

    case 'tool_call':
      callbacks.onToolCall(msg.name as string, msg.input as Record<string, unknown>, taskId);
      break;

    case 'tool_result':
      callbacks.onToolResult(msg.name as string, msg.output as string, taskId);
      break;

    case 'done': {
      const task = this.tasks.get(taskId)!;
      task.status = 'completed';
      task.result = (msg.output as string) ?? task.resultBuffer ?? '';
      task.callbackEmitted = true;
      callbacks.onDone(task.result, taskId);
      break;
    }

    case 'error': {
      const task = this.tasks.get(taskId);
      if (task && !task.callbackEmitted) {
        task.status = 'error';
        task.error = msg.message as string;
        task.callbackEmitted = true;
        callbacks.onError(
          new PluginError(msg.message as string, PluginErrorCode.PROVIDER_ERROR, this.name),
          taskId
        );
      }
      break;
    }
  }
}
```

Key points for `_handleMessage`:
- Always check `task.callbackEmitted` before emitting `onDone` or `onError` —
  the base class guarantees exactly one terminal callback per task.
- Accumulate streaming text into `task.resultBuffer`; set `task.result` on done.
- Use `PluginError` (not plain `Error`) for `onError` calls.

### Optional overrides

| Override | Purpose |
|---|---|
| `get pluginBinary()` | Binary name (default: same as `this.name`) |
| `requiresPresetSessionId` | Set `true` if the tool needs the session UUID passed before spawn (e.g. `--session-id`) |
| `prepareDispatchOptions(opts)` | Async pre-spawn hook for I/O-heavy setup (e.g. saving image to temp file) |
| `onTaskCleanup(taskId)` | Hook called when a task is evicted — clean up per-task state maps here |

### Full minimal example

```typescript
import { BaseSpawnPlugin } from '../base-spawn-plugin.js';
import { PluginError, PluginErrorCode } from '../types.js';
import type { CodingPluginCallbacks, DispatchOptions, PluginContext } from '../types.js';
import { buildSystemPrompt } from '../plugin-utils.js';

export class AcmePlugin extends BaseSpawnPlugin {
  readonly name = 'acme';
  readonly version = '1.0.0';
  protected get pluginBinary() { return 'acme'; }

  protected buildCliArgs(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    sessionId: string,
    isResume: boolean
  ): string[] {
    const sys = buildSystemPrompt(this.config?.systemPrompt, context, options);
    const args = ['-p', prompt, '--json'];
    if (sys) args.push('--system', sys);
    if (isResume) args.push('--resume', sessionId);
    if (options.model ?? this.config?.model) args.push('-m', options.model ?? this.config!.model!);
    return args;
  }

  protected prepareEnv(base: Record<string, string>): Record<string, string> {
    delete base.ANTHROPIC_API_KEY;
    if (this.config?.env) Object.assign(base, this.config.env);
    return base;
  }

  protected _handleMessage(
    taskId: string,
    rawMsg: unknown,
    callbacks: CodingPluginCallbacks
  ): void {
    const msg = rawMsg as Record<string, unknown>;
    const task = this.tasks.get(taskId);

    if (msg.type === 'text' && typeof msg.delta === 'string') {
      callbacks.onToken(msg.delta, taskId);
      if (task) task.resultBuffer = (task.resultBuffer ?? '') + msg.delta;
      return;
    }

    if (msg.type === 'done' && task && !task.callbackEmitted) {
      const output = task.resultBuffer ?? '';
      task.status = 'completed';
      task.result = output;
      task.callbackEmitted = true;
      callbacks.onDone(output, taskId);
    }
  }
}
```

---

## Creating an SDK-based plugin

If the agent exposes an HTTP/SDK API rather than a CLI binary, implement
`CodingPlugin` directly (without extending `BaseSpawnPlugin`). See
`src/plugins/implementations/opencode.plugin.ts` for the canonical example.

Key patterns to follow:

- **`initialize`**: Store config. Start the server lazily on first `dispatch`
  rather than eagerly — the daemon initialises all plugins at startup and not
  all will be used.
- **`isAvailable`**: Perform a lightweight health-check HTTP request. Return
  `false` (not `throw`) when the server is unreachable.
- **`dispatch`**: Arm a timeout via `setTimeout` at the start. Cancel it on
  `onDone`/`onError`. Guard against the same terminal callback firing twice.
- **`shutdown`**: Terminate the background server. Swallow all errors — `shutdown`
  is called unconditionally on daemon exit and must never throw.
- **Wrap all I/O in `withTimeout`**: Use `withTimeout(promise, ms, label)` for
  every network call that could stall. Import from `../../utils/with-timeout.js`.

---

## Session management

Session IDs provide _conversation continuity_: the same session string allows
the underlying agent to resume an existing context window instead of starting
fresh on every dispatch.

### Spawn-based plugins

`BaseSpawnPlugin` handles sessions via `~/.mia/plugin-sessions.json`:

```
first dispatch for conversationId X
  │
  ├─ _resolveSession("conv-X")
  │     ↳ no persisted session → isResume=false, sessionId=randomUUID()
  │
  └─ buildCliArgs(..., sessionId="abc-123", isResume=false)
       agent starts a new session and emits its session ID in its output

second dispatch for conversationId X
  │
  ├─ _resolveSession("conv-X")
  │     ↳ conversationSessions.get("conv-X") = "abc-123"
  │     ↳ isResume=true, sessionId="abc-123"
  │
  └─ buildCliArgs(..., sessionId="abc-123", isResume=true)
       agent resumes the existing context
```

Sessions persist across daemon restarts (saved to disk after each dispatch).

The plugin can discover a new session ID from the agent's output stream and
assign it via `task.sessionId = discoveredId; this.conversationSessions.set(convId, discoveredId)`.
See the `GeminiPlugin` `init` event handler for an example.

### SDK-based plugins

Manage sessions internally. Map `conversationId → agentSessionId` in a private
`Map<string, string>` and persist to disk as needed.

---

## Resilience mechanisms

### Per-plugin concurrency queue

Each spawn-based plugin maintains a per-conversation FIFO queue.
Dispatches for the _same_ conversation are serialised automatically — you never
need to worry about overlapping tool calls corrupting session state.

The queue depth is capped at 10 (`MAX_CONVERSATION_QUEUE_DEPTH`). When the cap
is reached, the incoming dispatch is rejected immediately with
`PluginErrorCode.CONCURRENCY_LIMIT` rather than silently stacking.

### Stall timeout

`BaseSpawnPlugin` arms an inactivity timer (default 30 min, configurable via
`stallTimeoutMs` in `mia.json`). The timer resets whenever the child emits any
NDJSON output. If no output arrives within the stall window, the child is killed
and the task fails with `PluginErrorCode.TIMEOUT`.

This is separate from the per-dispatch timeout (`timeoutMs`) which is a hard
wall-clock deadline regardless of activity.

### Circuit breaker

If a plugin binary fails to spawn 3 consecutive times, the circuit "opens" and
subsequent dispatch attempts are rejected immediately for 5 minutes. After the
cooldown, one probe dispatch is allowed through to test recovery.

This prevents the daemon from hammering a missing or broken binary in a tight
loop. The circuit is per-plugin and resets on a successful dispatch.

### Fallback chain

The dispatcher supports a fallback plugin list configured in `mia.json`:

```json
{
  "pluginDispatch": {
    "fallback": {
      "onDispatchError": true,
      "plugins": ["codex", "opencode"]
    }
  }
}
```

If the active plugin fails, the dispatcher tries each fallback in order. Context
is prepared once and shared across all attempts.

### `PluginError` error codes

| Code | Meaning | Fallback? |
|---|---|---|
| `TIMEOUT` | Hard deadline exceeded | Yes |
| `SPAWN_FAILURE` | Binary not found or fork failed | Yes |
| `PROCESS_EXIT` | Child exited with non-zero code | Yes |
| `BUFFER_OVERFLOW` | 10 MiB stdout buffer exceeded | No |
| `CONCURRENCY_LIMIT` | Max concurrent tasks reached | Yes |
| `PROVIDER_ERROR` | AI provider error (auth, quota) | Yes |
| `SESSION_ERROR` | Session create/resume failed | Yes |
| `ABORTED` | User stopped the task | No |
| `UNKNOWN` | Catch-all | Yes |

`ABORTED` and `BUFFER_OVERFLOW` are non-retriable — a fallback won't help.

---

## Plugin configuration

Each plugin can be configured in `~/.mia/mia.json` under the `plugins` key:

```json
{
  "activePlugin": "claude-code",
  "plugins": {
    "claude-code": {
      "binary": "claude",
      "model": "claude-opus-4-5",
      "timeoutMs": 1800000,
      "stallTimeoutMs": 120000,
      "maxConcurrency": 4,
      "systemPrompt": "You are an expert TypeScript engineer.",
      "extraArgs": ["--dangerously-skip-permissions"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    },
    "codex": {
      "binary": "codex",
      "model": "o4-mini"
    },
    "gemini": {
      "model": "gemini-2.5-pro"
    },
    "opencode": {
      "model": "anthropic/claude-sonnet-4-5"
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `binary` | `string` | plugin default | Path to the CLI binary |
| `model` | `string` | agent default | Default model to use |
| `timeoutMs` | `number` | `1800000` (30 min) | Hard per-dispatch wall-clock limit |
| `stallTimeoutMs` | `number` | `1800000` | Inactivity limit — kills child if silent |
| `maxConcurrency` | `number` | `4` | Max simultaneous dispatches |
| `systemPrompt` | `string` | Mia default | Override base system prompt |
| `extraArgs` | `string[]` | `[]` | Appended to every CLI invocation |
| `env` | `Record<string,string>` | `{}` | Extra env vars for the child process |

---

## Registering a new plugin

1. **Add the class** to `src/plugins/implementations/acme.plugin.ts`.

2. **Export it** from `src/plugins/index.ts`:
   ```typescript
   export { AcmePlugin } from './implementations/acme.plugin.js';
   ```

3. **Register it** in the daemon startup (`src/daemon/index.ts`):
   ```typescript
   const pluginEntries: PluginEntry[] = [
     { plugin: new ClaudeCodePlugin(), name: 'claude-code', defaults: { binary: 'claude' } },
     { plugin: new AcmePlugin(),       name: 'acme',        defaults: { binary: 'acme'  } },
     // ...
   ];
   ```

4. **Add the binary name** to `PLUGIN_DEFAULT_BINARIES` in `src/plugins/plugin-utils.ts`:
   ```typescript
   export const PLUGIN_DEFAULT_BINARIES = {
     'claude-code': 'claude',
     'acme': 'acme',
     // ...
   };
   ```

5. **Add an install hint** in `PluginDispatcher.INSTALL_HINTS`
   (`src/plugins/dispatcher.ts`) and `INSTALL_HINTS` in
   `src/daemon/commands/plugin.ts` so users get a useful message when the
   binary is missing.

6. **Update `ALL_PLUGIN_NAMES`** in `src/daemon/commands/plugin.ts` so
   `mia plugin list/switch/info/test` recognises the new plugin name.

---

## Testing a plugin

### Quick smoke test

```bash
mia plugin test acme
```

This instantiates the plugin outside the daemon, verifies the binary is
reachable, dispatches `"Reply with exactly: ok"`, and prints `PASS` or `FAIL`.

### Unit tests

Follow the pattern in `src/plugins/__tests__/claude-code.plugin.test.ts` and
`src/plugins/__tests__/codex.plugin.test.ts`. Key things to test:

- `buildCliArgs` produces the correct argv for new and resumed sessions.
- `_handleMessage` routes each event type to the correct callback.
- `_handleMessage` respects `callbackEmitted` — no duplicate terminal callbacks.
- `onTaskCleanup` removes all per-task state.
- Error events produce `PluginError` with the correct `code` and `plugin` name.

Mock `child_process` at the module level so no real processes are spawned:

```typescript
vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockChild()),
  execFile: vi.fn(),
}));
```

### Integration test via daemon

Start the daemon (`mia start`), then use `mia ask "Hello"` to exercise the
full pipeline: P2P → router → dispatcher → context-preparer → plugin → response.

Check `~/.mia/traces/YYYY-MM-DD.ndjson` for the trace record produced by the
dispatch; it includes timing, token counts, and the raw tool-call log.

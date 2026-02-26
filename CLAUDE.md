# MIA CLI

Token-efficient AI coding agent powered by Claude.

## Quick Reference

```bash
npm run build          # esbuild bundle + tsc declarations
npm run dev            # Run CLI directly via tsx
npm test               # vitest run
npm run test:watch     # vitest in watch mode
npm run test:coverage  # vitest with v8 coverage
npm run lint           # eslint
```

## Build

Uses esbuild (`scripts/build.mjs`) to produce three entry points:

- `dist/cli.js` — CLI binary (has shebang)
- `dist/daemon.js` — background daemon
- `dist/index.js` — library export

Output is ESM. Node modules are external (not bundled).

## Test

Framework: **Vitest** (config in `vitest.config.ts`).

Test files live next to source: `src/**/*.test.ts`.

Always run `npm test` after changing tool implementations or agent logic.

## Architecture

- **`src/agent.ts`** — Core Agent class. Manages conversation, tool calls, token tracking, streaming.
- **`src/tool_executor.ts`** — Tool registry and execution pipeline. Maps tool names to handlers with timeouts and validation.
- **`src/tool_definitions.ts`** — OpenAI-compatible tool schemas.
- **`src/cli.tsx`** — CLI entry point. Routes subcommands, loads env, renders Ink UI.
- **`src/cli/App.tsx`** — React + Ink interactive terminal UI.
- **`src/config/`** — Runtime configuration (`mia.json`) and model management.
- **`src/router/`** — Heuristic message classifier (coding vs general mode).
- **`src/daemon/`** — WebSocket daemon with message queue.
- **`src/p2p/`** — Hyperswarm peer-to-peer networking.
- **`src/tools/`** — Individual tool implementations (20+).
- **`src/memory/`** — LanceDB vector memory with reranking.
- **`src/utils/`** — Codebase context, token counting, session history, personality.

## Conventions

- TypeScript strict mode, ES2022 target, ESM output.
- JSX uses `react-jsx` transform (React 19 + Ink 6).
- Unused imports/vars are lint errors (underscore prefix allowed for intentional).
- Tool results are truncated to 8000 chars. Tool timeout is 30s.
- `.env` loading priority: repo `.env` → `~/.mia/.env` (latter wins for API keys).
- Runtime config lives at `~/.mia/mia.json`; memory at `~/.mia/memory.lance`.

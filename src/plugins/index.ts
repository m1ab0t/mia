/**
 * Plugin System — Public API
 */

export type {
  CodingPlugin,
  CodingPluginCallbacks,
  DispatchOptions,
  PluginContext,
  PluginDispatchResult,
  PluginConfig,
} from './types';

export { PluginRegistry } from './registry';
export { PluginDispatcher } from './dispatcher';

export { ContextPreparer } from './context-preparer';
export type { ContextPreparerOptions } from './context-preparer';

export { TraceLogger } from './trace-logger';
export type { TraceEvent, DispatchTrace, TraceLoggerOptions } from './trace-logger';

export { PostDispatchVerifier } from './verifier';
export type { VerificationCheck, VerificationResult, VerifierOptions } from './verifier';

export { MemoryExtractor } from './memory-extractor';
export type { MemoryExtractorOptions, ExtractedFact, ExtractionResult, UtilityDispatchFn } from './memory-extractor';

export { ClaudeCodePlugin } from './implementations/claude-code.plugin';
export { CodexPlugin } from './implementations/codex.plugin';
export { OpenCodePlugin } from './implementations/opencode.plugin';
export { GeminiPlugin } from './implementations/gemini.plugin';

export { MIA_SYSTEM_PROMPT, PLUGIN_DEFAULT_BINARIES } from './plugin-utils';

// ── Plugin factory ────────────────────────────────────────────────────────
import type { CodingPlugin } from './types';
import { ClaudeCodePlugin as _Claude } from './implementations/claude-code.plugin';
import { OpenCodePlugin as _OpenCode } from './implementations/opencode.plugin';
import { CodexPlugin as _Codex } from './implementations/codex.plugin';
import { GeminiPlugin as _Gemini } from './implementations/gemini.plugin';

/**
 * Create a CodingPlugin instance by plugin name.
 * Single source of truth for the if/else factory — used by daemon command
 * sub-modules (plugin.ts, scheduler.ts) instead of duplicating the branch.
 * Falls back to ClaudeCodePlugin for unrecognised names.
 */
export function createPluginByName(name: string): CodingPlugin {
  if (name === 'opencode') return new _OpenCode();
  if (name === 'codex') return new _Codex();
  if (name === 'gemini') return new _Gemini();
  return new _Claude();
}

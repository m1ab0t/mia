import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';
import { formatJson } from '../utils/json-format';
import { MIA_DIR } from '../constants/paths';
import type { PluginConfig } from '../plugins/types';

const CONFIG_FILE = join(MIA_DIR, 'mia.json');

export interface ModelCost {
  /** Cost per 1M input tokens (USD) */
  input: number;
  /** Cost per 1M output tokens (USD) */
  output: number;
  /** Cost per 1M cached read tokens (USD) */
  cacheRead?: number;
  /** Cost per 1M cache write tokens (USD) */
  cacheWrite?: number;
}

export interface ModelConfig {
  /** Full model name passed to fluency.js (e.g. 'openrouter/pony-alpha', 'claude-sonnet-4-6-20250929') */
  model: string;
  /** Display name (e.g. 'Claude Opus 4.6', 'Pony Alpha') */
  name?: string;
  /** Provider for fluency.js (e.g. 'openrouter', 'anthropic') */
  provider: string;
  /** Context window size in tokens */
  contextLimit?: number;
  /** Max output tokens per response */
  maxTokens?: number;
  /** Supported input types */
  input?: ('text' | 'image')[];
  /** Whether the model supports reasoning/thinking */
  reasoning?: boolean;
  /** Cost per 1M tokens (USD) */
  cost?: ModelCost;
}

export interface MiaConfig {
  /** Key name of the active model in the models map */
  activeModel?: string;
  /** Key name of the model used for coding tasks (falls back to activeModel) */
  codingModel?: string;
  /** Key name of the model used for general/chat tasks (falls back to activeModel) */
  generalModel?: string;
  /** Named model configurations */
  models?: Record<string, ModelConfig>;
  /** Model used for routing classification (cheap/fast) */
  classifierModel: string;
  /** Default route when classifier is unavailable: "coding" | "general" */
  defaultRoute: 'coding' | 'general';
  /** Max concurrent plugin tasks */
  maxConcurrency: number;
  /** Timeout for plugin tasks in ms */
  timeoutMs: number;
  /** System prompt for coding tasks (optional) */
  codingSystemPrompt?: string;
  /** Persistent seed for P2P topic key derivation */
  p2pSeed?: string;
  /** Whether to use ONNX cross-encoder reranking for memory search (default: true) */
  useReranker?: boolean;

  // ── Plugin system ──────────────────────────────────────────────────

  /**
   * Ordered list of fallback plugins to try when the active plugin is
   * unavailable or (optionally) fails at runtime.
   *
   * Example: ["opencode", "codex"]
   *
   * Plugins are tried in list order until one succeeds or the list is
   * exhausted. Only plugins that are registered and enabled are used.
   * The active plugin is always tried first and is automatically excluded
   * from the fallback list to avoid redundant double-attempts.
   */
  fallbackPlugins?: string[];

  /**
   * Whether the first-run awakening conversation has been initiated.
   * Set to true after the daemon sends the opening onboarding message.
   */
  awakeningDone?: boolean;

  /** Name of the active coding plugin (e.g. "claude-code", "codex", "opencode") */
  activePlugin?: string;
  /** Per-plugin configuration map */
  plugins?: Record<string, PluginConfig>;
  /** Plugin dispatch middleware configuration */
  pluginDispatch?: {
    verification?: {
      enabled?: boolean;
      semanticCheck?: boolean;
      retryOnFailure?: boolean;
    };
    tracing?: {
      enabled?: boolean;
      retentionDays?: number;
    };
    /**
     * Auto-memory extraction: after each successful dispatch, extract key facts
     * from the prompt+response and persist them to LanceDB so future sessions
     * benefit from accumulated knowledge.
     */
    memoryExtraction?: {
      /** Enable/disable fact extraction. Default: true */
      enabled?: boolean;
      /**
       * Minimum dispatch duration in ms before extraction is attempted.
       * Skips trivial quick-response dispatches. Default: 5_000 (5 s).
       */
      minDurationMs?: number;
      /** Maximum number of facts extracted per dispatch. Default: 5. */
      maxFacts?: number;
    };
    /**
     * Fallback chain behaviour when the active plugin fails.
     * The list of fallback plugins is configured via `fallbackPlugins` at the
     * top level of MiaConfig.
     */
    fallback?: {
      /**
       * Enable the fallback chain. Defaults to true whenever `fallbackPlugins`
       * is non-empty. Set to false to disable even if fallback plugins are listed.
       */
      enabled?: boolean;
      /**
       * Also attempt the fallback chain when a plugin's dispatch() throws or
       * returns success=false, not just when it's unavailable.
       * Default: false (fallback only on unavailability by default).
       */
      onDispatchError?: boolean;
    };
  };
  /**
   * Global defaults for scheduled task execution.
   * Each scheduled task can override these per-task in scheduled-tasks.json.
   */
  scheduler?: {
    /** Default timeout for scheduled task dispatches in ms (default: 5 min) */
    defaultTimeoutMs?: number;
  };

  /**
   * Memory store configuration.
   */
  memory?: {
    /**
     * TTL in days for LanceDB memory entries.
     * Entries older than this are pruned on daemon startup and every
     * `pruneIntervalHours` hours thereafter.
     * Set to 0 to disable pruning entirely. Default: 30.
     */
    ttlDays?: number;
    /**
     * How often (in hours) to run the periodic prune after startup.
     * Default: 24 (once a day).
     */
    pruneIntervalHours?: number;
    /**
     * Maximum number of entries in the in-memory LanceDB query result cache.
     * When the limit is reached, the least-recently-used entry is evicted.
     * Set to 0 to disable caching entirely.
     * Default: 256.
     */
    queryCacheMaxEntries?: number;
    /**
     * Maximum number of rows the LanceDB memories table may hold.
     * When a new entry is inserted and the total row count exceeds this limit,
     * the oldest entries (by timestamp) are evicted until the count is back
     * at the cap (FIFO eviction).
     * Set to 0 to disable the cap entirely.
     * Default: 10 000.
     */
    maxRows?: number;
  };

  /**
   * Configuration for the interactive `mia chat` command.
   */
  chat?: {
    /**
     * Maximum combined byte length of all pending context injections (/add, /exec, /diff)
     * before the user is warned that the context window may be overrun.
     *
     * Injections are still sent — this is a warning threshold, not a hard cap.
     * Default: 100_000 bytes (~100 KB, roughly 25K tokens at 4 bytes/token).
     */
    maxInjectionBytes?: number;
    /**
     * Timeout in ms for /exec commands run inside `mia chat`.
     * Increase this for slow build/test commands that regularly exceed 30 s.
     * Default: 30_000 (30 seconds).
     */
    execTimeoutMs?: number;
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

/** Known-good model-name pattern: at least one word character, may contain hyphens, dots, slashes */
const MODEL_NAME_RE = /^[\w][\w./-]*$/;

/** Sentinel set — update as new routes are added to the union type */
const VALID_ROUTES = new Set<string>(['coding', 'general']);

/**
 * Validate a loaded MiaConfig and throw a descriptive Error on the first
 * problem found. Called automatically by readMiaConfig() after merging with
 * defaults, so callers never see a half-broken config at runtime.
 */
export function validateMiaConfig(config: MiaConfig): void {
  // ── Required primitive fields ──────────────────────────────────────────────
  if (!config.classifierModel || typeof config.classifierModel !== 'string' || !config.classifierModel.trim()) {
    throw new Error('[mia-config] classifierModel is required and must be a non-empty string');
  }
  if (!MODEL_NAME_RE.test(config.classifierModel)) {
    throw new Error(`[mia-config] classifierModel has an invalid format: "${config.classifierModel}"`);
  }

  if (!VALID_ROUTES.has(config.defaultRoute)) {
    throw new Error(`[mia-config] defaultRoute must be "coding" or "general", got: "${config.defaultRoute}"`);
  }

  if (typeof config.maxConcurrency !== 'number' || !Number.isInteger(config.maxConcurrency) || config.maxConcurrency < 1) {
    throw new Error(`[mia-config] maxConcurrency must be a positive integer, got: ${config.maxConcurrency}`);
  }

  if (typeof config.timeoutMs !== 'number' || config.timeoutMs <= 0) {
    throw new Error(`[mia-config] timeoutMs must be a positive number, got: ${config.timeoutMs}`);
  }

  // ── models map ────────────────────────────────────────────────────────────
  if (config.models !== undefined) {
    for (const [key, m] of Object.entries(config.models)) {
      if (!m.model || typeof m.model !== 'string' || !m.model.trim()) {
        throw new Error(`[mia-config] models["${key}"].model is required and must be a non-empty string`);
      }
      if (!MODEL_NAME_RE.test(m.model)) {
        throw new Error(`[mia-config] models["${key}"].model has an invalid format: "${m.model}"`);
      }
      if (!m.provider || typeof m.provider !== 'string' || !m.provider.trim()) {
        throw new Error(`[mia-config] models["${key}"].provider is required and must be a non-empty string`);
      }
      if (m.contextLimit !== undefined && (typeof m.contextLimit !== 'number' || m.contextLimit <= 0)) {
        throw new Error(`[mia-config] models["${key}"].contextLimit must be a positive number`);
      }
      if (m.maxTokens !== undefined && (typeof m.maxTokens !== 'number' || m.maxTokens <= 0)) {
        throw new Error(`[mia-config] models["${key}"].maxTokens must be a positive number`);
      }
    }
  }

  // ── plugins map ───────────────────────────────────────────────────────────
  if (config.plugins !== undefined) {
    for (const [key, p] of Object.entries(config.plugins)) {
      if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== 'number' || p.timeoutMs <= 0)) {
        throw new Error(`[mia-config] plugins["${key}"].timeoutMs must be a positive number, got: ${p.timeoutMs}`);
      }
      if (p.maxConcurrency !== undefined && (typeof p.maxConcurrency !== 'number' || !Number.isInteger(p.maxConcurrency) || p.maxConcurrency < 1)) {
        throw new Error(`[mia-config] plugins["${key}"].maxConcurrency must be a positive integer, got: ${p.maxConcurrency}`);
      }
    }
  }

  // ── scheduler ─────────────────────────────────────────────────────────────
  if (config.scheduler?.defaultTimeoutMs !== undefined) {
    if (typeof config.scheduler.defaultTimeoutMs !== 'number' || config.scheduler.defaultTimeoutMs <= 0) {
      throw new Error(`[mia-config] scheduler.defaultTimeoutMs must be a positive number, got: ${config.scheduler.defaultTimeoutMs}`);
    }
  }

  // ── memory ────────────────────────────────────────────────────────────────
  if (config.memory?.ttlDays !== undefined) {
    if (typeof config.memory.ttlDays !== 'number' || !Number.isFinite(config.memory.ttlDays) || config.memory.ttlDays < 0) {
      throw new Error(`[mia-config] memory.ttlDays must be a non-negative number, got: ${config.memory.ttlDays}`);
    }
  }
  if (config.memory?.pruneIntervalHours !== undefined) {
    if (typeof config.memory.pruneIntervalHours !== 'number' || !Number.isFinite(config.memory.pruneIntervalHours) || config.memory.pruneIntervalHours <= 0) {
      throw new Error(`[mia-config] memory.pruneIntervalHours must be a positive number, got: ${config.memory.pruneIntervalHours}`);
    }
  }
  if (config.memory?.maxRows !== undefined) {
    if (typeof config.memory.maxRows !== 'number' || !Number.isInteger(config.memory.maxRows) || config.memory.maxRows < 0) {
      throw new Error(`[mia-config] memory.maxRows must be a non-negative integer, got: ${config.memory.maxRows}`);
    }
  }

  // ── chat ──────────────────────────────────────────────────────────────────
  if (config.chat?.maxInjectionBytes !== undefined) {
    if (typeof config.chat.maxInjectionBytes !== 'number' || config.chat.maxInjectionBytes <= 0) {
      throw new Error(`[mia-config] chat.maxInjectionBytes must be a positive number, got: ${config.chat.maxInjectionBytes}`);
    }
  }
  if (config.chat?.execTimeoutMs !== undefined) {
    if (typeof config.chat.execTimeoutMs !== 'number' || config.chat.execTimeoutMs <= 0) {
      throw new Error(`[mia-config] chat.execTimeoutMs must be a positive number, got: ${config.chat.execTimeoutMs}`);
    }
  }

  // ── pluginDispatch.tracing ────────────────────────────────────────────────
  const retention = config.pluginDispatch?.tracing?.retentionDays;
  if (retention !== undefined && (typeof retention !== 'number' || !Number.isInteger(retention) || retention < 1)) {
    throw new Error(`[mia-config] pluginDispatch.tracing.retentionDays must be a positive integer, got: ${retention}`);
  }

  // ── memoryExtraction ──────────────────────────────────────────────────────
  const me = config.pluginDispatch?.memoryExtraction;
  if (me !== undefined) {
    if (me.minDurationMs !== undefined && (typeof me.minDurationMs !== 'number' || me.minDurationMs < 0)) {
      throw new Error(`[mia-config] pluginDispatch.memoryExtraction.minDurationMs must be >= 0, got: ${me.minDurationMs}`);
    }
    if (me.maxFacts !== undefined && (typeof me.maxFacts !== 'number' || !Number.isInteger(me.maxFacts) || me.maxFacts < 1)) {
      throw new Error(`[mia-config] pluginDispatch.memoryExtraction.maxFacts must be a positive integer, got: ${me.maxFacts}`);
    }
  }
}

const DEFAULT_CONFIG: MiaConfig = {
  classifierModel: 'claude-haiku-4-5',
  defaultRoute: 'coding',
  maxConcurrency: 3,
  timeoutMs: 30 * 60 * 1000,
  activePlugin: 'claude-code',
  plugins: {
    'claude-code': {
      name: 'claude-code',
      enabled: true,
      binary: 'claude',
      model: 'claude-sonnet-4-6',
      maxConcurrency: 3,
      timeoutMs: 30 * 60 * 1000,
    },
    'opencode': {
      name: 'opencode',
      enabled: true,
      binary: 'opencode',
      model: 'anthropic/claude-sonnet-4-6',
      maxConcurrency: 3,
      timeoutMs: 30 * 60 * 1000,
    },
    'codex': {
      name: 'codex',
      enabled: true,
      binary: 'codex',
      model: 'gpt-5.2-chat-latest',
      maxConcurrency: 3,
      timeoutMs: 30 * 60 * 1000,
    },
  },
  pluginDispatch: {
    verification: { enabled: true },
    tracing: { enabled: true, retentionDays: 7 },
  },
  scheduler: {
    defaultTimeoutMs: 5 * 60 * 1000, // 5 minutes — fail-fast for stalled tasks
  },
  memory: {
    ttlDays: 30,
    pruneIntervalHours: 24,
  },
  chat: {
    maxInjectionBytes: 100_000,
  },
};

export function readMiaConfig(): MiaConfig {
  let merged: MiaConfig;
  try {
    if (!existsSync(CONFIG_FILE)) {
      merged = { ...DEFAULT_CONFIG };
    } else {
      const content = readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(content) as Partial<MiaConfig>;
      merged = { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // Unreadable / unparseable config — fall back to defaults silently.
    return { ...DEFAULT_CONFIG };
  }

  // Validate AFTER merging with defaults so required fields supplied only by
  // defaults are still present, but any user-supplied bad values are caught.
  validateMiaConfig(merged);
  return merged;
}

export function writeMiaConfig(config: Partial<MiaConfig>): MiaConfig {
  if (!existsSync(MIA_DIR)) {
    mkdirSync(MIA_DIR, { recursive: true });
  }
  const current = readMiaConfig();
  const merged = { ...current, ...config };
  writeFileSync(CONFIG_FILE, formatJson(merged), 'utf-8');
  return merged;
}

/**
 * Resolve the active model config from the models map.
 * Returns the ModelConfig for the activeModel key, or undefined if not set.
 */
export function getActiveModelConfig(): ModelConfig | undefined {
  const config = readMiaConfig();
  if (!config.activeModel || !config.models) return undefined;
  return config.models[config.activeModel];
}

/**
 * Resolve the model config for coding tasks.
 * Priority: codingModel → activeModel → undefined
 */
export function getCodingModelConfig(): ModelConfig | undefined {
  const config = readMiaConfig();
  if (!config.models) return undefined;
  if (config.codingModel && config.models[config.codingModel]) {
    return config.models[config.codingModel];
  }
  if (config.activeModel && config.models[config.activeModel]) {
    return config.models[config.activeModel];
  }
  return undefined;
}

/**
 * Resolve the model config for general/chat tasks.
 * Priority: generalModel → activeModel → undefined
 */
export function getGeneralModelConfig(): ModelConfig | undefined {
  const config = readMiaConfig();
  if (!config.models) return undefined;
  if (config.generalModel && config.models[config.generalModel]) {
    return config.models[config.generalModel];
  }
  if (config.activeModel && config.models[config.activeModel]) {
    return config.models[config.activeModel];
  }
  return undefined;
}

/**
 * Add or update a named model in the models map.
 */
export function setModelConfig(key: string, modelConfig: ModelConfig): MiaConfig {
  const config = readMiaConfig();
  const models = config.models || {};
  models[key] = modelConfig;
  return writeMiaConfig({ models });
}

/**
 * Remove a named model from the models map.
 */
export function removeModelConfig(key: string): MiaConfig {
  const config = readMiaConfig();
  const models = config.models || {};
  delete models[key];
  // If we removed the active model, clear activeModel
  const updates: Partial<MiaConfig> = { models };
  if (config.activeModel === key) {
    updates.activeModel = undefined;
  }
  return writeMiaConfig(updates);
}

export function deriveTopicKey(seed: string): Buffer {
  return crypto.createHash('sha256').update(seed).digest();
}

export function getOrCreateP2PSeed(): string {
  const config = readMiaConfig();
  if (config.p2pSeed) return config.p2pSeed;
  const seed = crypto.randomBytes(32).toString('hex');
  writeMiaConfig({ p2pSeed: seed });
  return seed;
}

export function refreshP2PSeed(): string {
  const seed = crypto.randomBytes(32).toString('hex');
  writeMiaConfig({ p2pSeed: seed });
  return seed;
}

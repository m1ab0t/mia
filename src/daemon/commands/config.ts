/**
 * Config command — `mia config [get|set] [key] [value]`
 *
 * View and edit the Mia configuration without touching ~/.mia/mia.json by hand.
 *
 * Usage:
 *   mia config                     show a human-readable config summary
 *   mia config get <key>           read a single dotted-path value
 *   mia config set <key> <value>   write a single dotted-path value
 *
 * Key examples (dotted path into MiaConfig):
 *   activePlugin
 *   maxConcurrency
 *   plugins.claude-code.model
 *   pluginDispatch.tracing.retentionDays
 *   scheduler.defaultTimeoutMs
 *
 * Value coercion (for `set`):
 *   "true" / "false"       → boolean
 *   numeric strings         → number
 *   JSON ({…} / […])        → parsed object / array
 *   anything else           → string
 */

import { x, bold, dim, red, green, cyan, gray, DASH } from '../../utils/ansi.js';
import { readPidFileAsync } from '../pid.js';
import { isPidAlive } from './lifecycle.js';

// ── Dotted-path helpers ──────────────────────────────────────────────────────

/**
 * Read a value from a nested object using a dotted path.
 * Returns `undefined` if any segment is missing or non-traversable.
 * Exported for testing.
 */
export function getAtPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Write a value into a nested object at a dotted path, creating intermediate
 * objects as needed.  Mutates `obj` in place.
 * Exported for testing.
 */
export function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === null || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Coerce a raw CLI string value to an appropriate JS type.
 * Exported for testing.
 */
export function coerceValue(raw: string): unknown {
  if (raw === 'true')  return true;
  if (raw === 'false') return false;
  if (raw === 'null')  return null;

  // JSON objects/arrays
  const trimmed = raw.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }

  // Numbers (integer or float, not NaN)
  const num = Number(raw);
  if (raw !== '' && !isNaN(num)) return num;

  return raw;
}

// ── Pretty-print helpers ─────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m === 0) return `${s}s`;
  if (rem === 0) return `${m}m`;
  return `${m}m ${rem}s`;
}

function row(label: string, value: string, labelWidth = 16): string {
  const dots = Math.max(2, labelWidth - label.length);
  return `  ${gray}${label}${x} ${dim}${'·'.repeat(dots)}${x} ${value}`;
}

function enabled(val: boolean | undefined, defaultOn = true): string {
  const on = val ?? defaultOn;
  return on ? `${green}enabled${x}` : `${dim}disabled${x}`;
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderConfig(config: Record<string, unknown>): void {
  // Widen types from the MiaConfig interface for generic access
  const c = config as {
    activePlugin?: string;
    maxConcurrency?: number;
    timeoutMs?: number;
    plugins?: Record<string, { model?: string; binary?: string; enabled?: boolean }>;
    pluginDispatch?: {
      verification?: { enabled?: boolean };
      tracing?: { enabled?: boolean; retentionDays?: number };
      memoryExtraction?: { enabled?: boolean };
      fallback?: { enabled?: boolean; onDispatchError?: boolean };
    };
    scheduler?: {
      defaultTimeoutMs?: number;
    };
    fallbackPlugins?: string[];
  };

  // ── Overview ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(`  ${bold}config${x}`);
  console.log(`  ${DASH}`);
  console.log(row('plugin',      `${cyan}${c.activePlugin ?? 'claude-code'}${x}`));
  console.log(row('concurrency', String(c.maxConcurrency ?? 10)));
  console.log(row('timeout',     fmtMs(c.timeoutMs ?? 30 * 60 * 1000)));

  if (c.fallbackPlugins && c.fallbackPlugins.length > 0) {
    console.log(row('fallbacks', c.fallbackPlugins.join(', ')));
  }

  // ── Plugins ───────────────────────────────────────────────────────────────
  const plugins = c.plugins ?? {};
  const pluginNames = Object.keys(plugins);
  if (pluginNames.length > 0) {
    console.log('');
    console.log(`  ${bold}plugins${x}`);
    console.log(`  ${DASH}`);

    const ORDER = ['claude-code', 'opencode', 'codex'];
    const sorted = [
      ...ORDER.filter(p => pluginNames.includes(p)),
      ...pluginNames.filter(p => !ORDER.includes(p)).sort(),
    ];

    for (const name of sorted) {
      const p = plugins[name];
      if (!p) continue;
      const isActive = name === (c.activePlugin ?? 'claude-code');
      const indicator = isActive ? `${green}●${x}` : `${dim}○${x}`;
      const nameStr = isActive ? `${bold}${name}${x}` : `${dim}${name}${x}`;
      const modelStr = p.model ? `  ${dim}${p.model}${x}` : '';
      const activeTag = isActive ? `  ${cyan}active${x}` : '';
      console.log(`  ${indicator} ${nameStr}${modelStr}${activeTag}`);
    }
  }

  // ── Dispatch middleware ────────────────────────────────────────────────────
  const pd = c.pluginDispatch;
  if (pd) {
    console.log('');
    console.log(`  ${bold}dispatch${x}`);
    console.log(`  ${DASH}`);
    console.log(row('verification',   enabled(pd.verification?.enabled)));
    const retDays = pd.tracing?.retentionDays;
    const tracingExtra = retDays != null ? `  ${dim}${retDays}d retention${x}` : '';
    console.log(row('tracing',        `${enabled(pd.tracing?.enabled)}${tracingExtra}`));
    console.log(row('mem extraction', enabled(pd.memoryExtraction?.enabled)));
    if (pd.fallback?.enabled != null) {
      const onErr = pd.fallback.onDispatchError ? `  ${dim}on error${x}` : '';
      console.log(row('fallback',      `${enabled(pd.fallback.enabled)}${onErr}`));
    }
  }

  // ── Scheduler defaults ─────────────────────────────────────────────────────
  const sched = c.scheduler;
  if (sched) {
    console.log('');
    console.log(`  ${bold}scheduler${x}`);
    console.log(`  ${DASH}`);
    if (sched.defaultTimeoutMs != null) {
      console.log(row('timeout', fmtMs(sched.defaultTimeoutMs)));
    }
  }

  console.log('');
  console.log(`  ${dim}mia config get <key>${x}          ${gray}read a value${x}`);
  console.log(`  ${dim}mia config set <key> <value>${x}  ${gray}write a value${x}`);
  console.log(`  ${dim}example keys:${x} ${dim}activePlugin  maxConcurrency  plugins.claude-code.model${x}`);
  console.log('');
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function handleConfigCommand(argv: string[]): Promise<void> {
  const { readMiaConfig, writeMiaConfig } = await import('../../config/mia-config.js');

  const sub = argv[0];

  // ── mia config get <key> ──────────────────────────────────────────────────
  if (sub === 'get') {
    const key = argv[1];
    if (!key) {
      console.log(`\n  ${dim}usage${x} ${cyan}mia config get${x} ${dim}<key>${x}`);
      console.log(`  ${dim}example${x} ${cyan}mia config get plugins.claude-code.model${x}\n`);
      process.exit(1);
    }

    const config = readMiaConfig() as unknown as Record<string, unknown>;
    const value = getAtPath(config, key);

    if (value === undefined) {
      console.log(`\n  ${red}not set${x}  ${dim}${key}${x}\n`);
      process.exit(1);
    }

    const formatted = typeof value === 'object'
      ? JSON.stringify(value, null, 2)
      : String(value);
    console.log(`\n  ${gray}${key}${x}  ${dim}··${x}  ${formatted}\n`);
    return;
  }

  // ── mia config set <key> <value> ─────────────────────────────────────────
  if (sub === 'set') {
    const key = argv[1];
    const rawValue = argv[2];

    if (!key || rawValue === undefined) {
      console.log(`\n  ${dim}usage${x} ${cyan}mia config set${x} ${dim}<key> <value>${x}`);
      console.log(`  ${dim}example${x} ${cyan}mia config set plugins.claude-code.model claude-opus-4-6${x}\n`);
      process.exit(1);
    }

    const value = coerceValue(rawValue);
    const config = readMiaConfig() as unknown as Record<string, unknown>;
    setAtPath(config, key, value);
    writeMiaConfig(config as Parameters<typeof writeMiaConfig>[0]);

    const display = typeof value === 'object' ? JSON.stringify(value) : String(value);
    console.log(`\n  ${green}set${x}  ${gray}${key}${x}  ${dim}→${x}  ${display}`);

    // Signal the running daemon to hot-reload config so the change takes
    // effect immediately — same pattern used by `mia mode` and `mia plugin switch`.
    const pid = await readPidFileAsync();
    if (isPidAlive(pid)) {
      try {
        process.kill(pid as number, 'SIGHUP');
        console.log(`  ${dim}daemon notified${x} ${dim}·${x} ${dim}takes effect immediately${x}`);
      } catch {
        console.log(`  ${dim}daemon running${x} ${dim}·${x} ${dim}takes effect on next dispatch${x}`);
      }
    }
    console.log('');
    return;
  }

  // ── mia config (no subcommand) — show summary ─────────────────────────────
  if (!sub || sub === 'show') {
    const config = readMiaConfig() as unknown as Record<string, unknown>;
    renderConfig(config);
    return;
  }

  // Unknown subcommand
  console.error(`\n  ${red}unknown subcommand${x}  ${dim}${sub}${x}`);
  console.log(`  ${dim}usage${x} ${cyan}mia config${x} ${dim}[get|set] [key] [value]${x}\n`);
  process.exit(1);
}

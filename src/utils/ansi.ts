/**
 * ANSI Terminal Utilities
 *
 * Provides consistent ANSI escape codes and formatting helpers
 * for terminal output across the CLI and daemon.
 */

// ANSI escape code constants
export const ansi = {
  // Text formatting
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
} as const;

/**
 * Format uptime from milliseconds into human-readable string
 */
export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Log level styling configuration
 */
export const levelStyles = {
  'INFO': { badge: `${ansi.blue}INFO${ansi.reset}`, color: ansi.white, icon: '\u2139' },
  'WARN': { badge: `${ansi.yellow}WARN${ansi.reset}`, color: ansi.yellow, icon: '\u26a0' },
  'ERROR': { badge: `${ansi.red}${ansi.bold}ERRO${ansi.reset}`, color: ansi.red, icon: '\u2716' },
  'SUCCESS': { badge: `${ansi.green}OKAY${ansi.reset}`, color: ansi.green, icon: '\u2714' },
  'DEBUG': { badge: `${ansi.gray}DBUG${ansi.reset}`, color: ansi.gray, icon: '\u2022' },
} as const;

// Pino numeric level → levelStyles key
const PINO_LEVEL_MAP: Record<number, keyof typeof levelStyles> = {
  10: 'DEBUG', // trace → debug badge
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'ERROR', // fatal
};

/**
 * Colorize log line based on structured, pino JSON, or legacy format
 */
export function colorizeLine(line: string): string {
  // Match new structured format: "2025-01-15 10:30:45.123 [LEVEL  ] message"
  const structured = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+\[(\w+)\s*\]\s+(.*)$/);
  if (structured) {
    const [, timestamp, level, message] = structured;
    const style = levelStyles[level.trim() as keyof typeof levelStyles] || levelStyles['INFO'];
    const ts = `${ansi.gray}${timestamp}${ansi.reset}`;
    return `${ts} ${style.icon} ${style.badge} ${style.color}${message}${ansi.reset}`;
  }

  // Match pino JSON format: {"level":30,"time":"...","msg":"..."}
  if (line.startsWith('{')) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.msg !== undefined) {
        const levelNum = typeof obj.level === 'number' ? obj.level : 30;
        const levelKey = PINO_LEVEL_MAP[levelNum] ?? 'INFO';
        const style = levelStyles[levelKey];
        const time = typeof obj.time === 'string'
          ? new Date(obj.time).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
          : '';
        const ts = time ? `${ansi.gray}${time}${ansi.reset} ` : '';
        const msg = String(obj.msg);
        return `${ts}${style.icon} ${style.badge} ${style.color}${msg}${ansi.reset}`;
      }
    } catch {
      // fall through
    }
  }

  // Match legacy format: "[daemon] message"
  const legacy = line.match(/^\[daemon\]\s+(.*)$/);
  if (legacy) {
    const message = legacy[1];
    let color: string = ansi.white;
    let icon = '\u2022';
    if (/error|fail/i.test(message)) { color = ansi.red; icon = '\u2716'; }
    else if (/started|connected|completed|running/i.test(message)) { color = ansi.green; icon = '\u2714'; }
    else if (/shutting|stopping|warn/i.test(message)) { color = ansi.yellow; icon = '\u26a0'; }
    else if (/processing/i.test(message)) { color = ansi.cyan; icon = '\u279c'; }
    return `  ${icon} ${ansi.dim}daemon${ansi.reset} ${color}${message}${ansi.reset}`;
  }

  // Pass through other lines dimmed
  return `${ansi.dim}${line}${ansi.reset}`;
}

// ── Named color exports ───────────────────────────────────────────────────────
//
// Convenience re-exports for use in command files.  Instead of writing:
//
//   import { ansi } from '../../utils/ansi.js';
//   const { reset: x, bold, dim, cyan, green, red, yellow, gray } = ansi;
//   const DASH = `${dim}${'─ '.repeat(19)}${x}`;
//
// command files can now write a single import:
//
//   import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';
//
export const x = ansi.reset;
export const { bold, dim, italic, underline } = ansi;
export const { black, red, green, yellow, blue, magenta, cyan, white, gray } = ansi;
export const { bgBlack, bgRed, bgGreen, bgYellow, bgBlue, bgMagenta, bgCyan, bgWhite } = ansi;

/** Standard 38-character section separator used across CLI command output. */
export const DASH = `${ansi.dim}${'─ '.repeat(19)}${ansi.reset}`;

/**
 * Format a millisecond duration into a compact human-readable string.
 *
 * Examples: `42ms`, `3s`, `2m 15s`, `1h 12m`.
 *
 * Previously duplicated in usage.ts, slash-commands.ts, and recap.ts.
 */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/**
 * Strip all ANSI escape sequences from a string.
 *
 * Useful when rendering text originally formatted for a terminal
 * into a plain-text or markdown context (e.g. P2P slash command responses).
 */
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

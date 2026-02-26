/**
 * watch — `mia watch [paths...] [options]`
 *
 * Watches file system paths for changes and automatically dispatches an AI
 * prompt when files change.  Turns Mia into a real-time pair programmer that
 * observes your edits and provides continuous feedback.
 *
 * Usage:
 *   mia watch                              # watch cwd in review mode
 *   mia watch src/ tests/                  # watch specific directories
 *   mia watch --mode test                  # run tests when files change
 *   mia watch --mode fix                   # auto-fix issues on change
 *   mia watch --mode docs                  # update docs on change
 *   mia watch --prompt "Review: {files}"   # custom prompt template
 *   mia watch --debounce 5000              # wait 5s after last change
 *   mia watch --min-interval 60000         # at most 1 dispatch per minute
 *   mia watch --dry-run                    # preview prompts without dispatching
 *   mia watch --no-context                 # skip workspace context (faster)
 *   mia watch --ignore ".cache,.tmp"       # additional ignore patterns
 *
 * Modes:
 *   review (default)  — identify bugs, issues, and improvements
 *   test              — run tests for changed files and fix failures
 *   fix               — attempt to fix issues in changed files
 *   docs              — update documentation/comments for changed files
 *
 * Template variables (use in --prompt):
 *   {files}  — newline-separated list of changed file paths
 *   {diff}   — git diff output for the changed files
 *   {cwd}    — working directory
 */

import { watch as fsWatch, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, isAbsolute } from 'path';
import { execFileSync } from 'child_process';
import { x, bold, dim, red, green, cyan, yellow, gray, DASH } from '../../utils/ansi.js';
import { DEFAULT_PLUGIN } from '../../constants.js';
import { loadActivePlugin } from './plugin-loader.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type WatchMode = 'review' | 'test' | 'fix' | 'docs';

export interface WatchArgs {
  paths: string[];
  mode: WatchMode;
  prompt: string | null;
  debounceMs: number;
  minIntervalMs: number;
  cwd: string;
  noContext: boolean;
  ignorePatterns: string[];
  dryRun: boolean;
}

// ── Built-in prompt templates ──────────────────────────────────────────────────

export const MODE_PROMPTS: Record<WatchMode, string> = {
  review: `Review the following changed files and identify any bugs, issues, or improvements. Be concise — focus on the highest-signal problems.

Changed files:
{files}

Diff:
{diff}`,

  test: `The following files changed. Run the relevant tests and fix any failures you find.

Changed files:
{files}`,

  fix: `The following files changed. Identify and fix any obvious errors, type issues, or bugs.

Changed files:
{files}

Diff:
{diff}`,

  docs: `Update the documentation, comments, or JSDoc for the following changed files to accurately reflect the current implementation.

Changed files:
{files}`,
};

// ── Default ignore patterns ────────────────────────────────────────────────────

/** Directory/segment names that are always ignored when watching. */
export const DEFAULT_IGNORE_DIRS: string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.mia',
  '.next',
  '.cache',
  '.turbo',
  '__pycache__',
];

/** File extensions that are always ignored. */
export const DEFAULT_IGNORE_EXTS: string[] = [
  '.log',
  '.map',
  '.d.ts',
  '.lock',
  '.snap',
];

// ── Argument parsing ───────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "watch") into structured WatchArgs.
 * Exported for testing.
 */
export function parseWatchArgs(argv: string[]): WatchArgs {
  const cwd = process.cwd();
  let mode: WatchMode = 'review';
  let prompt: string | null = null;
  let debounceMs = 2000;
  let minIntervalMs = 30_000;
  let noContext = false;
  let dryRun = false;
  const rawPaths: string[] = [];
  const extraIgnore: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode' && argv[i + 1]) {
      const m = argv[++i];
      if (m === 'review' || m === 'test' || m === 'fix' || m === 'docs') {
        mode = m;
      }
    } else if (arg === '--prompt' && argv[i + 1]) {
      prompt = argv[++i];
    } else if (arg === '--debounce' && argv[i + 1]) {
      const val = parseInt(argv[++i], 10);
      if (!isNaN(val) && val > 0) debounceMs = val;
    } else if (arg === '--min-interval' && argv[i + 1]) {
      const val = parseInt(argv[++i], 10);
      if (!isNaN(val) && val >= 0) minIntervalMs = val;
    } else if (arg === '--ignore' && argv[i + 1]) {
      extraIgnore.push(
        ...argv[++i]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (!arg.startsWith('--')) {
      rawPaths.push(arg);
    }
    // Unknown flags silently ignored — future-proof
  }

  // Resolve paths relative to cwd; default to cwd when no paths given
  const paths =
    rawPaths.length > 0
      ? rawPaths.map((p) => (isAbsolute(p) ? p : join(cwd, p)))
      : [cwd];

  return {
    paths,
    mode,
    prompt,
    debounceMs,
    minIntervalMs,
    cwd,
    noContext,
    ignorePatterns: [...DEFAULT_IGNORE_DIRS, ...extraIgnore],
    dryRun,
  };
}

// ── File filtering ─────────────────────────────────────────────────────────────

/**
 * Determine whether a file path should be ignored.
 *
 * Checks each path segment against ignorePatterns (for directory names) and
 * checks the file extension against DEFAULT_IGNORE_EXTS.
 *
 * Exported for testing.
 */
export function shouldIgnoreFile(
  filePath: string,
  ignorePatterns: string[],
): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');

  for (const pattern of ignorePatterns) {
    if (segments.includes(pattern)) return true;
  }

  for (const ext of DEFAULT_IGNORE_EXTS) {
    if (normalized.endsWith(ext)) return true;
  }

  return false;
}

// ── Prompt building ────────────────────────────────────────────────────────────

/**
 * Get the prompt template for the given mode (or the custom prompt string).
 * Exported for testing.
 */
export function getPromptTemplate(
  mode: WatchMode,
  customPrompt: string | null,
): string {
  if (customPrompt) return customPrompt;
  return MODE_PROMPTS[mode];
}

/**
 * Substitute template variables into a prompt string.
 *
 * Variables:
 *   {files} — newline-separated list of changed file paths
 *   {diff}  — git diff output
 *   {cwd}   — working directory
 *
 * Exported for testing.
 */
export function buildWatchPrompt(
  template: string,
  files: string[],
  diff: string,
  cwd: string,
): string {
  return template
    .replace('{files}', files.length > 0 ? files.join('\n') : '(none)')
    .replace('{diff}', diff || '(no diff available)')
    .replace('{cwd}', cwd);
}

// ── Git diff ───────────────────────────────────────────────────────────────────

/**
 * Get the unified git diff for a set of files.
 *
 * Tries `git diff HEAD` first (shows staged + unstaged changes relative to
 * the last commit), then falls back to `git diff` (unstaged only).
 * Returns an empty string on any error (e.g. not a git repo, or file deleted).
 *
 * Exported for testing.
 */
export function getFileDiff(
  files: string[],
  cwd: string,
  maxChars = 8_000,
): string {
  if (files.length === 0) return '';

  const runGit = (args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return '';
    }
  };

  // Try HEAD diff first (includes staged changes)
  const headDiff = runGit(['diff', 'HEAD', '--unified=3', '--', ...files]);
  if (headDiff) return headDiff.slice(0, maxChars);

  // Fall back to unstaged diff
  const unstagedDiff = runGit(['diff', '--unified=3', '--', ...files]);
  return unstagedDiff.slice(0, maxChars);
}

// ── Recursive watcher ──────────────────────────────────────────────────────────

/**
 * A cross-platform recursive directory watcher built on Node's `fs.watch`.
 *
 * Works on all Node.js versions by individually watching each subdirectory
 * rather than relying on the `recursive` option (which is not supported on
 * Linux inotify before Node 22).  Automatically starts watching newly created
 * subdirectories via rename events.
 */
class RecursiveWatcher {
  private readonly watchers = new Map<string, ReturnType<typeof fsWatch>>();
  private readonly callback: (filepath: string) => void;
  private readonly ignorePatterns: string[];
  private closed = false;

  constructor(
    callback: (filepath: string) => void,
    ignorePatterns: string[],
  ) {
    this.callback = callback;
    this.ignorePatterns = ignorePatterns;
  }

  /** Start watching a root directory (and all its subdirectories). */
  watchDir(dir: string): void {
    this._addDir(dir);
  }

  private _addDir(dir: string): void {
    if (this.closed || this.watchers.has(dir)) return;
    if (shouldIgnoreFile(dir, this.ignorePatterns)) return;

    try {
      const watcher = fsWatch(dir, (eventType, filename) => {
        if (!filename || this.closed) return;

        const fullPath = join(dir, filename);

        // When a new directory appears, start watching it too
        if (eventType === 'rename') {
          try {
            const stat = statSync(fullPath);
            if (stat.isDirectory()) this._addDir(fullPath);
          } catch {
            // File was deleted — remove its watcher if we had one
            this._removeDir(fullPath);
          }
        }

        if (!shouldIgnoreFile(fullPath, this.ignorePatterns)) {
          this.callback(fullPath);
        }
      });

      watcher.on('error', () => {
        this.watchers.delete(dir);
      });

      this.watchers.set(dir, watcher);

      // Seed: watch all existing subdirectories
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            this._addDir(join(dir, entry.name));
          }
        }
      } catch {
        /* ignore read errors */
      }
    } catch {
      /* ignore watch errors (permission denied, etc.) */
    }
  }

  private _removeDir(dir: string): void {
    const watcher = this.watchers.get(dir);
    if (watcher) {
      try { watcher.close(); } catch { /* ignore */ }
      this.watchers.delete(dir);
    }
  }

  close(): void {
    this.closed = true;
    for (const watcher of this.watchers.values()) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    this.watchers.clear();
  }

  get count(): number {
    return this.watchers.size;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function relPath(fullPath: string, cwd: string): string {
  try {
    return relative(cwd, fullPath) || fullPath;
  } catch {
    return fullPath;
  }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function handleWatchCommand(argv: string[]): Promise<void> {
  const args = parseWatchArgs(argv);
  const {
    paths,
    mode,
    prompt: customPrompt,
    debounceMs,
    minIntervalMs,
    cwd,
    noContext,
    ignorePatterns,
    dryRun,
  } = args;

  // Read config upfront for the header display (active plugin name)
  const { readMiaConfig } = await import('../../config/mia-config.js');

  const miaConfig = readMiaConfig();
  const activePluginName = miaConfig.activePlugin || DEFAULT_PLUGIN;

  const template = getPromptTemplate(mode, customPrompt);

  // ── Header ─────────────────────────────────────────────────────────────────

  const validPaths = paths.filter((p) => existsSync(p));
  const displayPaths = paths
    .map((p) => relPath(p, cwd) || p)
    .join(', ');

  console.log('');
  console.log(
    `  ${bold}watch${x}  ${dim}${activePluginName}${x}  ${dim}${dryRun ? 'dry-run · ' : ''}${mode} mode${x}`,
  );
  console.log(`  ${DASH}`);
  console.log(`  ${gray}watching${x}   ${dim}${displayPaths}${x}`);
  console.log(`  ${gray}debounce${x}   ${dim}${debounceMs}ms${x}`);
  console.log(
    `  ${gray}interval${x}   ${dim}${minIntervalMs === 0 ? 'none' : `${minIntervalMs}ms min`}${x}`,
  );
  if (noContext) {
    console.log(`  ${gray}context${x}    ${dim}disabled${x}`);
  }
  console.log(`  ${DASH}`);

  if (validPaths.length === 0) {
    console.error(
      `  ${red}no valid watch paths${x}  ${dim}${paths.join(', ')}${x}`,
    );
    process.exit(1);
  }

  // ── State ──────────────────────────────────────────────────────────────────

  const pendingFiles = new Set<string>();
  /** Files that arrived while a dispatch was in progress — dispatched once the current run finishes. */
  const queuedFiles = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDispatchAt = 0;
  let dispatchCount = 0;
  let isDispatching = false;

  // ── Dispatch ───────────────────────────────────────────────────────────────

  /**
   * Kick off a dispatch for any files that accumulated in `queuedFiles` while
   * the previous run was in progress.  Called at every exit point of
   * `triggerDispatch` where `isDispatching` transitions back to `false`.
   */
  function drainQueue(): void {
    if (queuedFiles.size > 0) {
      const next = Array.from(queuedFiles);
      queuedFiles.clear();
      void triggerDispatch(next);
    }
  }

  async function triggerDispatch(changedFiles: string[]): Promise<void> {
    if (isDispatching) {
      // Save these files — they will be dispatched immediately after the
      // current run completes rather than being silently dropped.
      for (const f of changedFiles) queuedFiles.add(f);
      const n = queuedFiles.size;
      console.log(
        `  ${yellow}⟳${x}  ${dim}dispatch in progress — ${n} file${n === 1 ? '' : 's'} queued${x}`,
      );
      return;
    }

    const now = Date.now();
    if (
      lastDispatchAt > 0 &&
      minIntervalMs > 0 &&
      now - lastDispatchAt < minIntervalMs
    ) {
      const waitSec = ((minIntervalMs - (now - lastDispatchAt)) / 1000).toFixed(
        0,
      );
      console.log(
        `  ${yellow}⟳${x}  ${dim}rate-limited, next dispatch available in ${waitSec}s${x}`,
      );
      return;
    }

    isDispatching = true;
    dispatchCount++;
    const dispatchNum = dispatchCount;

    const relFiles = changedFiles.map((f) => relPath(f, cwd));
    const displayFiles =
      relFiles.slice(0, 3).join(', ') +
      (relFiles.length > 3 ? ` +${relFiles.length - 3} more` : '');

    console.log('');
    console.log(
      `  ${cyan}↑${x}  ${dim}[${dispatchNum}]${x} ${bold}${displayFiles}${x}  ${dim}${formatTime(new Date())}${x}`,
    );

    // Build prompt
    const diff = getFileDiff(relFiles, cwd);
    const finalPrompt = buildWatchPrompt(template, relFiles, diff, cwd);

    // ── Dry-run ───────────────────────────────────────────────────────────────
    if (dryRun) {
      console.log('');
      console.log(`  ${dim}── prompt preview ──${x}`);
      const lines = finalPrompt.split('\n');
      const preview = lines.slice(0, 10).map((l) => `  ${dim}${l}${x}`).join('\n');
      console.log(preview);
      if (lines.length > 10) {
        console.log(`  ${dim}… (${lines.length - 10} more lines)${x}`);
      }
      console.log('');
      lastDispatchAt = Date.now();
      isDispatching = false;
      drainQueue();
      return;
    }

    // ── Context ───────────────────────────────────────────────────────────────
    let context: import('../../plugins/types.js').PluginContext;

    if (noContext) {
      context = {
        memoryFacts: [],
        codebaseContext: '',
        gitContext: '',
        workspaceSnapshot: '',
        projectInstructions: '',
      };
    } else {
      const { ContextPreparer } = await import(
        '../../plugins/context-preparer.js'
      );
      const preparer = new ContextPreparer({
        workingDirectory: cwd,
        summarize: false,
        conversationHistoryLimit: 0,
      });
      context = await preparer.prepare(finalPrompt, `watch-${Date.now()}`);
    }

    // ── Plugin ────────────────────────────────────────────────────────────────
    const { plugin } = await loadActivePlugin();

    const available = await plugin.isAvailable();
    if (!available) {
      console.log(
        `  ${red}✗${x}  ${dim}plugin not available: ${activePluginName}${x}`,
      );
      try { await plugin.shutdown(); } catch { /* ignore */ }
      isDispatching = false;
      drainQueue();
      return;
    }

    // ── Stream ────────────────────────────────────────────────────────────────
    const started = Date.now();
    let failed = false;
    let firstToken = true;

    process.stdout.write('  ');

    try {
      const result = await plugin.dispatch(
        finalPrompt,
        context,
        {
          conversationId: `watch-${Date.now()}`,
          workingDirectory: cwd,
        },
        {
          onToken: (token: string) => {
            firstToken = false;
            process.stdout.write(token);
          },
          onToolCall: (toolName: string) => {
            console.log('');
            console.log(`  ${dim}→ ${toolName}${x}`);
            process.stdout.write('  ');
            firstToken = true;
          },
          onToolResult: () => {},
          onDone: () => {},
          onError: (err: Error) => {
            failed = true;
            console.error('');
            console.error(`  ${red}error${x}  ${err.message}`);
          },
        },
      );

      // Batch fallback if plugin doesn't stream
      if (firstToken && result.output) {
        process.stdout.write(result.output);
      }
    } catch (err: unknown) {
      failed = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('');
      console.error(`  ${red}dispatch error${x}  ${msg}`);
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log('');
    console.log('');
    console.log(
      `  ${failed ? red : green}${failed ? '✗' : '✓'}${x}  ${dim}[${dispatchNum}] ${elapsed}s${x}`,
    );

    lastDispatchAt = Date.now();
    isDispatching = false;

    try { await plugin.shutdown(); } catch { /* ignore */ }

    // Print the idle prompt again so user knows we're still watching
    console.log(`  ${dim}watching… ${gray}ctrl+c to stop${x}`);
    console.log('');

    // Dispatch files that accumulated while this run was in progress.
    drainQueue();
  }

  // ── File change handler ────────────────────────────────────────────────────

  function onFileChange(fullPath: string): void {
    pendingFiles.add(fullPath);

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const files = Array.from(pendingFiles);
      pendingFiles.clear();
      debounceTimer = null;
      try {
        await triggerDispatch(files);
      } catch (err: unknown) {
        // Guard against unhandled rejections from triggerDispatch.  Without
        // this the watcher silently stops processing file changes after the
        // first unexpected error (e.g. plugin crash, network failure) because
        // the setTimeout callback is fire-and-forget from Node's perspective.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ${red}error${x}  ${msg} — watcher is still active`);
      }
    }, debounceMs);
  }

  // ── Start watching ─────────────────────────────────────────────────────────

  const watcher = new RecursiveWatcher(onFileChange, ignorePatterns);

  for (const p of validPaths) {
    watcher.watchDir(p);
  }

  if (watcher.count === 0) {
    console.error(`  ${red}no paths could be watched${x}`);
    process.exit(1);
  }

  console.log(
    `  ${dim}watching ${watcher.count} director${watcher.count === 1 ? 'y' : 'ies'}… ${gray}ctrl+c to stop${x}`,
  );
  console.log('');

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  process.on('SIGINT', () => {
    console.log('');
    console.log(`  ${dim}stopping…${x}`);
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
    console.log(
      `  ${dim}${dispatchCount} dispatch${dispatchCount === 1 ? '' : 'es'} total${x}`,
    );
    console.log('');
    process.exit(0);
  });

  // The event loop stays alive while RecursiveWatcher holds open file handles.
}

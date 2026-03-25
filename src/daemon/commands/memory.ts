/**
 * memory — mia memory [list|search|add|delete|stats]
 *
 * View and manage facts Mia has learned from your coding sessions.
 *
 * Facts are automatically extracted after each dispatch via MemoryExtractor
 * and injected into every subsequent prompt via ContextPreparer. This command
 * makes the memory store visible and lets you add, search, delete, and audit
 * facts manually — turning the silent memory system into a transparent,
 * interactive knowledge base.
 *
 * Usage:
 *   mia memory                       # list 20 most recent facts
 *   mia memory list                  # same as above
 *   mia memory list --ids            # include row IDs (for use with delete)
 *   mia memory search <q>            # semantic search over stored facts
 *   mia memory search <q> --ids      # search results with row IDs
 *   mia memory add <text>            # manually store a fact
 *   mia memory delete <id>           # delete a specific memory entry by ID
 *   mia memory stats                 # counts by memory type
 *
 * Flags:
 *   --limit <n>   result count (default: 20)
 *   --all         include all memory types, not just facts
 *   --ids         show row IDs alongside list / search results
 */

import { x, bold, dim, red, green, cyan, gray, yellow, DASH } from '../../utils/ansi.js';
import { getErrorMessage } from '../../utils/error-message.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryArgs {
  subcommand: 'list' | 'search' | 'add' | 'delete' | 'stats';
  /** Query text for the `search` subcommand. */
  query: string;
  /** Fact content for the `add` subcommand. */
  content: string;
  /** Row ID for the `delete` subcommand. */
  targetId: string;
  /** Max results to display. */
  limit: number;
  /** When true, show all memory types (not just facts). */
  all: boolean;
  /** When true, show row IDs alongside list/search results. */
  showIds: boolean;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "memory") into structured MemoryArgs.
 * Exported for unit testing.
 */
export function parseMemoryArgs(argv: string[]): MemoryArgs {
  let subcommand: MemoryArgs['subcommand'] = 'list';
  let limit = 20;
  let all = false;
  let showIds = false;
  const textParts: string[] = [];

  const first = argv[0];
  if (first === 'search') {
    subcommand = 'search';
  } else if (first === 'add') {
    subcommand = 'add';
  } else if (first === 'delete') {
    subcommand = 'delete';
  } else if (first === 'stats') {
    subcommand = 'stats';
  }
  // 'list', undefined, or any other value → 'list'

  // Process flags; collect non-flag positionals (after the subcommand word)
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n > 0) limit = n;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--ids') {
      showIds = true;
    } else if (!arg.startsWith('--')) {
      textParts.push(arg);
    }
  }

  const query    = subcommand === 'search' ? textParts.join(' ') : '';
  const content  = subcommand === 'add'    ? textParts.join(' ') : '';
  const targetId = subcommand === 'delete' ? (textParts[0] ?? '') : '';

  return { subcommand, query, content, targetId, limit, all, showIds };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/**
 * Return a human-readable age string for a Unix-ms timestamp.
 * Exported for unit testing.
 */
export function formatAge(timestamp: number): string {
  const ageMs = Date.now() - timestamp;
  const s = Math.floor(ageMs / 1000);
  if (s < 60)   return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30)   return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12)  return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Render a single memory entry to stdout.
 * Non-fact types are tagged so the user knows why they appear with --all.
 * When `id` is provided it is shown on the age line for use with `mia memory delete`.
 */
function renderEntry(
  content: string,
  timestamp: number,
  type: string,
  index: number,
  id?: string,
): void {
  const age = formatAge(timestamp);
  const typeTag = type !== 'fact' ? `${dim}[${type}] ${x}` : '';
  const num = String(index + 1).padStart(2);
  const idSuffix = id ? `  ${dim}id: ${gray}${id}${x}` : '';
  console.log(`  ${dim}${num}.${x}  ${typeTag}${content}`);
  console.log(`       ${gray}${age}${x}${idSuffix}`);
}

function renderNoResults(subcommand: string, query?: string): void {
  console.log('');
  if (subcommand === 'search' && query) {
    console.log(`  ${dim}no memories match${x} ${cyan}${query}${x}`);
    console.log(`  ${dim}try a broader term or run${x} ${cyan}mia memory stats${x} ${dim}to see what's stored${x}`);
  } else {
    console.log(`  ${dim}no facts stored yet${x}`);
    console.log(`  ${dim}they are extracted automatically after each dispatch${x}`);
    console.log(`  ${dim}or add one with${x} ${cyan}mia memory add "The project uses pnpm"${x}`);
  }
  console.log('');
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function handleMemoryCommand(argv: string[]): Promise<void> {
  const args = parseMemoryArgs(argv);

  // Lazy-import: avoids loading SQLite when the user runs other commands
  const { initMemoryStore } = await import('../../memory/index.js');

  let store: Awaited<ReturnType<typeof initMemoryStore>>;
  try {
    store = await initMemoryStore();
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    console.error(`\n  ${red}failed to open memory store${x}  ${dim}${msg}${x}\n`);
    process.exit(1);
  }

  // ── list ─────────────────────────────────────────────────────────────────────

  if (args.subcommand === 'list') {
    console.log('');
    const typeLabel = args.all ? 'all types' : 'facts';
    console.log(`  ${bold}memory${x}  ${dim}recent ${typeLabel}${x}`);
    console.log(`  ${DASH}`);

    // Over-fetch so we have enough facts after filtering (getRecent returns mixed types)
    const fetchLimit = args.all ? args.limit : args.limit * 8;
    const recent = await store.getRecent(fetchLimit);
    const entries = args.all
      ? recent.slice(0, args.limit)
      : recent.filter(r => r.type === 'fact').slice(0, args.limit);

    if (entries.length === 0) {
      renderNoResults('list');
      return;
    }

    console.log('');
    entries.forEach((r, i) => renderEntry(r.content, r.timestamp, r.type, i, args.showIds ? r.id : undefined));
    console.log('');

    const total = entries.length;
    console.log(
      `  ${dim}showing ${total} ${total !== 1 ? 'entries' : 'entry'}` +
      `  ·  ${gray}mia memory search <query>${x}${dim} to filter` +
      `  ·  ${gray}--all${x}${dim} for other types` +
      `  ·  ${gray}--ids${x}${dim} to show IDs${x}`,
    );
    console.log('');
    return;
  }

  // ── search ───────────────────────────────────────────────────────────────────

  if (args.subcommand === 'search') {
    if (!args.query.trim()) {
      console.error(`\n  ${red}search requires a query${x}  ${dim}mia memory search "pnpm workspaces"${x}\n`);
      process.exit(1);
    }

    console.log('');
    console.log(`  ${bold}memory${x}  ${dim}search: ${cyan}${args.query}${x}`);
    console.log(`  ${DASH}`);

    const results = args.all
      ? await store.search(args.query, args.limit)
      : await store.searchByType(args.query, 'fact', args.limit);

    if (results.length === 0) {
      renderNoResults('search', args.query);
      return;
    }

    console.log('');
    results.forEach((r, i) => renderEntry(r.content, r.timestamp, r.type, i, args.showIds ? r.id : undefined));
    console.log('');

    const count = results.length;
    console.log(
      `  ${dim}${count} result${count !== 1 ? 's' : ''} for${x} ${cyan}${args.query}${x}` +
      `  ${dim}·  ${gray}--ids${x}${dim} to show IDs${x}`,
    );
    console.log('');
    return;
  }

  // ── add ──────────────────────────────────────────────────────────────────────

  if (args.subcommand === 'add') {
    if (!args.content.trim()) {
      console.error(
        `\n  ${red}add requires content${x}  ` +
        `${dim}mia memory add "The project uses pnpm workspaces"${x}\n`,
      );
      process.exit(1);
    }

    const fact = args.content.trim();
    console.log('');
    process.stdout.write(`  ${dim}storing…${x}  `);

    try {
      const id = await store.storeFact(fact, 'manual');
      if (id) {
        console.log(`${green}stored${x}  ${dim}${id}${x}`);
        console.log('');
        console.log(`  ${dim}fact:${x}  ${fact}`);
        console.log('');
        console.log(`  ${dim}this fact will now be included in future dispatch context${x}`);
      } else {
        console.log(`${yellow}skipped${x}`);
        console.log(`  ${dim}the memory store returned no ID — it may not be fully initialized${x}`);
      }
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      console.log(`${red}failed${x}  ${dim}${msg}${x}`);
    }

    console.log('');
    return;
  }

  // ── delete ───────────────────────────────────────────────────────────────────

  if (args.subcommand === 'delete') {
    if (!args.targetId.trim()) {
      console.error(
        `\n  ${red}delete requires an ID${x}  ` +
        `${dim}mia memory list --ids  →  mia memory delete <id>${x}\n`,
      );
      process.exit(1);
    }

    const id = args.targetId.trim();
    console.log('');
    process.stdout.write(`  ${dim}deleting ${gray}${id}${x}${dim}…${x}  `);

    try {
      const deleted = store.deleteById(id);
      if (deleted) {
        console.log(`${green}deleted${x}`);
        console.log('');
        console.log(`  ${dim}the fact will no longer appear in future dispatch context${x}`);
      } else {
        console.log(`${yellow}not found${x}`);
        console.log('');
        console.log(`  ${dim}no memory entry with id${x} ${gray}${id}${x}`);
        console.log(`  ${dim}run${x} ${cyan}mia memory list --ids${x} ${dim}to see available IDs${x}`);
      }
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      console.log(`${red}failed${x}  ${dim}${msg}${x}`);
    }

    console.log('');
    return;
  }

  // ── stats ─────────────────────────────────────────────────────────────────────

  if (args.subcommand === 'stats') {
    console.log('');
    console.log(`  ${bold}memory${x}  ${dim}statistics${x}`);
    console.log(`  ${DASH}`);

    try {
      const stats = await store.getStats();
      console.log('');
      console.log(`  ${dim}total${x}    ${bold}${stats.totalMemories}${x}`);
      console.log('');

      if (stats.totalMemories === 0) {
        console.log(`  ${dim}no memories stored yet${x}`);
        console.log(`  ${dim}they are extracted automatically after each dispatch${x}`);
        console.log('');
      } else {
        for (const [type, count] of Object.entries(stats.byType)) {
          if (count === 0) continue;
          const barLen = Math.min(Math.ceil(count / Math.max(stats.totalMemories / 20, 1)), 20);
          const bar = '█'.repeat(barLen);
          const countStr = String(count).padStart(5);
          console.log(
            `  ${cyan}${type.padEnd(14)}${x}  ${bold}${countStr}${x}  ${dim}${bar}${x}`,
          );
        }

        console.log('');
        console.log(
          `  ${dim}facts are surfaced via${x} ${gray}mia memory search${x}` +
          `  ·  manage with${x} ${gray}mia memory add / list${x}`,
        );
      }

      // ── Query cache metrics ────────────────────────────────────────────────
      const cache = store.getCacheStats();
      const totalLookups = cache.hits + cache.misses;
      if (totalLookups > 0) {
        const hitPct = (cache.hitRate * 100).toFixed(1);
        const hitColor = cache.hitRate >= 0.5 ? green : cache.hitRate >= 0.2 ? yellow : red;
        console.log('');
        console.log(`  ${bold}query cache${x}  ${dim}(since daemon start)${x}`);
        console.log(`  ${DASH}`);
        console.log(`  ${dim}hits${x}      ${bold}${cache.hits}${x}`);
        console.log(`  ${dim}misses${x}    ${bold}${cache.misses}${x}`);
        console.log(`  ${dim}hit rate${x}  ${hitColor}${hitPct}%${x}`);
        if (cache.size > 0) {
          console.log(`  ${dim}entries${x}   ${bold}${cache.size}${x}  ${dim}(live)${x}`);
        }
      }

    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      console.log(`  ${red}error reading stats${x}  ${dim}${msg}${x}`);
    }

    console.log('');
    return;
  }
}

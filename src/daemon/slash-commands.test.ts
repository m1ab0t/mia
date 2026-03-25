/**
 * Tests for slash-commands.ts
 *
 * Covers: parseSlashCommand, handleSlashCommand dispatch for each command,
 * and verifies markdown output (no ANSI codes).
 *
 * Commands covered:
 *   parseSlashCommand  — tokenisation edge-cases
 *   handleSlashCommand — routing, error wrapping, timeout
 *   /help              — markdown table
 *   /status            — running / not-running
 *   /usage             — analytics, window arg, empty
 *   /memory            — list, stats, search
 *   /config            — overview, get, unset key
 *   /doctor            — health checks
 *   /log               — dispatch log
 *   /recap             — daily recap, empty
 *   /standup           — repo activity, no activity
 *   /persona           — list, set, show, missing arg, unknown persona, show not found
 *   /update            — success, up-to-date, failed, partial rollback
 *   /mode              — show current, switch coding↔general, already-in-mode, unknown arg
 *   /changelog         — commit groups, prefix stripping, no-tag, empty, --from flag
 */

import { describe, it, expect, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────

// Mock daemon/pid for /status
vi.mock('./pid', () => ({
  readPidFileAsync: vi.fn(() => Promise.resolve(1234)),
  readStatusFileAsync: vi.fn(() => Promise.resolve({
    pid: 1234,
    startedAt: Date.now() - 60_000,
    version: '1.0.0',
    commit: 'abc1234',
    p2pKey: 'deadbeef12345678abcd',
    p2pPeers: 2,
    schedulerTasks: 3,
    pluginTasks: 1,
    pluginCompleted: 42,
    activePlugin: 'claude-code',
  })),
}));

// Mock lifecycle for isPidAlive
vi.mock('./commands/lifecycle', () => ({
  isPidAlive: vi.fn(() => true),
}));

// Mock config
vi.mock('../config/mia-config', () => ({
  readMiaConfigAsync: vi.fn(async () => ({
    activePlugin: 'claude-code',
    activeMode: 'coding',
    maxConcurrency: 3,
    timeoutMs: 1_800_000,
    plugins: {
      'claude-code': { model: 'claude-sonnet-4-5-20250929' },
    },
  })),
  writeMiaConfigAsync: vi.fn(async () => undefined),
}));

// Mock usage command data functions
vi.mock('./commands/usage', () => ({
  getTargetDates: vi.fn(() => ['2026-02-25']),
  getTargetDatesAsync: vi.fn(() => Promise.resolve(['2026-02-25'])),
  loadTraces: vi.fn(() => []),
  loadTracesAsync: vi.fn(() => Promise.resolve([])),
  aggregate: vi.fn(() => ({
    totalDispatches: 5,
    totalDurationMs: 60_000,
    totalToolCalls: 12,
    successCount: 4,
    failCount: 1,
    byPlugin: {
      'claude-code': {
        dispatches: 5,
        totalDurationMs: 60_000,
        successCount: 4,
        failCount: 1,
        toolCalls: 12,
        totalTurns: 10,
        turnsCount: 5,
        inputTokens: 5000,
        outputTokens: 2000,
        cachedTokens: 1000,
        tokenDispatches: 5,
      },
    },
    toolFrequency: { 'Read': 6, 'Edit': 4, 'Bash': 2 },
    hourlyDispatches: Array(24).fill(0),
    dateRange: { from: '2026-02-25', to: '2026-02-25' },
    traceCount: 5,
    topCommandsByTokens: [],
  })),
}));

// Mock memory store
vi.mock('../memory/index', () => ({
  initMemoryStore: vi.fn(async () => ({
    getRecent: vi.fn(async () => [
      { content: 'Project uses TypeScript', type: 'fact', timestamp: Date.now() },
      { content: 'ESM output format', type: 'fact', timestamp: Date.now() },
    ]),
    searchByType: vi.fn(async () => [
      { content: 'Project uses TypeScript', type: 'fact', timestamp: Date.now() },
    ]),
    getStats: vi.fn(async () => ({
      totalMemories: 42,
      byType: { fact: 30, conversation: 8, summary: 4 },
    })),
  })),
}));

// Mock log command
const MOCK_LOG_RECORDS = [
  {
    traceId: 'tr-1',
    timestamp: new Date().toISOString(),
    plugin: 'claude-code',
    conversationId: 'conv-1',
    prompt: 'fix the bug',
    durationMs: 5000,
    result: { success: true, durationMs: 5000 },
    events: [],
  },
];

vi.mock('./commands/log', () => ({
  loadAllTraces: vi.fn(() => MOCK_LOG_RECORDS),
  loadAllTracesAsync: vi.fn(() => Promise.resolve(MOCK_LOG_RECORDS)),
  filterTraces: vi.fn((records: unknown[]) => records),
  parseLogArgs: vi.fn(() => ({
    count: 20,
    failedOnly: false,
    schedulerOnly: false,
    conversationId: null,
    full: false,
  })),
  formatRelativeTime: vi.fn(() => '5m ago'),
  formatDuration: vi.fn(() => '5s'),
}));

// Mock recap command
vi.mock('./commands/recap', () => ({
  parseRecapArgs: vi.fn(() => ({ date: '2026-02-25', json: false, week: false })),
  loadTracesForDate: vi.fn(() => []),
  loadTracesForDateAsync: vi.fn(() => Promise.resolve([])),
  buildRecap: vi.fn(() => ({
    date: '2026-02-25',
    dispatches: 3,
    successCount: 3,
    failCount: 0,
    totalDurationMs: 45_000,
    conversations: ['conv-1'],
    schedulerDispatches: 0,
    commits: ['abc1234 fix bug'],
    filesChanged: ['src/app.ts'],
    uniqueFilesCount: 1,
    topTools: [{ name: 'Read', count: 5 }],
    firstDispatch: null,
    lastDispatch: null,
    activeSpanMs: 0,
    peakHour: null,
    plugins: ['claude-code'],
  })),
  buildWeeklyRecapAsync: vi.fn(() => Promise.resolve({
    startDate: '2026-02-19',
    endDate: '2026-02-25',
    days: [
      { date: '2026-02-19', dispatches: 2, successCount: 2, failCount: 0, durationMs: 10_000, commits: 1 },
      { date: '2026-02-20', dispatches: 0, successCount: 0, failCount: 0, durationMs: 0, commits: 0 },
      { date: '2026-02-21', dispatches: 5, successCount: 4, failCount: 1, durationMs: 60_000, commits: 2 },
      { date: '2026-02-22', dispatches: 3, successCount: 3, failCount: 0, durationMs: 30_000, commits: 0 },
      { date: '2026-02-23', dispatches: 1, successCount: 1, failCount: 0, durationMs: 5_000, commits: 0 },
      { date: '2026-02-24', dispatches: 4, successCount: 4, failCount: 0, durationMs: 40_000, commits: 1 },
      { date: '2026-02-25', dispatches: 3, successCount: 3, failCount: 0, durationMs: 45_000, commits: 0 },
    ],
    totals: {
      dispatches: 18,
      successCount: 17,
      failCount: 1,
      totalDurationMs: 190_000,
      commits: 4,
      uniqueFiles: 6,
      conversations: 7,
    },
    topTools: [{ name: 'Read', count: 22 }, { name: 'Edit', count: 11 }],
    plugins: ['claude-code'],
    busiestDay: '2026-02-21',
    quietDays: 1,
  })),
}));

// Mock doctor
vi.mock('./commands/doctor', () => ({
  runAllChecks: vi.fn(async () => [
    { name: 'daemon', status: 'ok', detail: 'running  pid 1234' },
    { name: 'config', status: 'ok', detail: 'ok' },
    { name: 'memory', status: 'warn', detail: 'not initialised', hint: 'run a dispatch' },
  ]),
}));

// Mock standup command
vi.mock('./commands/standup', () => ({
  parseStandupArgs: vi.fn((argv: string[]) => {
    const yesterday = argv.includes('--yesterday');
    const now = new Date();
    const since = yesterday
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
      : new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return {
      cwd: '/home/user/project',
      since,
      until: now,
      repos: [],
      raw: false,
      dryRun: false,
      noContext: false,
    };
  }),
  // Async variants — used by the daemon /standup slash-command handler to
  // avoid blocking the event loop with execFileSync/readdirSync/readFileSync.
  gatherRepoActivityAsync: vi.fn(() => Promise.resolve({
    path: '/home/user/project',
    name: 'project',
    branch: 'main',
    commits: [
      { hash: 'abc123456', author: 'dev', when: '3 hours ago', subject: 'feat: add slash commands', repo: 'project' },
      { hash: 'def789012', author: 'dev', when: '5 hours ago', subject: 'fix: router bug', repo: 'project' },
    ],
    dirtyFiles: ['src/index.ts'],
    openPrs: ['Add P2P slash commands'],
  })),
  loadDispatchSummaryAsync: vi.fn(() => Promise.resolve({
    total: 4,
    successful: 3,
    prompts: ['fix the router', 'add tests'],
  })),
}));

// Mock config command helper
vi.mock('./commands/config', () => ({
  getAtPath: vi.fn((obj: Record<string, unknown>, path: string) => {
    if (path === 'activePlugin') return 'claude-code';
    return undefined;
  }),
}));

// Mock personas module
vi.mock('../personas/index', () => ({
  listPersonas: vi.fn(async () => [
    { name: 'mia',      isActive: true,  isPreset: true,  description: 'Default assistant' },
    { name: 'architect', isActive: false, isPreset: true,  description: 'Systems thinker' },
    { name: 'custom',   isActive: false, isPreset: false, description: undefined },
  ]),
  setActivePersona: vi.fn(async (name: string) => name),
  getActivePersona: vi.fn(async () => 'mia'),
  loadPersonaContent: vi.fn(async (name: string) => {
    if (name === 'mia') return '# MIA Persona\n\nDefault assistant content.';
    return null;
  }),
}));

// Mock changelog command
const MOCK_COMMITS = [
  { hash: 'abc1234', subject: 'feat(auth): add OAuth login', body: '' },
  { hash: 'def5678', subject: 'fix(router): handle null sessions', body: '' },
  { hash: 'ghi9012', subject: 'docs: update README', body: '' },
];

vi.mock('./commands/changelog', () => ({
  parseChangelogArgs: vi.fn((argv: string[]) => {
    let from: string | null = null;
    let cwd = process.cwd();
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--from' && argv[i + 1]) from = argv[++i];
      if (argv[i] === '--cwd' && argv[i + 1]) cwd = argv[++i];
    }
    return { cwd, from, to: 'HEAD', version: null, write: false, dryRun: false, raw: false, noContext: false };
  }),
  getLastTagAsync: vi.fn(async () => 'v1.0.0'),
  getCommitsBetweenAsync: vi.fn(async () => MOCK_COMMITS),
  groupCommitsByCategory: vi.fn(() => ({
    Added:   ['feat(auth): add OAuth login'],
    Changed: [],
    Fixed:   ['fix(router): handle null sessions'],
    Removed: [],
    Other:   ['docs: update README'],
  })),
}));

// Mock suggestions service
const mockSuggestionsService = {
  getActive: vi.fn(() => [
    { id: 'sug_001', name: 'Add request retry logic', description: 'Wrap outgoing HTTP calls in exponential backoff.', createdAt: Date.now() },
    { id: 'sug_002', name: 'Add integration tests for auth', description: 'Cover the OAuth flow end-to-end.', createdAt: Date.now() },
  ]),
  getGreetings: vi.fn(() => ['What are we shipping today?']),
  getFullStore: vi.fn(() => ({
    active: [
      { id: 'sug_001', name: 'Add request retry logic', description: 'Wrap outgoing HTTP calls in exponential backoff.', createdAt: Date.now() },
    ],
    dismissed: [
      { id: 'sug_dis_001', name: 'Migrate to ESM', description: 'Already done.', createdAt: Date.now() },
    ],
    completed: [],
  })),
  clearHistory: vi.fn(() => [
    { id: 'sug_001', name: 'Add request retry logic', description: 'Wrap outgoing HTTP calls.', createdAt: Date.now() },
  ]),
  isGenerating: vi.fn(() => false),
  generate: vi.fn(() => Promise.resolve()),
  maybeGenerate: vi.fn(() => Promise.resolve()),
  isStale: vi.fn(() => false),
  dismiss: vi.fn((id: string) => []),
  complete: vi.fn((id: string) => []),
  restore: vi.fn((id: string) => []),
};

vi.mock('../suggestions/index', () => ({
  getSuggestionsService: vi.fn(() => mockSuggestionsService),
}));

// Mock update command
vi.mock('./commands/update', () => ({
  performUpdate: vi.fn(async () => ({
    success: true,
    upToDate: false,
    version: '2.1.0',
    commit: 'deadbeef',
    daemonRestarted: true,
    steps: [
      { name: 'fetch', status: 'ok',   detail: 'fetched origin' },
      { name: 'pull',  status: 'ok',   detail: 'fast-forward to deadbeef' },
      { name: 'build', status: 'ok',   detail: 'dist/ ready' },
    ],
    error: undefined,
  })),
}));

// ── Import after mocks ───────────────────────────────────────────────

import { parseSlashCommand, handleSlashCommand } from './slash-commands';

 
const ANSI_RE = /\x1b\[[0-9;]*m/;

// ── Tests ─────────────────────────────────────────────────────────────

describe('parseSlashCommand', () => {
  it('parses a simple command', () => {
    expect(parseSlashCommand('/help')).toEqual({ name: 'help', args: [] });
  });

  it('parses a command with args', () => {
    expect(parseSlashCommand('/usage week')).toEqual({ name: 'usage', args: ['week'] });
  });

  it('parses command with multiple args', () => {
    expect(parseSlashCommand('/memory search typescript config')).toEqual({
      name: 'memory',
      args: ['search', 'typescript', 'config'],
    });
  });

  it('normalises command name to lowercase', () => {
    expect(parseSlashCommand('/HELP')).toEqual({ name: 'help', args: [] });
  });

  it('trims whitespace', () => {
    expect(parseSlashCommand('  /status  ')).toEqual({ name: 'status', args: [] });
  });

  it('returns null for empty slash', () => {
    expect(parseSlashCommand('/ ')).toBeNull();
  });

  it('returns null for non-slash messages', () => {
    expect(parseSlashCommand('hello world')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });

  it('returns null for messages starting with / followed by space only', () => {
    expect(parseSlashCommand('/  ')).toBeNull();
  });
});

describe('handleSlashCommand', () => {
  it('returns handled:false for non-slash messages', async () => {
    const result = await handleSlashCommand('hello');
    expect(result.handled).toBe(false);
    expect(result.response).toBeUndefined();
  });

  it('returns handled:false for unknown commands', async () => {
    const result = await handleSlashCommand('/unknown');
    expect(result.handled).toBe(false);
  });

  it('returns an error response when a handler throws', async () => {
    // Force the /doctor handler to throw by making the mock reject.
    const { runAllChecks } = await import('./commands/doctor');
    vi.mocked(runAllChecks).mockRejectedValueOnce(new Error('disk on fire'));

    const result = await handleSlashCommand('/doctor');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Error');
    expect(result.response).toContain('/doctor');
    expect(result.response).toContain('disk on fire');
  });

  it('returns a timeout error when a handler hangs', async () => {
    // Simulate a handler that never resolves within the timeout.
    const { runAllChecks } = await import('./commands/doctor');
    vi.mocked(runAllChecks).mockImplementationOnce(
      () => new Promise(() => {}), // never settles
    );

    // Use fake timers to avoid waiting the full slash command timeout in CI.
    vi.useFakeTimers();
    const promise = handleSlashCommand('/doctor');
    // Advance past the 360s slash command timeout.
    await vi.advanceTimersByTimeAsync(370_000);
    const result = await promise;
    vi.useRealTimers();

    expect(result.handled).toBe(true);
    expect(result.response).toContain('timed out');
    expect(result.response).toContain('/doctor');
  });
});

describe('/help', () => {
  it('returns markdown with command table', async () => {
    const result = await handleSlashCommand('/help');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Slash Commands');
    expect(result.response).toContain('/usage');
    expect(result.response).toContain('/memory');
    expect(result.response).toContain('/config');
    expect(result.response).toContain('/doctor');
    expect(result.response).toContain('/log');
    expect(result.response).toContain('/recap');
    expect(result.response).toContain('/status');
    expect(result.response).toContain('/help');
    expect(result.response).not.toMatch(ANSI_RE);
  });
});

describe('/status', () => {
  it('returns daemon status in markdown', async () => {
    const result = await handleSlashCommand('/status');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Daemon Status');
    expect(result.response).toContain('**Status:** running');
    expect(result.response).toContain('**PID:** 1234');
    expect(result.response).toContain('**Plugin:** claude-code');
    expect(result.response).toContain('**Version:** 1.0.0');
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('reports not running when daemon is down', async () => {
    const { isPidAlive } = await import('./commands/lifecycle');
    vi.mocked(isPidAlive).mockReturnValueOnce(false);

    const result = await handleSlashCommand('/status');
    expect(result.response).toContain('not running');
  });
});

describe('/usage', () => {
  it('returns usage analytics in markdown', async () => {
    const result = await handleSlashCommand('/usage');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Usage');
    expect(result.response).toContain('**Dispatches:** 5');
    expect(result.response).toContain('**Success Rate:** 80.0%');
    expect(result.response).toContain('**Tool Calls:** 12');
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('passes window argument through', async () => {
    const { getTargetDatesAsync } = await import('./commands/usage');
    await handleSlashCommand('/usage week');
    expect(getTargetDatesAsync).toHaveBeenCalledWith('week');
  });

  it('handles empty dispatches', async () => {
    const { aggregate } = await import('./commands/usage');
    vi.mocked(aggregate).mockReturnValueOnce({
      totalDispatches: 0,
      totalDurationMs: 0,
      totalToolCalls: 0,
      successCount: 0,
      failCount: 0,
      byPlugin: {},
      toolLatency: {},
      topCommandsByTokens: [],
      toolFrequency: {},
      hourlyDispatches: Array(24).fill(0) as number[],
      dateRange: { from: '', to: '' },
      traceCount: 0,
    });

    const result = await handleSlashCommand('/usage');
    expect(result.response).toContain('No dispatches found');
  });
});

describe('/memory', () => {
  it('lists recent facts', async () => {
    const result = await handleSlashCommand('/memory');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Recent Facts');
    expect(result.response).toContain('Project uses TypeScript');
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('shows stats', async () => {
    const result = await handleSlashCommand('/memory stats');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Memory Stats');
    expect(result.response).toContain('**Total Memories:** 42');
    expect(result.response).toContain('fact');
  });

  it('handles search', async () => {
    const result = await handleSlashCommand('/memory search typescript');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Memory Search');
    expect(result.response).toContain('typescript');
  });

  it('search without query returns usage hint', async () => {
    const result = await handleSlashCommand('/memory search');
    expect(result.response).toContain('Usage:');
  });
});

describe('/config', () => {
  it('shows config overview', async () => {
    const result = await handleSlashCommand('/config');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Configuration');
    expect(result.response).toContain('**Plugin:** claude-code');
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('gets a specific key', async () => {
    const result = await handleSlashCommand('/config get activePlugin');
    expect(result.response).toContain('claude-code');
  });

  it('reports unset key', async () => {
    const result = await handleSlashCommand('/config get nonexistent');
    expect(result.response).toContain('not set');
  });
});

describe('/doctor', () => {
  it('returns health check results in markdown', async () => {
    const result = await handleSlashCommand('/doctor');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Doctor');
    expect(result.response).toContain('daemon');
    expect(result.response).toContain('config');
    expect(result.response).not.toMatch(ANSI_RE);
  });
});

describe('/log', () => {
  it('returns dispatch log in markdown', async () => {
    const result = await handleSlashCommand('/log');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Dispatch Log');
    expect(result.response).toContain('claude-code');
    expect(result.response).not.toMatch(ANSI_RE);
  });
});

describe('/recap', () => {
  it('returns daily recap in markdown', async () => {
    const result = await handleSlashCommand('/recap');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Recap');
    expect(result.response).toContain('**Dispatches:** 3');
    expect(result.response).toContain('**Success Rate:** 100%');
    expect(result.response).toContain('abc1234 fix bug');
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('handles empty recap', async () => {
    const { buildRecap } = await import('./commands/recap');
    vi.mocked(buildRecap).mockReturnValueOnce({
      date: '2026-02-25',
      dispatches: 0,
      successCount: 0,
      failCount: 0,
      totalDurationMs: 0,
      conversations: [],
      schedulerDispatches: 0,
      commits: [],
      filesChanged: [],
      uniqueFilesCount: 0,
      topTools: [],
      firstDispatch: null,
      lastDispatch: null,
      activeSpanMs: 0,
      peakHour: null,
      plugins: [],
    });

    const result = await handleSlashCommand('/recap');
    expect(result.response).toContain('No dispatches found');
  });

  it('returns weekly recap when --week flag is set', async () => {
    const { parseRecapArgs } = await import('./commands/recap');
    vi.mocked(parseRecapArgs).mockReturnValueOnce({ date: '2026-02-25', json: false, week: true });

    const result = await handleSlashCommand('/recap --week');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Recap');
    expect(result.response).toContain('week');
    expect(result.response).toContain('**Dispatches:** 18');
    expect(result.response).toContain('**Success Rate:** 94%');
    expect(result.response).toContain('**Busiest Day:** 2026-02-21');
    expect(result.response).toContain('**Quiet Days:** 1');
    expect(result.response).toContain('Daily Breakdown');
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('weekly recap shows top tools', async () => {
    const { parseRecapArgs } = await import('./commands/recap');
    vi.mocked(parseRecapArgs).mockReturnValueOnce({ date: '2026-02-25', json: false, week: true });

    const result = await handleSlashCommand('/recap --week');
    expect(result.response).toContain('### Top Tools');
    expect(result.response).toContain('**Read**: 22');
    expect(result.response).toContain('**Edit**: 11');
  });

  it('weekly recap returns graceful message on timeout', async () => {
    const { parseRecapArgs, buildWeeklyRecapAsync } = await import('./commands/recap');
    vi.mocked(parseRecapArgs).mockReturnValueOnce({ date: '2026-02-25', json: false, week: true });
    vi.mocked(buildWeeklyRecapAsync).mockRejectedValueOnce(new Error('timeout'));

    const result = await handleSlashCommand('/recap --week');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Could not load trace files');
  });

  it('weekly recap handles zero dispatches', async () => {
    const { parseRecapArgs, buildWeeklyRecapAsync } = await import('./commands/recap');
    vi.mocked(parseRecapArgs).mockReturnValueOnce({ date: '2026-02-25', json: false, week: true });
    vi.mocked(buildWeeklyRecapAsync).mockResolvedValueOnce({
      startDate: '2026-02-19',
      endDate: '2026-02-25',
      days: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-02-${19 + i}`,
        dispatches: 0,
        successCount: 0,
        failCount: 0,
        durationMs: 0,
        commits: 0,
      })),
      totals: { dispatches: 0, successCount: 0, failCount: 0, totalDurationMs: 0, commits: 0, uniqueFiles: 0, conversations: 0 },
      topTools: [],
      plugins: [],
      busiestDay: null,
      quietDays: 7,
    });

    const result = await handleSlashCommand('/recap --week');
    expect(result.response).toContain('No dispatches found for this week');
  });
});

describe('/standup', () => {
  it('returns standup data in markdown', async () => {
    const result = await handleSlashCommand('/standup');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Standup');
    expect(result.response).toContain('project');
    expect(result.response).toContain('`main`');
    expect(result.response).toContain('feat: add slash commands');
    expect(result.response).toContain('fix: router bug');
    expect(result.response).toContain('Uncommitted');
    expect(result.response).toContain('Open PRs');
    expect(result.response).toContain('Mia Dispatches');
    expect(result.response).toContain('4');
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('handles no activity', async () => {
    const { gatherRepoActivityAsync, loadDispatchSummaryAsync } = await import('./commands/standup');
    vi.mocked(gatherRepoActivityAsync).mockResolvedValueOnce({
      path: '/home/user/project',
      name: 'project',
      branch: 'main',
      commits: [],
      dirtyFiles: [],
      openPrs: [],
    });
    vi.mocked(loadDispatchSummaryAsync).mockResolvedValueOnce({
      total: 0,
      successful: 0,
      prompts: [],
    });

    const result = await handleSlashCommand('/standup');
    expect(result.response).toContain('No commits or dispatch activity');
  });
});

describe('/persona', () => {
  it('lists all personas with active marker', async () => {
    const result = await handleSlashCommand('/persona');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Personas');
    expect(result.response).toContain('**mia**');
    expect(result.response).toContain('**(active)**');
    expect(result.response).toContain('**architect**');
    expect(result.response).toContain('Default assistant');
    expect(result.response).toContain('Systems thinker');
    // custom persona should be marked as custom
    expect(result.response).toContain('_(custom)_');
    // hint for switching
    expect(result.response).toContain('/persona set');
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('/persona list is the same as /persona (default sub-command)', async () => {
    const defaultResult = await handleSlashCommand('/persona');
    const listResult   = await handleSlashCommand('/persona list');
    expect(listResult.response).toBe(defaultResult.response);
  });

  it('switches persona with /persona set <name>', async () => {
    const result = await handleSlashCommand('/persona set architect');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Persona');
    expect(result.response).toContain('Switched to');
    expect(result.response).toContain('**architect**');
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('accepts "use" and "switch" as aliases for set', async () => {
    const useResult    = await handleSlashCommand('/persona use architect');
    const switchResult = await handleSlashCommand('/persona switch architect');
    expect(useResult.response).toContain('Switched to');
    expect(switchResult.response).toContain('Switched to');
  });

  it('returns usage hint when /persona set is called without a name', async () => {
    const result = await handleSlashCommand('/persona set');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Usage:');
    expect(result.response).toContain('/persona set <name>');
  });

  it('surfaces error message when setActivePersona rejects', async () => {
    const { setActivePersona } = await import('../personas/index');
    vi.mocked(setActivePersona).mockRejectedValueOnce(new Error('Persona "ghost" not found'));

    const result = await handleSlashCommand('/persona set ghost');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Persona "ghost" not found');
  });

  it('shows persona content with /persona show', async () => {
    const result = await handleSlashCommand('/persona show mia');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Persona');
    expect(result.response).toContain('mia');
    expect(result.response).toContain('MIA Persona');
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('/persona view is an alias for show', async () => {
    const result = await handleSlashCommand('/persona view mia');
    expect(result.response).toContain('MIA Persona');
  });

  it('shows active persona content when /persona show is called without a name', async () => {
    // getActivePersona returns 'mia'; loadPersonaContent('mia') returns content
    const result = await handleSlashCommand('/persona show');
    expect(result.response).toContain('MIA Persona');
  });

  it('reports not-found when the named persona has no content', async () => {
    const { loadPersonaContent } = await import('../personas/index');
    vi.mocked(loadPersonaContent).mockResolvedValueOnce(null);

    const result = await handleSlashCommand('/persona show missing');
    expect(result.response).toContain('not found');
    expect(result.response).toContain('missing');
  });

  it('handles an empty personas directory', async () => {
    const { listPersonas } = await import('../personas/index');
    vi.mocked(listPersonas).mockResolvedValueOnce([]);

    const result = await handleSlashCommand('/persona');
    expect(result.response).toContain('No personas found');
    expect(result.response).toContain('~/.mia/personas/');
  });
});

describe('/update', () => {
  it('returns success result with updated version', async () => {
    const result = await handleSlashCommand('/update');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Update');
    expect(result.response).toContain('**2.1.0**');
    expect(result.response).toContain('deadbeef');
    expect(result.response).toContain('Daemon restarted');
    // All three steps should be shown as ok (✅)
    expect(result.response).toContain('✅');
    expect(result.response).toContain('fetch');
    expect(result.response).toContain('pull');
    expect(result.response).toContain('build');
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('reports already up-to-date', async () => {
    const { performUpdate } = await import('./commands/update');
    vi.mocked(performUpdate).mockResolvedValueOnce({
      success: true,
      upToDate: true,
      version: '2.0.1',
      commit: 'abc1234',
      daemonRestarted: false,
      steps: [
        { name: 'fetch', status: 'ok', detail: 'no new commits' },
      ],
      error: undefined,
    });

    const result = await handleSlashCommand('/update');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Already up-to-date');
    expect(result.response).toContain('**2.0.1**');
    expect(result.response).toContain('abc1234');
  });

  it('reports failure with error message', async () => {
    const { performUpdate } = await import('./commands/update');
    vi.mocked(performUpdate).mockResolvedValueOnce({
      success: false,
      upToDate: false,
      version: '',
      commit: '',
      daemonRestarted: false,
      steps: [
        { name: 'fetch',    status: 'ok',   detail: 'fetched origin' },
        { name: 'pull',     status: 'error', detail: 'merge conflict' },
        { name: 'rollback', status: 'ok',   detail: 'restored previous version' },
      ],
      error: 'merge conflict on package-lock.json',
    });

    const result = await handleSlashCommand('/update');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('**Update failed:**');
    expect(result.response).toContain('merge conflict on package-lock.json');
    // step with error status → ❌ icon
    expect(result.response).toContain('❌');
  });

  it('shows ⚠️ icon for skipped steps', async () => {
    const { performUpdate } = await import('./commands/update');
    vi.mocked(performUpdate).mockResolvedValueOnce({
      success: true,
      upToDate: false,
      version: '2.1.1',
      commit: 'cafe',
      daemonRestarted: false,
      steps: [
        { name: 'fetch', status: 'ok',   detail: 'ok' },
        { name: 'test',  status: 'skip', detail: 'no test suite' },
        { name: 'build', status: 'ok',   detail: 'built' },
      ],
      error: undefined,
    });

    const result = await handleSlashCommand('/update');
    expect(result.response).toContain('⚠️');
  });
});

// ── /mode ─────────────────────────────────────────────────────────────────────

describe('/mode', () => {
  it('shows current mode when called with no args', async () => {
    const result = await handleSlashCommand('/mode');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Mode');
    expect(result.response).toContain('**Active:** coding');
    expect(result.response).toContain('Full context');
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('shows general mode description when active mode is general', async () => {
    const { readMiaConfigAsync } = await import('../config/mia-config');
    vi.mocked(readMiaConfigAsync).mockResolvedValueOnce({
      activePlugin: 'claude-code',
      activeMode: 'general',
      maxConcurrency: 3,
      timeoutMs: 1_800_000,
      plugins: { 'claude-code': { model: 'claude-sonnet-4-5-20250929' } },
    } as never);

    const result = await handleSlashCommand('/mode');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('**Active:** general');
    expect(result.response).toContain('Lightweight');
  });

  it('switches from coding to general', async () => {
    const { writeMiaConfigAsync } = await import('../config/mia-config');
    const result = await handleSlashCommand('/mode general');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Switched to **general**');
    expect(result.response).toContain('Lightweight mode');
    expect(vi.mocked(writeMiaConfigAsync)).toHaveBeenCalledWith({ activeMode: 'general' });
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('switches from general to coding', async () => {
    const { readMiaConfigAsync, writeMiaConfigAsync } = await import('../config/mia-config');
    vi.mocked(readMiaConfigAsync).mockResolvedValueOnce({
      activePlugin: 'claude-code',
      activeMode: 'general',
      maxConcurrency: 3,
      timeoutMs: 1_800_000,
      plugins: { 'claude-code': { model: 'claude-sonnet-4-5-20250929' } },
    } as never);

    const result = await handleSlashCommand('/mode coding');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Switched to **coding**');
    expect(result.response).toContain('Full context active');
    expect(vi.mocked(writeMiaConfigAsync)).toHaveBeenCalledWith({ activeMode: 'coding' });
  });

  it('reports already in mode when target equals current', async () => {
    const { writeMiaConfigAsync } = await import('../config/mia-config');
    vi.mocked(writeMiaConfigAsync as ReturnType<typeof vi.fn>).mockClear();

    const result = await handleSlashCommand('/mode coding');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Already in **coding** mode');
    // writeMiaConfigAsync should NOT be called when mode hasn't changed
    expect(vi.mocked(writeMiaConfigAsync)).not.toHaveBeenCalled();
  });

  it('rejects unknown mode argument', async () => {
    const result = await handleSlashCommand('/mode turbo');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Unknown mode');
    expect(result.response).toContain('`turbo`');
    expect(result.response).toContain('coding');
    expect(result.response).toContain('general');
  });

  it('normalises mode argument to lowercase', async () => {
    const result = await handleSlashCommand('/mode GENERAL');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('general');
  });
});

// ── /changelog ────────────────────────────────────────────────────────────────

describe('/changelog', () => {
  it('returns changelog with commit groups', async () => {
    const result = await handleSlashCommand('/changelog');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Changelog');
    expect(result.response).toContain('v1.0.0..HEAD');
    expect(result.response).toContain('**3 commits**');
    expect(result.response).toContain('### Added');
    expect(result.response).toContain('### Fixed');
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('strips conventional-commit prefix from items', async () => {
    const result = await handleSlashCommand('/changelog');
    expect(result.handled).toBe(true);
    // "feat(auth): add OAuth login" → "add OAuth login"
    expect(result.response).toContain('add OAuth login');
    // "fix(router): handle null sessions" → "handle null sessions"
    expect(result.response).toContain('handle null sessions');
  });

  it('shows initial..HEAD when no tag exists', async () => {
    const { getLastTagAsync, getCommitsBetweenAsync } = await import('./commands/changelog');
    vi.mocked(getLastTagAsync).mockResolvedValueOnce(null);
    vi.mocked(getCommitsBetweenAsync).mockResolvedValueOnce(MOCK_COMMITS);

    const result = await handleSlashCommand('/changelog');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('initial..HEAD');
  });

  it('respects --from flag and uses it as range start', async () => {
    const { getCommitsBetweenAsync } = await import('./commands/changelog');
    vi.mocked(getCommitsBetweenAsync).mockResolvedValueOnce(MOCK_COMMITS);

    const result = await handleSlashCommand('/changelog --from v0.9.0');
    expect(result.handled).toBe(true);
    // getLastTagAsync should NOT be called when --from is explicit
    expect(result.response).toContain('## Changelog');
  });

  it('returns empty message when no commits found', async () => {
    const { getCommitsBetweenAsync } = await import('./commands/changelog');
    vi.mocked(getCommitsBetweenAsync).mockResolvedValueOnce([]);

    const result = await handleSlashCommand('/changelog');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('No commits found');
  });

  it('includes footer hint about CLI command', async () => {
    const result = await handleSlashCommand('/changelog');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('mia changelog');
  });
});

describe('/suggestions', () => {
  it('lists active suggestions with names and descriptions', async () => {
    const result = await handleSlashCommand('/suggestions');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('## Suggestions');
    expect(result.response).toContain('Add request retry logic');
    expect(result.response).toContain('Add integration tests for auth');
    expect(result.response).toContain('Wrap outgoing HTTP calls in exponential backoff');
  });

  it('shows suggestion count in the header', async () => {
    const result = await handleSlashCommand('/suggestions');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('**2** suggestion(s)');
  });

  it('shows history count and clear hint when dismissed/completed items exist', async () => {
    const result = await handleSlashCommand('/suggestions');
    expect(result.handled).toBe(true);
    // 1 dismissed + 0 completed = 1 history entry
    expect(result.response).toContain('1 suggestion(s) in history');
    expect(result.response).toContain('/suggestions clear');
  });

  it('shows refresh hint when no history exists', async () => {
    mockSuggestionsService.getFullStore.mockReturnValueOnce({
      active: [{ id: 'sug_001', name: 'Foo', description: 'Bar', createdAt: Date.now() }],
      dismissed: [],
      completed: [],
    });
    mockSuggestionsService.getActive.mockReturnValueOnce([
      { id: 'sug_001', name: 'Foo', description: 'Bar', createdAt: Date.now() },
    ]);
    const result = await handleSlashCommand('/suggestions');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('/suggestions refresh');
  });

  it('returns empty state message when no active suggestions', async () => {
    mockSuggestionsService.getActive.mockReturnValueOnce([]);
    mockSuggestionsService.isGenerating.mockReturnValueOnce(false);
    const result = await handleSlashCommand('/suggestions');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('No active suggestions');
    expect(result.response).toContain('/suggestions refresh');
  });

  it('shows generating message when generation is in progress and active list is empty', async () => {
    mockSuggestionsService.getActive.mockReturnValueOnce([]);
    mockSuggestionsService.isGenerating.mockReturnValueOnce(true);
    const result = await handleSlashCommand('/suggestions');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Generating');
  });

  it('/suggestions refresh queues generation and returns immediately', async () => {
    const result = await handleSlashCommand('/suggestions refresh');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Generation queued');
    expect(mockSuggestionsService.generate).toHaveBeenCalled();
  });

  it('/suggestions refresh accepts "regenerate" alias', async () => {
    const result = await handleSlashCommand('/suggestions regenerate');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Generation queued');
  });

  it('/suggestions refresh accepts "regen" alias', async () => {
    const result = await handleSlashCommand('/suggestions regen');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Generation queued');
  });

  it('/suggestions refresh reports when already generating', async () => {
    mockSuggestionsService.isGenerating.mockReturnValueOnce(true);
    const result = await handleSlashCommand('/suggestions refresh');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('already in progress');
    expect(mockSuggestionsService.generate).not.toHaveBeenCalledTimes(2);
  });

  it('/suggestions clear wipes history and shows remaining count', async () => {
    const result = await handleSlashCommand('/suggestions clear');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('History cleared');
    expect(result.response).toContain('1'); // remaining active count from mock
    expect(mockSuggestionsService.clearHistory).toHaveBeenCalled();
  });

  it('/suggestions clear accepts "reset" alias', async () => {
    const result = await handleSlashCommand('/suggestions reset');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('History cleared');
  });

  it('produces no ANSI escape codes', async () => {
    const result = await handleSlashCommand('/suggestions');
    expect(result.handled).toBe(true);
    expect(result.response).not.toMatch(ANSI_RE);
  });

  it('/help includes /suggestions entry', async () => {
    const result = await handleSlashCommand('/help');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('/suggestions');
  });
});

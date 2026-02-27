/**
 * Tests for slash-commands.ts
 *
 * Covers: parseSlashCommand, handleSlashCommand dispatch for each command,
 * and verifies markdown output (no ANSI codes).
 */

import { describe, it, expect, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────

// Mock daemon/pid for /status
vi.mock('./pid', () => ({
  readPidFile: vi.fn(() => 1234),
  readStatusFile: vi.fn(() => ({
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
  readMiaConfig: vi.fn(() => ({
    activePlugin: 'claude-code',
    maxConcurrency: 3,
    timeoutMs: 1_800_000,
    plugins: {
      'claude-code': { model: 'claude-sonnet-4-5-20250929' },
    },
  })),
}));

// Mock usage command data functions
vi.mock('./commands/usage', () => ({
  getTargetDates: vi.fn(() => ['2026-02-25']),
  loadTraces: vi.fn(() => []),
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
vi.mock('./commands/log', () => ({
  loadAllTraces: vi.fn(() => [
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
  ]),
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
  parseRecapArgs: vi.fn(() => ({ date: '2026-02-25', json: false })),
  loadTracesForDate: vi.fn(() => []),
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
  gatherRepoActivity: vi.fn(() => ({
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
  loadDispatchSummary: vi.fn(() => ({
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
    const { getTargetDates } = await import('./commands/usage');
    await handleSlashCommand('/usage week');
    expect(getTargetDates).toHaveBeenCalledWith('week');
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
    const { gatherRepoActivity, loadDispatchSummary } = await import('./commands/standup');
    vi.mocked(gatherRepoActivity).mockReturnValueOnce({
      path: '/home/user/project',
      name: 'project',
      branch: 'main',
      commits: [],
      dirtyFiles: [],
      openPrs: [],
    });
    vi.mocked(loadDispatchSummary).mockReturnValueOnce({
      total: 0,
      successful: 0,
      prompts: [],
    });

    const result = await handleSlashCommand('/standup');
    expect(result.response).toContain('No commits or dispatch activity');
  });
});

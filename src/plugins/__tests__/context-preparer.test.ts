/**
 * Tests for plugins/context-preparer — ContextPreparer class
 *
 * Covers:
 *   - prepare()                    coding vs general mode routing
 *   - _gatherMemoryFacts()         memory store happy path, error, missing store
 *   - _gatherGitContext()          git repo, non-repo, error fallback
 *   - _gatherWorkspaceSnapshot()   happy path, partial snapshot, error fallback
 *   - _loadProjectInstructions()   candidate file precedence, none found
 *   - _gatherConversationSummary() messages, default conv, empty, error
 *   - _loadPersonalityContext()    PERSONALITY.md, USER.md, both, neither
 *   - _applyBudget()               no-op, workspace, memory, summary, git,
 *                                   codebase, and project-instructions truncation
 *   - classifyPrompt()             general and coding classifications
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

// ── Hoist path constants so they're available inside vi.mock() factories ──────
const { TEST_ROOT, TEST_MIA_HOME, TEST_CWD } = vi.hoisted(() => {
  const p = require('path') as typeof import('path');
  const os = require('os') as typeof import('os');
  const root = p.join(os.tmpdir(), `mia-ctx-preparer-test-${process.pid}`);
  return {
    TEST_ROOT: root,
    TEST_MIA_HOME: p.join(root, '.mia'),
    TEST_CWD: p.join(root, 'project'),
  };
});

// ── Module mocks — hoisted before any imports from the mocked modules ─────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    access: vi.fn(actual.access),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(() => TEST_ROOT),
  };
});

vi.mock('../../context/workspace-scanner', () => ({
  scanGitState: vi.fn(() => ({ isRepo: false })),
  scanGitStateAsync: vi.fn(async () => ({ isRepo: false })),
  scanWorkspace: vi.fn(() => ({
    cwd: TEST_CWD,
    projectType: 'npm',
    entryPoints: ['index.js'],
    files: { totalFiles: 42, recentlyModified: ['src/app.ts', 'src/index.ts'] },
  })),
  scanWorkspaceAsync: vi.fn(async () => ({
    cwd: TEST_CWD,
    projectType: 'npm',
    entryPoints: ['index.js'],
    files: { totalFiles: 42, recentlyModified: ['src/app.ts', 'src/index.ts'] },
  })),
}));

vi.mock('../../p2p/message-store', () => ({
  getRecentMessages: vi.fn(async () => []),
}));

// Mock the conversation summarizer so tests never hit the real Anthropic API.
const mockSummarizeMessages = vi.fn(async () => null as string | null);
vi.mock('../../utils/conversation-summarizer', () => ({
  summarizeMessages: (...args: unknown[]) => mockSummarizeMessages(...args),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { ContextPreparer, classifyPrompt, getBudgetTier } from '../context-preparer';
import { scanGitStateAsync, scanWorkspaceAsync } from '../../context/workspace-scanner';

// Aliases for backward compatibility in test assertions
const scanGitState = scanGitStateAsync;
const scanWorkspace = scanWorkspaceAsync;
import { getRecentMessages } from '../../p2p/message-store';
import { existsSync as mockExistsSync, readFileSync as mockReadFileSync } from 'fs';
import { readFile as mockReadFile, access as mockAccess } from 'fs/promises';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMemoryStore(results: Array<{ content: string; metadata?: Record<string, unknown> }> = []) {
  return {
    search: vi.fn(async () => results),
  };
}

/** Build a PluginContext-shaped char budget string of a given length. */
function padTo(n: number): string {
  return 'x'.repeat(n);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(TEST_MIA_HOME, { recursive: true });
  mkdirSync(TEST_CWD, { recursive: true });
  vi.clearAllMocks();

  // Restore existsSync / readFileSync to real implementations by default —
  // individual tests that need to fake filesystem state will re-mock.
  const fs = require('fs') as typeof import('fs');
  (mockExistsSync as Mock).mockImplementation(fs.existsSync.bind(fs));
  (mockReadFileSync as Mock).mockImplementation(fs.readFileSync.bind(fs));

  // Restore fs/promises mocks to real implementations.
  const fsp = require('fs/promises') as typeof import('fs/promises');
  (mockReadFile as Mock).mockImplementation(fsp.readFile.bind(fsp));
  (mockAccess as Mock).mockImplementation(fsp.access.bind(fsp));
});

afterEach(() => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyPrompt (re-export from context-preparer)
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyPrompt', () => {
  it('classifies short greetings as general', () => {
    expect(classifyPrompt('hey')).toBe('general');
    expect(classifyPrompt('how are you?')).toBe('general');
    expect(classifyPrompt('thanks!')).toBe('general');
  });

  it('classifies technical prompts as coding', () => {
    expect(classifyPrompt('fix the bug in the auth module')).toBe('coding');
    expect(classifyPrompt('run npm install')).toBe('coding');
    expect(classifyPrompt('refactor the database schema')).toBe('coding');
  });

  it('classifies any prompt > 300 chars as coding', () => {
    expect(classifyPrompt('a'.repeat(301))).toBe('coding');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mode routing — general vs coding
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextPreparer.prepare() — mode routing', () => {
  it('general mode: includes memory but skips git, workspace, codebase context', async () => {
    const store = makeMemoryStore([{ content: 'fact about user' }]);
    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      memoryStore: store,
      codebaseContextStr: 'big codebase context string',
    });

    const ctx = await cp.prepare('hey how are you', 'conv-1');

    expect(store.search).toHaveBeenCalledWith('hey how are you', 5);
    expect(scanGitState).not.toHaveBeenCalled();
    expect(scanWorkspace).not.toHaveBeenCalled();
    expect(ctx.memoryFacts).toEqual(['- fact about user']);
    expect(ctx.gitContext).toBe('');
    expect(ctx.workspaceSnapshot).toBe('');
    expect(ctx.codebaseContext).toBe('');
    expect(ctx.projectInstructions).toBe('');  // no instruction files in TEST_CWD
  });

  it('coding mode: includes memory, git, workspace, and codebase context', async () => {
    const store = makeMemoryStore([{ content: 'prefers TypeScript', metadata: { fact: 'prefers TypeScript' } }]);
    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      memoryStore: store,
      codebaseContextStr: 'TypeScript monorepo',
    });

    // Mock git returning a real repo
    (scanGitState as Mock).mockReturnValueOnce({
      isRepo: true,
      branch: 'main',
      recentCommits: ['abc123 initial commit'],
      uncommittedChanges: [],
    });

    const ctx = await cp.prepare('fix the authentication bug', 'conv-1');

    expect(store.search).toHaveBeenCalledWith('fix the authentication bug', 10);
    expect(scanGitState).toHaveBeenCalledWith(TEST_CWD);
    expect(scanWorkspace).toHaveBeenCalledWith(TEST_CWD);
    expect(ctx.memoryFacts).toContain('- prefers TypeScript');
    expect(ctx.gitContext).toContain('Branch: main');
    expect(ctx.workspaceSnapshot).toContain('Total files: 42');
    expect(ctx.codebaseContext).toBe('TypeScript monorepo');
  });

  it('defaults workingDirectory to process.cwd() when not set', async () => {
    const cp = new ContextPreparer({ codebaseContextStr: '' });
    await cp.prepare('fix the bug', 'conv-1');
    expect(scanGitState).toHaveBeenCalledWith(process.cwd());
    expect(scanWorkspace).toHaveBeenCalledWith(process.cwd());
  });

  it('defaults maxContextChars to 40_000 and returns within budget', async () => {
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('refactor the api', 'conv-1');
    const total =
      ctx.memoryFacts.join('\n').length +
      ctx.codebaseContext.length +
      ctx.gitContext.length +
      ctx.workspaceSnapshot.length +
      ctx.projectInstructions.length +
      (ctx.conversationSummary?.length ?? 0);
    expect(total).toBeLessThanOrEqual(40_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory facts
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextPreparer — memory facts', () => {
  it('returns empty array when no memoryStore is provided', async () => {
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('add a new api endpoint', 'conv-1');
    expect(ctx.memoryFacts).toEqual([]);
  });

  it('uses metadata.fact when present', async () => {
    const store = makeMemoryStore([
      { content: 'raw content', metadata: { fact: 'prefers dark mode' } },
    ]);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, memoryStore: store });
    const ctx = await cp.prepare('update the styles', 'conv-1');
    expect(ctx.memoryFacts).toContain('- prefers dark mode');
  });

  it('falls back to content when metadata.fact is absent', async () => {
    const store = makeMemoryStore([
      { content: 'uses vim keybindings' },
    ]);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, memoryStore: store });
    const ctx = await cp.prepare('add keybinding config', 'conv-1');
    expect(ctx.memoryFacts).toContain('- uses vim keybindings');
  });

  it('returns empty array when memoryStore.search throws', async () => {
    const store = { search: vi.fn(async () => { throw new Error('memory store unavailable'); }) };
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, memoryStore: store });
    const ctx = await cp.prepare('run the tests', 'conv-1');
    expect(ctx.memoryFacts).toEqual([]);
  });

  it('calls search with query and limit', async () => {
    const store = makeMemoryStore([]);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, memoryStore: store });
    await cp.prepare('fix the endpoint', 'conv-1');
    expect(store.search).toHaveBeenCalledWith(expect.any(String), 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Git context
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextPreparer — git context', () => {
  it('returns "Not a git repository" when isRepo is false', async () => {
    (scanGitState as Mock).mockReturnValueOnce({ isRepo: false });
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('fix the bug', 'conv-1');
    expect(ctx.gitContext).toBe('Not a git repository.');
  });

  it('includes branch name when repo', async () => {
    (scanGitState as Mock).mockReturnValueOnce({
      isRepo: true,
      branch: 'feat/new-feature',
      recentCommits: [],
      uncommittedChanges: [],
    });
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('add a feature', 'conv-1');
    expect(ctx.gitContext).toContain('Branch: feat/new-feature');
  });

  it('shows dirty files when uncommitted changes exist', async () => {
    (scanGitState as Mock).mockReturnValueOnce({
      isRepo: true,
      branch: 'main',
      uncommittedChanges: ['src/auth.ts', 'src/router.ts'],
      recentCommits: [],
    });
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('commit my changes', 'conv-1');
    expect(ctx.gitContext).toContain('Dirty files: src/auth.ts, src/router.ts');
  });

  it('shows "Status: clean" when no uncommitted changes', async () => {
    (scanGitState as Mock).mockReturnValueOnce({
      isRepo: true,
      branch: 'main',
      uncommittedChanges: [],
      recentCommits: [],
    });
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('git log', 'conv-1');
    expect(ctx.gitContext).toContain('Status: clean');
  });

  it('includes recent commits when present', async () => {
    (scanGitState as Mock).mockReturnValueOnce({
      isRepo: true,
      branch: 'main',
      uncommittedChanges: [],
      recentCommits: ['abc123 initial commit', 'def456 add feature'],
    });
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('show git log', 'conv-1');
    expect(ctx.gitContext).toContain('Recent commits:');
    expect(ctx.gitContext).toContain('abc123 initial commit');
  });

  it('caps recent commits at 5', async () => {
    (scanGitState as Mock).mockReturnValueOnce({
      isRepo: true,
      branch: 'main',
      uncommittedChanges: [],
      recentCommits: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'],
    });
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('git history', 'conv-1');
    // c6 and c7 should not appear
    expect(ctx.gitContext).not.toContain('c6');
    expect(ctx.gitContext).not.toContain('c7');
  });

  it('returns "Git context unavailable" when scanGitState throws', async () => {
    (scanGitState as Mock).mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('git status', 'conv-1');
    expect(ctx.gitContext).toBe('Git context unavailable.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Workspace snapshot
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextPreparer — workspace snapshot', () => {
  it('includes cwd, project type, entry points, and total files', async () => {
    (scanWorkspace as Mock).mockReturnValueOnce({
      cwd: '/my/project',
      projectType: 'rust',
      entryPoints: ['src/main.rs'],
      files: { totalFiles: 7, recentlyModified: [] },
    });
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('build the project', 'conv-1');
    expect(ctx.workspaceSnapshot).toContain('Working Directory: /my/project');
    expect(ctx.workspaceSnapshot).toContain('Project: rust');
    expect(ctx.workspaceSnapshot).toContain('Entry points: src/main.rs');
    expect(ctx.workspaceSnapshot).toContain('Total files: 7');
  });

  it('includes recently modified files', async () => {
    (scanWorkspace as Mock).mockReturnValueOnce({
      cwd: '/my/project',
      projectType: 'npm',
      entryPoints: [],
      files: {
        totalFiles: 10,
        recentlyModified: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      },
    });
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('which files did i touch', 'conv-1');
    expect(ctx.workspaceSnapshot).toContain('Recently touched: src/a.ts, src/b.ts, src/c.ts');
  });

  it('caps recently modified at 8 entries', async () => {
    (scanWorkspace as Mock).mockReturnValueOnce({
      cwd: '/my/project',
      projectType: 'npm',
      entryPoints: [],
      files: {
        totalFiles: 100,
        recentlyModified: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9'],
      },
    });
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('run tests', 'conv-1');
    expect(ctx.workspaceSnapshot).not.toContain('f9');
  });

  it('returns "Workspace snapshot unavailable" when scanWorkspace throws', async () => {
    (scanWorkspace as Mock).mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    // Use a coding prompt so workspace scanning is actually invoked
    const ctx = await cp.prepare('run the build and check workspace files', 'conv-1');
    expect(ctx.workspaceSnapshot).toBe('Workspace snapshot unavailable.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Project instructions
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextPreparer — project instructions', () => {
  it('returns empty string when no instruction files exist', async () => {
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('add an endpoint', 'conv-1');
    expect(ctx.projectInstructions).toBe('');
  });

  it('reads CLAUDE.md when present', async () => {
    writeFileSync(join(TEST_CWD, 'CLAUDE.md'), '# Claude Instructions\nBe concise.');
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('refactor the schema', 'conv-1');
    expect(ctx.projectInstructions).toContain('Be concise.');
  });

  it('reads AGENTS.md when present', async () => {
    writeFileSync(join(TEST_CWD, 'AGENTS.md'), '# Agent Rules\nNo force push.');
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('run the build', 'conv-1');
    expect(ctx.projectInstructions).toContain('No force push.');
  });

  it('prefers .claude-code-instructions over CLAUDE.md', async () => {
    writeFileSync(join(TEST_CWD, '.claude-code-instructions'), 'PRIORITY FILE');
    writeFileSync(join(TEST_CWD, 'CLAUDE.md'), 'LOWER PRIORITY');
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('update the api', 'conv-1');
    expect(ctx.projectInstructions).toContain('PRIORITY FILE');
    expect(ctx.projectInstructions).not.toContain('LOWER PRIORITY');
  });

  it('falls through candidates and picks first existing one', async () => {
    // Only AGENTS.md exists (last candidate)
    writeFileSync(join(TEST_CWD, 'AGENTS.md'), 'AGENTS content');
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('implement the feature', 'conv-1');
    expect(ctx.projectInstructions).toContain('AGENTS content');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation summary
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextPreparer — conversation summary', () => {
  it('returns undefined for "default" conversationId', async () => {
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('add a test', 'default');
    expect(ctx.conversationSummary).toBeUndefined();
  });

  it('returns undefined for empty conversationId', async () => {
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('add a test', '');
    expect(ctx.conversationSummary).toBeUndefined();
  });

  it('returns undefined when no messages found', async () => {
    (getRecentMessages as Mock).mockResolvedValueOnce([]);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('implement oauth', 'conv-42');
    expect(ctx.conversationSummary).toBeUndefined();
  });

  it('formats user and assistant messages into a readable summary', async () => {
    (getRecentMessages as Mock).mockResolvedValueOnce([
      { type: 'user', content: 'Fix the login bug' },
      { type: 'response', content: 'I found the issue in auth.ts line 42' },
    ]);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('continue fixing the bug', 'conv-42');
    expect(ctx.conversationSummary).toContain('User: Fix the login bug');
    expect(ctx.conversationSummary).toContain('Assistant: I found the issue');
  });

  it('filters out system messages but keeps tool_call and tool_result as compact summary', async () => {
    (getRecentMessages as Mock).mockResolvedValueOnce([
      { type: 'system', content: 'Internal system message' },
      { type: 'user', content: 'Hello', timestamp: 1_700_000_000_000 },
      { type: 'tool_call', content: 'Read', metadata: JSON.stringify({ toolName: 'Read', filePath: 'src/auth.ts' }), timestamp: 1_700_000_001_000 },
      { type: 'tool_result', content: 'Read', metadata: JSON.stringify({ toolName: 'Read', status: 'completed', duration: 150 }), timestamp: 1_700_000_002_000 },
      { type: 'assistant', content: 'Hi there', timestamp: 1_700_000_003_000 },
    ]);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('continue', 'conv-42');
    expect(ctx.conversationSummary).toContain('User: Hello');
    expect(ctx.conversationSummary).toContain('Assistant: Hi there');
    expect(ctx.conversationSummary).not.toContain('Internal system message');
    // Tool messages shown individually with content
    expect(ctx.conversationSummary).toContain('[Tool] Read');
    expect(ctx.conversationSummary).toContain('[Result] Read');
  });

  it('formats tool_call messages as compact summary with tool names', async () => {
    (getRecentMessages as Mock).mockResolvedValueOnce([
      { type: 'user', content: 'Run tests', timestamp: 1_700_000_000_000 },
      { type: 'tool_call', content: 'Bash', metadata: JSON.stringify({ toolName: 'Bash', command: 'npm test' }), timestamp: 1_700_000_001_000 },
      { type: 'tool_result', content: 'Bash', metadata: JSON.stringify({ toolName: 'Bash', status: 'completed', duration: 5000 }), timestamp: 1_700_000_002_000 },
    ]);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('continue', 'conv-42');
    expect(ctx.conversationSummary).toContain('[Tool] Bash');
    expect(ctx.conversationSummary).toContain('[Result] Bash');
    expect(ctx.conversationSummary).toContain('User: Run tests');
  });

  it('handles tool messages with missing metadata gracefully', async () => {
    (getRecentMessages as Mock).mockResolvedValueOnce([
      { type: 'user', content: 'Do something', timestamp: 1_700_000_000_000 },
      { type: 'tool_call', content: 'Read', timestamp: 1_700_000_001_000 },
      { type: 'tool_result', content: 'Read', timestamp: 1_700_000_002_000 },
    ]);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('continue', 'conv-42');
    // Tool activity is still captured even without metadata
    expect(ctx.conversationSummary).toContain('[Tool] Read');
    expect(ctx.conversationSummary).toContain('[Result] Read');
  });

  it('does not inflate turnCount with tool messages for adaptive budget tiers', async () => {
    // 2 user/assistant + 28 tool messages = should stay in 'early' tier (2 turns, not 30)
    const msgs = [
      { type: 'user', content: 'Refactor auth', timestamp: 1_700_000_000_000 },
      { type: 'assistant', content: 'On it', timestamp: 1_700_000_001_000 },
      ...Array.from({ length: 28 }, (_, i) => ({
        type: i % 2 === 0 ? 'tool_call' : 'tool_result',
        content: 'Read',
        metadata: JSON.stringify({ toolName: 'Read', status: 'completed' }),
        timestamp: 1_700_000_002_000 + i * 1000,
      })),
    ];
    (getRecentMessages as Mock).mockResolvedValueOnce(msgs);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('continue', 'conv-42');
    // Should have context despite all the tool messages
    expect(ctx.conversationSummary).toBeDefined();
    // Tool activity shown individually with content
    expect(ctx.conversationSummary).toContain('[Tool] Read');
    expect(ctx.conversationSummary).toContain('[Result] Read');
    // Actual conversational messages must be present
    expect(ctx.conversationSummary).toContain('User: Refactor auth');
    expect(ctx.conversationSummary).toContain('Assistant: On it');
  });

  it('truncates long message content to MESSAGE_PREVIEW_LENGTH with ellipsis', async () => {
    const longMessage = 'A'.repeat(600);
    (getRecentMessages as Mock).mockResolvedValueOnce([
      { type: 'user', content: longMessage },
    ]);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('continue', 'conv-42');
    expect(ctx.conversationSummary).toContain('...');
    // Should truncate to MESSAGE_PREVIEW_LENGTH (500)
    const userLine = ctx.conversationSummary!.split('\n').find(l => l.startsWith('User:'))!;
    expect(userLine.length).toBeLessThan(550); // not the full 600
  });

  it('returns undefined when getRecentMessages throws', async () => {
    (getRecentMessages as Mock).mockRejectedValueOnce(new Error('DB error'));
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('continue my work', 'conv-42');
    expect(ctx.conversationSummary).toBeUndefined();
  });

  it('respects custom conversationHistoryLimit', async () => {
    (getRecentMessages as Mock).mockResolvedValueOnce([]);
    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      conversationHistoryLimit: 3,
    });
    await cp.prepare('continue', 'conv-42');
    expect(getRecentMessages).toHaveBeenCalledWith('conv-42', 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Personality context
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextPreparer — personality context', () => {
  it('returns empty string when neither PERSONALITY.md nor USER.md exist', async () => {
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('add a feature', 'conv-1');
    // projectInstructions includes personality — should be empty when no files exist
    expect(ctx.projectInstructions).toBe('');
  });

  it('includes PERSONALITY.md content in projectInstructions', async () => {
    writeFileSync(join(TEST_MIA_HOME, 'PERSONALITY.md'), 'Be sharp and direct.');
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('refactor this', 'conv-1');
    expect(ctx.projectInstructions).toContain('## Personality');
    expect(ctx.projectInstructions).toContain('Be sharp and direct.');
  });

  it('includes USER.md content in projectInstructions', async () => {
    writeFileSync(join(TEST_MIA_HOME, 'USER.md'), 'Name: The user\nTimezone: UTC');
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('implement auth', 'conv-1');
    expect(ctx.projectInstructions).toContain('## User Profile');
    expect(ctx.projectInstructions).toContain('Name: The user');
  });

  it('combines both PERSONALITY.md and USER.md', async () => {
    writeFileSync(join(TEST_MIA_HOME, 'PERSONALITY.md'), 'Be concise.');
    writeFileSync(join(TEST_MIA_HOME, 'USER.md'), 'Prefers TypeScript.');
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('update the schema', 'conv-1');
    expect(ctx.projectInstructions).toContain('## Personality');
    expect(ctx.projectInstructions).toContain('## User Profile');
  });

  it('prepends personality before project instruction file content', async () => {
    writeFileSync(join(TEST_MIA_HOME, 'PERSONALITY.md'), 'Personality here.');
    writeFileSync(join(TEST_CWD, 'CLAUDE.md'), 'Project rules here.');
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    const ctx = await cp.prepare('add tests', 'conv-1');
    const personalityIndex = ctx.projectInstructions.indexOf('Personality here.');
    const projectIndex = ctx.projectInstructions.indexOf('Project rules here.');
    expect(personalityIndex).toBeLessThan(projectIndex);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Budget application (_applyBudget)
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextPreparer — budget application', () => {
  /** Returns total character count of a PluginContext */
  function totalLen(ctx: Awaited<ReturnType<ContextPreparer['prepare']>>): number {
    return (
      ctx.memoryFacts.join('\n').length +
      ctx.codebaseContext.length +
      ctx.gitContext.length +
      ctx.workspaceSnapshot.length +
      ctx.projectInstructions.length +
      (ctx.conversationSummary?.length ?? 0)
    );
  }

  it('does not truncate anything when total is within budget', async () => {
    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 100_000,
      codebaseContextStr: 'short codebase',
    });
    (scanGitState as Mock).mockReturnValueOnce({ isRepo: true, branch: 'main', recentCommits: [], uncommittedChanges: [] });
    (scanWorkspace as Mock).mockReturnValueOnce({
      cwd: TEST_CWD,
      projectType: 'npm',
      entryPoints: ['index.js'],
      files: { totalFiles: 5, recentlyModified: [] },
    });

    const ctx = await cp.prepare('fix the bug', 'conv-1');
    expect(ctx.codebaseContext).toBe('short codebase');
    expect(ctx.gitContext).toContain('Branch: main');
    // workspace not truncated — no ...[truncated]
    expect(ctx.workspaceSnapshot).not.toContain('[truncated]');
  });

  it('truncates workspace snapshot first when over budget', async () => {
    // workspaceSnapshot > 1000 chars, everything huge
    const bigWorkspace = padTo(1500);
    (scanWorkspace as Mock).mockReturnValue({
      cwd: bigWorkspace,  // makes the snapshot very large
      projectType: 'npm',
      entryPoints: [],
      files: { totalFiles: 100, recentlyModified: [] },
    });
    (scanGitState as Mock).mockReturnValue({ isRepo: false });

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 500,  // tiny budget forces truncation
      codebaseContextStr: '',
    });

    const ctx = await cp.prepare('run the build', 'conv-1');
    // workspace should be truncated
    expect(ctx.workspaceSnapshot).toContain('[truncated]');
    expect(ctx.workspaceSnapshot.length).toBeLessThanOrEqual(1000 + '[truncated]'.length + 20);
  });

  it('truncates memory facts to half when still over budget after workspace trim', async () => {
    const store = makeMemoryStore(
      Array.from({ length: 20 }, (_, i) => ({
        content: `fact-${i}: ${'x'.repeat(50)}`,
      }))
    );
    (scanGitState as Mock).mockReturnValue({ isRepo: false });
    (scanWorkspace as Mock).mockReturnValue({
      cwd: TEST_CWD,
      projectType: 'npm',
      entryPoints: [],
      files: { totalFiles: 1, recentlyModified: [] },
    });

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 300,  // extremely small budget
      memoryStore: store,
      codebaseContextStr: '',
    });

    const ctx = await cp.prepare('add a test', 'conv-1');
    // Should have fewer than 20 facts
    expect(ctx.memoryFacts.length).toBeLessThan(20);
  });

  it('truncates conversation summary when still over budget', async () => {
    // 6 messages of 100 chars each → each preview ≤ 100 chars → total summary > 500 chars
    // which is SUMMARY_PREVIEW_LENGTH, making it eligible for budget truncation
    const msgContent = 'A'.repeat(100);
    (getRecentMessages as Mock).mockResolvedValueOnce([
      { type: 'user', content: msgContent },
      { type: 'response', content: msgContent },
      { type: 'user', content: msgContent },
      { type: 'response', content: msgContent },
      { type: 'user', content: msgContent },
      { type: 'response', content: msgContent },
    ]);
    (scanGitState as Mock).mockReturnValue({ isRepo: false });
    (scanWorkspace as Mock).mockReturnValue({
      cwd: TEST_CWD,
      projectType: 'npm',
      entryPoints: [],
      files: { totalFiles: 1, recentlyModified: [] },
    });

    // Budget too small to fit the full conversation summary without truncation
    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 200,
      codebaseContextStr: '',
    });

    const ctx = await cp.prepare('continue the work', 'conv-42');
    if (ctx.conversationSummary) {
      // Summary was truncated to fit within the tight 200-char budget
      expect(ctx.conversationSummary).toContain('[truncated]');
    }
  });

  it('truncates codebase context when still over budget', async () => {
    const bigCodebase = padTo(10_000);
    (scanGitState as Mock).mockReturnValue({ isRepo: false });
    (scanWorkspace as Mock).mockReturnValue({
      cwd: TEST_CWD,
      projectType: 'npm',
      entryPoints: [],
      files: { totalFiles: 1, recentlyModified: [] },
    });

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 1_000,
      codebaseContextStr: bigCodebase,
    });

    const ctx = await cp.prepare('refactor everything', 'conv-1');
    expect(ctx.codebaseContext).toContain('[truncated]');
    expect(ctx.codebaseContext.length).toBeLessThan(bigCodebase.length);
  });

  it('truncates project instructions as last resort', async () => {
    // Write a big CLAUDE.md
    const bigInstructions = 'RULE: ' + padTo(5000);
    writeFileSync(join(TEST_CWD, 'CLAUDE.md'), bigInstructions);

    (scanGitState as Mock).mockReturnValue({ isRepo: false });
    (scanWorkspace as Mock).mockReturnValue({
      cwd: TEST_CWD,
      projectType: 'npm',
      entryPoints: [],
      files: { totalFiles: 1, recentlyModified: [] },
    });

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 500,
      codebaseContextStr: padTo(400),  // eat most budget
    });

    const ctx = await cp.prepare('implement this feature', 'conv-1');
    // project instructions should be truncated
    expect(ctx.projectInstructions).toContain('[truncated]');
    // total should be within or close to budget (last resort caps at 200 min)
    expect(ctx.projectInstructions.length).toBeLessThan(bigInstructions.length);
  });

  it('result is always within maxContextChars for varied inputs', async () => {
    // Note: _applyBudget enforces a 200-char minimum on projectInstructions as
    // a last resort, so the final total may exceed maxChars by up to ~210 chars
    // (200 min + '[truncated]' suffix). We allow for this design floor.
    const maxChars = 2_000;
    const BUDGET_FLOOR_TOLERANCE = 250;

    (scanGitState as Mock).mockReturnValue({
      isRepo: true,
      branch: 'feature/big',
      uncommittedChanges: Array.from({ length: 10 }, (_, i) => `file${i}.ts`),
      recentCommits: Array.from({ length: 5 }, (_, i) => `commit-${i}`),
    });
    (scanWorkspace as Mock).mockReturnValue({
      cwd: padTo(200),
      projectType: 'npm',
      entryPoints: ['index.ts'],
      files: { totalFiles: 999, recentlyModified: Array.from({ length: 8 }, (_, i) => `f${i}.ts`) },
    });
    (getRecentMessages as Mock).mockResolvedValueOnce(
      Array.from({ length: 6 }, (_, i) => ({
        type: i % 2 === 0 ? 'user' : 'response',
        content: padTo(100),
      }))
    );

    writeFileSync(join(TEST_CWD, 'CLAUDE.md'), padTo(1000));

    const store = makeMemoryStore(
      Array.from({ length: 10 }, (_, i) => ({ content: `fact ${i}: ${padTo(50)}` }))
    );

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: maxChars,
      codebaseContextStr: padTo(1000),
      memoryStore: store,
    });

    const ctx = await cp.prepare('implement everything', 'conv-99');
    expect(totalLen(ctx)).toBeLessThanOrEqual(maxChars + BUDGET_FLOOR_TOLERANCE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation summarization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a fake message list of alternating user/assistant messages.
 * All messages have distinct timestamps so the summarizer cache key is stable.
 */
function makeMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'response',
    content: `Message ${i + 1}: details about the coding task in progress.`,
    timestamp: 1_700_000_000_000 + i * 60_000,
  }));
}

describe('ContextPreparer — conversation summarization', () => {
  // Provide a mock utilityDispatch so canSummarize = true.
  const mockUtilityDispatch = vi.fn(async () => 'dispatch result');

  beforeEach(() => {
    mockSummarizeMessages.mockReset();
    mockUtilityDispatch.mockReset();
    mockUtilityDispatch.mockResolvedValue('dispatch result');
  });

  it('fetches SUMMARIZE_FETCH_LIMIT (30) messages when no explicit limit is set and summarization is available', async () => {
    (getRecentMessages as Mock).mockResolvedValueOnce([]);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, utilityDispatch: mockUtilityDispatch });
    await cp.prepare('continue my work', 'conv-42');
    expect(getRecentMessages).toHaveBeenCalledWith('conv-42', 30);
  });

  it('does NOT expand the fetch limit when summarize: false', async () => {
    (getRecentMessages as Mock).mockResolvedValueOnce([]);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, utilityDispatch: mockUtilityDispatch, summarize: false });
    await cp.prepare('continue my work', 'conv-42');
    // Falls back to the 8-message default
    expect(getRecentMessages).toHaveBeenCalledWith('conv-42', 8);
  });

  it('does NOT expand the fetch limit when utilityDispatch is not set', async () => {
    (getRecentMessages as Mock).mockResolvedValueOnce([]);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD });
    await cp.prepare('continue my work', 'conv-42');
    // Falls back to the 8-message default
    expect(getRecentMessages).toHaveBeenCalledWith('conv-42', 8);
  });

  it('does NOT summarize when conversation is below the threshold (< 10 messages)', async () => {
    const msgs = makeMessages(8); // below SUMMARIZE_THRESHOLD of 10
    (getRecentMessages as Mock).mockResolvedValueOnce(msgs);
    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, utilityDispatch: mockUtilityDispatch });
    const ctx = await cp.prepare('continue', 'conv-42');

    // Summarizer should not be called
    expect(mockSummarizeMessages).not.toHaveBeenCalled();
    // Summary should be the raw recent messages
    expect(ctx.conversationSummary).toContain('User:');
    expect(ctx.conversationSummary).toContain('Assistant:');
  });

  it('calls summarizeMessages with older messages and dispatchFn when conversation is long enough', async () => {
    const msgs = makeMessages(15); // above threshold
    (getRecentMessages as Mock).mockResolvedValueOnce(msgs);
    // First call (cache-only, no dispatchFn) returns null → triggers fire-and-forget
    mockSummarizeMessages.mockResolvedValueOnce(null);
    mockSummarizeMessages.mockResolvedValueOnce('Compact summary of earlier work.');

    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, utilityDispatch: mockUtilityDispatch });
    await cp.prepare('continue', 'conv-42');

    // Non-blocking pattern: first call is cache-only (no dispatchFn),
    // second call is fire-and-forget with dispatchFn to populate cache.
    expect(mockSummarizeMessages).toHaveBeenCalledTimes(2);

    // First call: cache check (no dispatchFn)
    expect(mockSummarizeMessages.mock.calls[0][0]).toBe('conv-42');
    const summarizedMsgs: unknown[] = mockSummarizeMessages.mock.calls[0][1];
    // Older messages = all messages before the last 6 conversational turns = 9
    expect(summarizedMsgs).toHaveLength(9);
    expect(mockSummarizeMessages.mock.calls[0][2]).toBeUndefined();

    // Second call: fire-and-forget with dispatchFn
    expect(mockSummarizeMessages.mock.calls[1][0]).toBe('conv-42');
    expect(mockSummarizeMessages.mock.calls[1][2]).toBe(mockUtilityDispatch);
  });

  it('includes summary section and recent messages in the output', async () => {
    const msgs = makeMessages(14);
    (getRecentMessages as Mock).mockResolvedValueOnce(msgs);
    mockSummarizeMessages.mockResolvedValueOnce('User set up auth module and fixed login bug.');

    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, utilityDispatch: mockUtilityDispatch });
    const ctx = await cp.prepare('continue', 'conv-42');

    expect(ctx.conversationSummary).toContain('[Earlier conversation — summary]');
    expect(ctx.conversationSummary).toContain('User set up auth module and fixed login bug.');
    // Recent verbatim messages should also appear
    expect(ctx.conversationSummary).toContain('User:');
    expect(ctx.conversationSummary).toContain('Assistant:');
  });

  it('falls back to recent messages only when summarizer returns null', async () => {
    const msgs = makeMessages(12);
    (getRecentMessages as Mock).mockResolvedValueOnce(msgs);
    // Cache-only call returns null → fire-and-forget also returns null
    mockSummarizeMessages.mockResolvedValueOnce(null);
    mockSummarizeMessages.mockResolvedValueOnce(null);

    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, utilityDispatch: mockUtilityDispatch });
    const ctx = await cp.prepare('continue', 'conv-42');

    // No summary header, just raw recent messages
    expect(ctx.conversationSummary).not.toContain('[Earlier conversation — summary]');
    expect(ctx.conversationSummary).toContain('User:');
  });

  it('keeps exactly RECENT_KEEP (6) messages verbatim in the tail', async () => {
    const msgs = makeMessages(16); // 16 - 6 = 10 old, 6 recent
    (getRecentMessages as Mock).mockResolvedValueOnce(msgs);
    mockSummarizeMessages.mockResolvedValueOnce('Summary.');

    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, utilityDispatch: mockUtilityDispatch });
    const ctx = await cp.prepare('continue', 'conv-42');

    // Count lines in the verbatim section (after the blank line separator)
    const parts = (ctx.conversationSummary ?? '').split('\n\n');
    const recentSection = parts[parts.length - 1];
    const lines = recentSection.split('\n').filter(Boolean);
    expect(lines).toHaveLength(6);
  });

  it('passes timestamp metadata when calling summarizeMessages', async () => {
    const msgs = makeMessages(12);
    (getRecentMessages as Mock).mockResolvedValueOnce(msgs);
    mockSummarizeMessages.mockResolvedValueOnce('Summary.');

    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, utilityDispatch: mockUtilityDispatch });
    await cp.prepare('continue', 'conv-42');

    const summarizedMsgs: Array<{ timestamp?: number }> = mockSummarizeMessages.mock.calls[0][1];
    // Every message should carry a timestamp (for cache key stability)
    for (const m of summarizedMsgs) {
      expect(typeof m.timestamp).toBe('number');
    }
  });

  it('disables summarization when summarize: false even for long conversations', async () => {
    const msgs = makeMessages(20);
    (getRecentMessages as Mock).mockResolvedValueOnce(msgs);

    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, utilityDispatch: mockUtilityDispatch, summarize: false });
    await cp.prepare('continue', 'conv-42');

    expect(mockSummarizeMessages).not.toHaveBeenCalled();
  });

  it('returns undefined and does not call summarizer when getRecentMessages throws', async () => {
    (getRecentMessages as Mock).mockRejectedValueOnce(new Error('DB down'));

    const cp = new ContextPreparer({ workingDirectory: TEST_CWD, utilityDispatch: mockUtilityDispatch });
    const ctx = await cp.prepare('continue', 'conv-42');

    expect(ctx.conversationSummary).toBeUndefined();
    expect(mockSummarizeMessages).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getBudgetTier — pure function
// ─────────────────────────────────────────────────────────────────────────────

describe('getBudgetTier', () => {
  it('returns "early" for 0 turns (no conversation yet)', () => {
    expect(getBudgetTier(0)).toBe('early');
  });

  it('returns "early" for 1–4 turns', () => {
    expect(getBudgetTier(1)).toBe('early');
    expect(getBudgetTier(4)).toBe('early');
  });

  it('returns "mid" for 5–10 turns', () => {
    expect(getBudgetTier(5)).toBe('mid');
    expect(getBudgetTier(10)).toBe('mid');
  });

  it('returns "long" for 11–20 turns', () => {
    expect(getBudgetTier(11)).toBe('long');
    expect(getBudgetTier(20)).toBe('long');
  });

  it('returns "extended" for 21+ turns', () => {
    expect(getBudgetTier(21)).toBe('extended');
    expect(getBudgetTier(100)).toBe('extended');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adaptive budget tiers — integration tests via prepare()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a fake message list of alternating user/response messages.
 * Used to simulate conversations of various lengths so the adaptive budget
 * tier kicks in based on the number of returned messages.
 */
function makeConversationMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'response',
    content: `Turn ${i + 1}: working on the codebase refactor.`,
    timestamp: 1_700_000_000_000 + i * 60_000,
  }));
}

describe('ContextPreparer — adaptive budget tiers', () => {
  beforeEach(() => {
    // Default git + workspace mocks for all adaptive tests
    (scanGitState as Mock).mockReturnValue({ isRepo: false });
    (scanWorkspace as Mock).mockReturnValue({
      cwd: TEST_CWD,
      projectType: 'npm',
      entryPoints: [],
      files: { totalFiles: 1, recentlyModified: [] },
    });
  });

  // ── Workspace snapshot caps by tier ────────────────────────────────────────

  it('early tier (≤4 turns): workspace snapshot cap is 1000 chars', async () => {
    const bigWorkspace = 'w'.repeat(1500);
    (scanWorkspace as Mock).mockReturnValueOnce({
      cwd: bigWorkspace,
      projectType: 'npm',
      entryPoints: [],
      files: { totalFiles: 1, recentlyModified: [] },
    });
    // 3 turns — early tier
    (getRecentMessages as Mock).mockResolvedValueOnce(makeConversationMessages(3));

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 500,
      codebaseContextStr: '',
    });
    const ctx = await cp.prepare('fix the bug', 'conv-early');
    // Should be truncated at 1000 (early workspace cap)
    expect(ctx.workspaceSnapshot).toContain('[truncated]');
    expect(ctx.workspaceSnapshot.length).toBeLessThanOrEqual(1000 + '[truncated]'.length + 5);
  });

  it('mid tier (5–10 turns): workspace snapshot cap is 700 chars', async () => {
    const bigWorkspace = 'w'.repeat(1500);
    (scanWorkspace as Mock).mockReturnValueOnce({
      cwd: bigWorkspace,
      projectType: 'npm',
      entryPoints: [],
      files: { totalFiles: 1, recentlyModified: [] },
    });
    // 7 turns — mid tier
    (getRecentMessages as Mock).mockResolvedValueOnce(makeConversationMessages(7));

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 400,
      codebaseContextStr: '',
    });
    const ctx = await cp.prepare('fix the bug', 'conv-mid');
    expect(ctx.workspaceSnapshot).toContain('[truncated]');
    // Mid cap is 700 — so the truncated snapshot is ≤ 700 + sentinel
    expect(ctx.workspaceSnapshot.length).toBeLessThanOrEqual(700 + '[truncated]'.length + 5);
  });

  it('long tier (11–20 turns): workspace snapshot cap is 450 chars', async () => {
    const bigWorkspace = 'w'.repeat(1500);
    (scanWorkspace as Mock).mockReturnValueOnce({
      cwd: bigWorkspace,
      projectType: 'npm',
      entryPoints: [],
      files: { totalFiles: 1, recentlyModified: [] },
    });
    // 14 turns — long tier
    (getRecentMessages as Mock).mockResolvedValueOnce(makeConversationMessages(14));

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 300,
      codebaseContextStr: '',
    });
    const ctx = await cp.prepare('fix the bug', 'conv-long');
    expect(ctx.workspaceSnapshot).toContain('[truncated]');
    expect(ctx.workspaceSnapshot.length).toBeLessThanOrEqual(450 + '[truncated]'.length + 5);
  });

  it('extended tier (21+ turns): workspace snapshot cap is 250 chars', async () => {
    const bigWorkspace = 'w'.repeat(1500);
    (scanWorkspace as Mock).mockReturnValueOnce({
      cwd: bigWorkspace,
      projectType: 'npm',
      entryPoints: [],
      files: { totalFiles: 1, recentlyModified: [] },
    });
    // 25 turns — extended tier
    (getRecentMessages as Mock).mockResolvedValueOnce(makeConversationMessages(25));

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 200,
      codebaseContextStr: '',
    });
    const ctx = await cp.prepare('fix the bug', 'conv-extended');
    expect(ctx.workspaceSnapshot).toContain('[truncated]');
    expect(ctx.workspaceSnapshot.length).toBeLessThanOrEqual(250 + '[truncated]'.length + 5);
  });

  // ── Instructions floor by tier ─────────────────────────────────────────────
  // The core invariant: project instructions are NEVER truncated below the
  // per-tier floor, so the agent retains its identity across long sessions.

  it('early tier: instructions floor is 200 chars (preserves existing behaviour)', async () => {
    const bigInstructions = 'R'.repeat(5000);
    writeFileSync(join(TEST_CWD, 'CLAUDE.md'), bigInstructions);
    (getRecentMessages as Mock).mockResolvedValueOnce(makeConversationMessages(2)); // early

    // Budget: 1000. Safety net = min(200, 500) = 200.
    // Codebase eats 700 chars → remaining for instructions = 300, so floor of 200 applies.
    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 1_000,
      codebaseContextStr: 'x'.repeat(700),
    });
    const ctx = await cp.prepare('implement this', 'conv-1');
    // Instructions should be kept to at least 200 chars (early floor)
    expect(ctx.projectInstructions.length).toBeGreaterThanOrEqual(200);
  });

  it('mid tier: instructions floor is 600 chars', async () => {
    const bigInstructions = 'R'.repeat(5000);
    writeFileSync(join(TEST_CWD, 'CLAUDE.md'), bigInstructions);
    // 6 turns — mid tier, floor = 600
    (getRecentMessages as Mock).mockResolvedValueOnce(makeConversationMessages(6));

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 300, // budget < floor forces floor to apply
      codebaseContextStr: '',
    });
    const ctx = await cp.prepare('implement this', 'conv-1');
    // Floor is 600, but it can't exceed 50% of maxContextChars (150) — safety net
    // So effective floor is min(600, 150) = 150. Instructions ≥ 150 chars.
    expect(ctx.projectInstructions.length).toBeGreaterThanOrEqual(150);
  });

  it('long tier: instructions floor is 1200 chars (or 50% of budget, whichever is less)', async () => {
    const bigInstructions = 'R'.repeat(5000);
    writeFileSync(join(TEST_CWD, 'CLAUDE.md'), bigInstructions);
    // 15 turns — long tier, floor = 1200
    (getRecentMessages as Mock).mockResolvedValueOnce(makeConversationMessages(15));

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 4_000, // budget > floor — floor applies as-is
      codebaseContextStr: 'x'.repeat(2000),
    });
    const ctx = await cp.prepare('implement this', 'conv-1');
    // With budget 4000 and codebase 2000, there's room for 1200 chars of instructions
    expect(ctx.projectInstructions.length).toBeGreaterThanOrEqual(1_200);
  });

  it('extended tier: instructions floor is 2500 chars for very long sessions', async () => {
    const bigInstructions = 'R'.repeat(8000);
    writeFileSync(join(TEST_CWD, 'CLAUDE.md'), bigInstructions);
    // 30 turns — extended tier, floor = 2500
    (getRecentMessages as Mock).mockResolvedValueOnce(makeConversationMessages(30));

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 8_000,
      codebaseContextStr: 'x'.repeat(3000),
    });
    const ctx = await cp.prepare('implement this', 'conv-1');
    // Extended floor is 2500
    expect(ctx.projectInstructions.length).toBeGreaterThanOrEqual(2_500);
  });

  // ── Conversation summary caps by tier ──────────────────────────────────────

  it('early tier: conversation summary cap is 3000 chars', async () => {
    const longSummary = 'S'.repeat(4000);
    // Mock: return a short message list (so we DON'T hit the summarizer path)
    (getRecentMessages as Mock).mockResolvedValueOnce([
      { type: 'user', content: longSummary },
      { type: 'response', content: longSummary },
    ]);
    // 2 messages — early tier

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 200, // tight budget to force summary truncation
      codebaseContextStr: '',
    });
    const ctx = await cp.prepare('continue', 'conv-1');
    if (ctx.conversationSummary) {
      // Early summary cap: 3000
      expect(ctx.conversationSummary.length).toBeLessThanOrEqual(3000 + '[truncated]'.length + 5);
    }
  });

  it('extended tier: conversation summary cap is 1000 chars', async () => {
    const longSummary = 'S'.repeat(800);
    // 25 messages — extended tier
    (getRecentMessages as Mock).mockResolvedValueOnce(
      Array.from({ length: 25 }, (_, i) => ({
        type: i % 2 === 0 ? 'user' : 'response',
        content: longSummary,
        timestamp: 1_700_000_000_000 + i * 60_000,
      }))
    );

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 150,  // tiny budget forces summary truncation
      codebaseContextStr: '',
      summarize: false,       // disable AI summarization to keep test fast
    });
    const ctx = await cp.prepare('continue', 'conv-extended');
    if (ctx.conversationSummary) {
      // Extended summary cap: 1000
      expect(ctx.conversationSummary.length).toBeLessThanOrEqual(1000 + '[truncated]'.length + 5);
    }
  });

  // ── Zero turns (fresh session) ─────────────────────────────────────────────

  it('zero turns (new session or missing history): uses early tier, no crash', async () => {
    (getRecentMessages as Mock).mockResolvedValueOnce([]); // no history

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 40_000,
      codebaseContextStr: 'some codebase info',
    });
    const ctx = await cp.prepare('add a feature', 'brand-new-conv');
    // No crash, context assembled correctly
    expect(ctx.codebaseContext).toBe('some codebase info');
    expect(ctx.conversationSummary).toBeUndefined();
  });

  // ── Safety net: instructions floor never exceeds 50% of total budget ───────

  it('instructions floor is capped at 50% of total budget to prevent overflow', async () => {
    const bigInstructions = 'R'.repeat(5000);
    writeFileSync(join(TEST_CWD, 'CLAUDE.md'), bigInstructions);
    // 25 turns — extended tier, raw floor = 2500
    (getRecentMessages as Mock).mockResolvedValueOnce(makeConversationMessages(25));

    // maxContextChars = 400 → 50% cap = 200, which is less than 2500
    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 400,
      codebaseContextStr: '',
    });
    const ctx = await cp.prepare('implement', 'conv-1');
    // Should not exceed 50% of 400 = 200 chars for instructions
    expect(ctx.projectInstructions.length).toBeLessThanOrEqual(200 + '[truncated]'.length + 5);
  });

  // ── General mode: adaptive tier still applies but instructions are empty ───

  it('general mode: turnCount is tracked but context is empty (non-coding path)', async () => {
    // 30 turns — extended tier
    (getRecentMessages as Mock).mockResolvedValueOnce(makeConversationMessages(30));

    const cp = new ContextPreparer({
      workingDirectory: TEST_CWD,
      maxContextChars: 40_000,
      codebaseContextStr: 'ignored in general mode',
    });
    const ctx = await cp.prepare('hey how are you today', 'conv-general');
    // General mode: all coding context empty
    expect(ctx.memoryFacts).toEqual([]);
    expect(ctx.gitContext).toBe('');
    expect(ctx.workspaceSnapshot).toBe('');
    expect(ctx.codebaseContext).toBe('');
    // No crash from adaptive tier logic
  });
});

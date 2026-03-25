/**
 * Tests for Context Builder
 *
 * Context builder bridges the gap between the general agent (which has full
 * conversation history, personality, workspace context) and Claude Code (which
 * starts fresh each invocation). Getting this handoff right is critical.
 *
 * Covers:
 *   - formatHandoffPrompt:     pure function — section assembly, ordering, truncation
 *   - detectConversationTone:  tone detection via regex (via buildHandoffContext)
 *   - loadWorkspaceContext:    cache TTL, stale refresh, corrupt JSON fallback
 *   - refreshWorkspaceContext: scans workspace, writes cache
 *   - loadConversationContext: message filtering, type mapping, ongoing task detection
 *   - storeLastClaudeResult:   writes JSON, enforces 2000-char cap
 *   - cacheCodebaseContext:    writes codebase summary to correct path
 *   - buildHandoffContext:     full orchestration, TTL-gated previousResult
 *   - enhanceClaudeCodePrompt: main public API — prompt + system prompt
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkspaceSnapshot } from './workspace-scanner';
import type { HandoffContext, WorkspaceContext } from './context-builder';
import type { StoredMessage } from '../p2p/message-store';

// ── Mock all I/O dependencies before importing the module under test ──

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./workspace-scanner', () => ({
  scanWorkspace: vi.fn(),
}));

vi.mock('../p2p/message-store', () => ({
  getRecentMessages: vi.fn(),
}));

vi.mock('../p2p/index', () => ({
  getCurrentConversationId: vi.fn(),
}));

vi.mock('../prompts/system_prompts', () => ({
  buildCodingPrompt: vi.fn().mockReturnValue('MOCK_MINIMAL_PROMPT'),
}));

vi.mock('../utils/json-format', () => ({
  formatJson: vi.fn((obj: unknown) => JSON.stringify(obj)),
}));

// ── Import after mocks are set up ──

import {
  formatHandoffPrompt,
  loadWorkspaceContext,
  refreshWorkspaceContext,
  loadConversationContext,
  storeLastClaudeResult,
  cacheCodebaseContext,
  buildHandoffContext,
  enhanceClaudeCodePrompt,
} from './context-builder';

import { readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { writeFile } from 'fs/promises';
import { scanWorkspace } from './workspace-scanner';
import { getRecentMessages } from '../p2p/message-store';
import { getCurrentConversationId } from '../p2p/index';
import { buildCodingPrompt } from '../prompts/system_prompts';

const mockReadFile = vi.mocked(readFileSync);
const mockWriteFile = vi.mocked(writeFile);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockStatSync = vi.mocked(statSync);
const mockScanWorkspace = vi.mocked(scanWorkspace);
const mockGetRecentMessages = vi.mocked(getRecentMessages);
const mockGetCurrentConversationId = vi.mocked(getCurrentConversationId);
const mockBuildCodingPrompt = vi.mocked(buildCodingPrompt);

// ── Helpers ──

function makeStoredMessage(overrides: Partial<StoredMessage> & Pick<StoredMessage, 'id' | 'conversationId' | 'type' | 'content' | 'timestamp'>): StoredMessage {
  return { ...overrides };
}

function makeSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    cwd: '/project',
    timestamp: Date.now(),
    git: { isRepo: false },
    files: {
      totalFiles: 10,
      totalDirectories: 3,
      recentlyModified: [],
      largeFiles: [],
      configFiles: [],
    },
    ...overrides,
  };
}

function makeContext(overrides: Partial<HandoffContext> = {}): HandoffContext {
  return {
    conversation: { recentMessages: [] },
    workspace: { snapshot: makeSnapshot(), lastUpdated: Date.now() },
    relevantFacts: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// formatHandoffPrompt — pure function, no mocks needed
// ─────────────────────────────────────────────────────────────────────

describe('formatHandoffPrompt', () => {
  describe('Layer 1: stable context (personality, user, codebase)', () => {
    it('includes personality section when personality is set', () => {
      const result = formatHandoffPrompt(makeContext({ personality: 'Sharp and direct' }));
      expect(result).toContain('═══ PERSONALITY ═══');
      expect(result).toContain('Sharp and direct');
    });

    it('omits personality section when personality is undefined', () => {
      const result = formatHandoffPrompt(makeContext());
      expect(result).not.toContain('═══ PERSONALITY ═══');
    });

    it('includes user profile section when userProfile is set', () => {
      const result = formatHandoffPrompt(makeContext({ userProfile: 'The user, backend dev' }));
      expect(result).toContain('═══ USER ═══');
      expect(result).toContain('The user, backend dev');
    });

    it('omits user profile section when userProfile is undefined', () => {
      const result = formatHandoffPrompt(makeContext());
      expect(result).not.toContain('═══ USER ═══');
    });

    it('includes codebase section when codebaseContext is set', () => {
      const result = formatHandoffPrompt(makeContext({ codebaseContext: 'TypeScript monorepo' }));
      expect(result).toContain('═══ CODEBASE ═══');
      expect(result).toContain('TypeScript monorepo');
    });

    it('omits codebase section when codebaseContext is undefined', () => {
      const result = formatHandoffPrompt(makeContext());
      expect(result).not.toContain('═══ CODEBASE ═══');
    });
  });

  describe('Layer 2: semi-stable context (workspace, facts)', () => {
    it('always includes workspace state section with cwd', () => {
      const result = formatHandoffPrompt(makeContext());
      expect(result).toContain('═══ WORKSPACE STATE ═══');
      expect(result).toContain('Working Directory: /project');
    });

    it('includes project type when available', () => {
      const ctx = makeContext({
        workspace: { snapshot: makeSnapshot({ projectType: 'npm' }), lastUpdated: Date.now() },
      });
      expect(formatHandoffPrompt(ctx)).toContain('Project: npm');
    });

    it('omits project type when not available', () => {
      const result = formatHandoffPrompt(makeContext());
      expect(result).not.toContain('Project:');
    });

    it('includes git branch when repo is detected', () => {
      const ctx = makeContext({
        workspace: {
          snapshot: makeSnapshot({ git: { isRepo: true, branch: 'feature/x' } }),
          lastUpdated: Date.now(),
        },
      });
      expect(formatHandoffPrompt(ctx)).toContain('Branch: feature/x');
    });

    it('omits git info when not a repo', () => {
      const result = formatHandoffPrompt(makeContext());
      expect(result).not.toContain('Branch:');
    });

    it('lists dirty files when uncommitted changes exist', () => {
      const ctx = makeContext({
        workspace: {
          snapshot: makeSnapshot({
            git: { isRepo: true, branch: 'main', uncommittedChanges: ['src/a.ts', 'src/b.ts'] },
          }),
          lastUpdated: Date.now(),
        },
      });
      const result = formatHandoffPrompt(ctx);
      expect(result).toContain('Dirty files: src/a.ts, src/b.ts');
    });

    it('caps dirty files list at 8 entries', () => {
      const lotsOfFiles = Array.from({ length: 12 }, (_, i) => `file${i}.ts`);
      const ctx = makeContext({
        workspace: {
          snapshot: makeSnapshot({ git: { isRepo: true, uncommittedChanges: lotsOfFiles } }),
          lastUpdated: Date.now(),
        },
      });
      const result = formatHandoffPrompt(ctx);
      // should include first 8, not the last 4
      expect(result).toContain('file0.ts');
      expect(result).toContain('file7.ts');
      expect(result).not.toContain('file8.ts');
    });

    it('lists recent commits when available', () => {
      const ctx = makeContext({
        workspace: {
          snapshot: makeSnapshot({ git: { isRepo: true, recentCommits: ['abc123 fix: thing'] } }),
          lastUpdated: Date.now(),
        },
      });
      const result = formatHandoffPrompt(ctx);
      expect(result).toContain('Recent commits:');
      expect(result).toContain('abc123 fix: thing');
    });

    it('caps recent commits at 5 entries', () => {
      const manyCommits = Array.from({ length: 8 }, (_, i) => `commit-${i}`);
      const ctx = makeContext({
        workspace: {
          snapshot: makeSnapshot({ git: { isRepo: true, recentCommits: manyCommits } }),
          lastUpdated: Date.now(),
        },
      });
      const result = formatHandoffPrompt(ctx);
      expect(result).toContain('commit-0');
      expect(result).toContain('commit-4');
      expect(result).not.toContain('commit-5');
    });

    it('lists recently modified files', () => {
      const ctx = makeContext({
        workspace: {
          snapshot: makeSnapshot({
            files: {
              totalFiles: 5,
              totalDirectories: 2,
              recentlyModified: ['src/index.ts', 'src/util.ts'],
              largeFiles: [],
              configFiles: [],
            },
          }),
          lastUpdated: Date.now(),
        },
      });
      expect(formatHandoffPrompt(ctx)).toContain('Recently touched: src/index.ts, src/util.ts');
    });

    it('caps recently modified files at 8 entries', () => {
      const manyFiles = Array.from({ length: 12 }, (_, i) => `file${i}.ts`);
      const ctx = makeContext({
        workspace: {
          snapshot: makeSnapshot({
            files: {
              totalFiles: 20,
              totalDirectories: 5,
              recentlyModified: manyFiles,
              largeFiles: [],
              configFiles: [],
            },
          }),
          lastUpdated: Date.now(),
        },
      });
      const result = formatHandoffPrompt(ctx);
      expect(result).toContain('file7.ts');
      expect(result).not.toContain('file8.ts');
    });

    it('includes known facts section when relevantFacts is non-empty', () => {
      const result = formatHandoffPrompt(makeContext({ relevantFacts: ['fact A', 'fact B'] }));
      expect(result).toContain('═══ KNOWN FACTS ═══');
      expect(result).toContain('fact A');
      expect(result).toContain('fact B');
    });

    it('omits known facts section when relevantFacts is empty', () => {
      const result = formatHandoffPrompt(makeContext({ relevantFacts: [] }));
      expect(result).not.toContain('═══ KNOWN FACTS ═══');
    });
  });

  describe('Layer 3: volatile context (conversation, previous result, tone)', () => {
    it('includes conversation context section when messages are present', () => {
      const ctx = makeContext({
        conversation: {
          recentMessages: [{ role: 'user', content: 'fix the login bug' }],
          ongoingTask: 'fix the login bug',
        },
      });
      const result = formatHandoffPrompt(ctx);
      expect(result).toContain('═══ CONVERSATION CONTEXT ═══');
      expect(result).toContain('Current goal: fix the login bug');
    });

    it('omits conversation context when no messages exist', () => {
      const result = formatHandoffPrompt(makeContext());
      expect(result).not.toContain('═══ CONVERSATION CONTEXT ═══');
    });

    it('labels user messages as "the user"', () => {
      const ctx = makeContext({
        conversation: { recentMessages: [{ role: 'user', content: 'hello' }] },
      });
      expect(formatHandoffPrompt(ctx)).toContain('the user: hello');
    });

    it('labels assistant messages as "Mia"', () => {
      const ctx = makeContext({
        conversation: { recentMessages: [{ role: 'assistant', content: 'hi there' }] },
      });
      expect(formatHandoffPrompt(ctx)).toContain('Mia: hi there');
    });

    it('truncates messages longer than 300 chars and appends ellipsis', () => {
      const longContent = 'a'.repeat(350);
      const ctx = makeContext({
        conversation: { recentMessages: [{ role: 'user', content: longContent }] },
      });
      const result = formatHandoffPrompt(ctx);
      expect(result).toContain('a'.repeat(300) + '...');
      expect(result).not.toContain('a'.repeat(301));
    });

    it('does not truncate messages exactly 300 chars', () => {
      const content = 'b'.repeat(300);
      const ctx = makeContext({
        conversation: { recentMessages: [{ role: 'user', content }] },
      });
      const result = formatHandoffPrompt(ctx);
      expect(result).toContain(content);
      expect(result).not.toContain(content + '...');
    });

    it('limits displayed conversation to last 8 messages', () => {
      const messages = Array.from({ length: 12 }, (_, i) => ({
        role: 'user' as const,
        content: `message-${i}`,
      }));
      const ctx = makeContext({ conversation: { recentMessages: messages } });
      const result = formatHandoffPrompt(ctx);
      // last 8: indices 4–11
      expect(result).toContain('message-4');
      expect(result).toContain('message-11');
      // first 4 should be excluded
      expect(result).not.toContain('message-0');
      expect(result).not.toContain('message-3');
    });

    it('truncates ongoing task goal to 300 chars', () => {
      const longTask = 'z'.repeat(400);
      const ctx = makeContext({
        conversation: {
          recentMessages: [{ role: 'user', content: longTask }],
          ongoingTask: longTask,
        },
      });
      const result = formatHandoffPrompt(ctx);
      expect(result).toContain('Current goal: ' + 'z'.repeat(300));
      expect(result).not.toContain('z'.repeat(301));
    });

    it('includes previous result section when previousResult is set', () => {
      const ctx = makeContext({ previousResult: 'Built and deployed successfully' });
      const result = formatHandoffPrompt(ctx);
      expect(result).toContain('═══ PREVIOUS RESULT ═══');
      expect(result).toContain('Built and deployed successfully');
    });

    it('omits previous result section when previousResult is undefined', () => {
      const result = formatHandoffPrompt(makeContext());
      expect(result).not.toContain('═══ PREVIOUS RESULT ═══');
    });

    it('includes tone section when conversationTone is set', () => {
      const ctx = makeContext({ conversationTone: 'The user sounds frustrated.' });
      const result = formatHandoffPrompt(ctx);
      expect(result).toContain('═══ TONE ═══');
      expect(result).toContain('The user sounds frustrated.');
    });

    it('omits tone section when conversationTone is undefined', () => {
      const result = formatHandoffPrompt(makeContext());
      expect(result).not.toContain('═══ TONE ═══');
    });
  });

  describe('section ordering (stable → semi-stable → volatile)', () => {
    it('orders all sections correctly', () => {
      const ctx = makeContext({
        personality: 'My personality',
        userProfile: 'mia',
        codebaseContext: 'TS project',
        relevantFacts: ['key fact'],
        conversation: { recentMessages: [{ role: 'user', content: 'task' }] },
        previousResult: 'done',
        conversationTone: 'urgent',
      });
      const result = formatHandoffPrompt(ctx);

      const idx = (marker: string) => result.indexOf(marker);

      expect(idx('PERSONALITY')).toBeLessThan(idx('USER ═══'));
      expect(idx('USER ═══')).toBeLessThan(idx('CODEBASE'));
      expect(idx('CODEBASE')).toBeLessThan(idx('WORKSPACE STATE'));
      expect(idx('WORKSPACE STATE')).toBeLessThan(idx('KNOWN FACTS'));
      expect(idx('KNOWN FACTS')).toBeLessThan(idx('CONVERSATION CONTEXT'));
      expect(idx('CONVERSATION CONTEXT')).toBeLessThan(idx('PREVIOUS RESULT'));
      expect(idx('PREVIOUS RESULT')).toBeLessThan(idx('TONE'));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// loadWorkspaceContext — cache TTL and fallback behaviour
// ─────────────────────────────────────────────────────────────────────

describe('loadWorkspaceContext', () => {
  const CWD = '/my/project';

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockReturnValue(undefined as never);
    mockWriteFile.mockResolvedValue(undefined);
    mockScanWorkspace.mockReturnValue(makeSnapshot({ cwd: CWD }));
    // Default: files are small enough to pass the size gate
    mockStatSync.mockReturnValue({ size: 1024 } as never);
  });

  it('returns cached context when fresh (within default 30 minute window)', () => {
    const freshCached: WorkspaceContext = {
      snapshot: makeSnapshot({ cwd: CWD }),
      lastUpdated: Date.now() - 60_000, // 1 minute ago
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockReturnValue(JSON.stringify(freshCached) as never);

    const result = loadWorkspaceContext(CWD);

    expect(result).toEqual(freshCached);
    expect(mockScanWorkspace).not.toHaveBeenCalled();
  });

  it('refreshes cache when older than maxAgeMs', () => {
    const staleCached: WorkspaceContext = {
      snapshot: makeSnapshot({ cwd: CWD }),
      lastUpdated: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
    };
    const freshSnapshot = makeSnapshot({ cwd: CWD, projectType: 'npm' });
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockReturnValue(JSON.stringify(staleCached) as never);
    mockScanWorkspace.mockReturnValue(freshSnapshot);

    const result = loadWorkspaceContext(CWD);

    expect(mockScanWorkspace).toHaveBeenCalledWith(CWD);
    expect(result.snapshot.projectType).toBe('npm');
  });

  it('refreshes when cache file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = loadWorkspaceContext(CWD);

    expect(mockScanWorkspace).toHaveBeenCalledWith(CWD);
    expect(result.snapshot.cwd).toBe(CWD);
  });

  it('refreshes when cached JSON is corrupt', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockReturnValue('{ invalid json ]]]' as never);

    loadWorkspaceContext(CWD);

    expect(mockScanWorkspace).toHaveBeenCalledWith(CWD);
  });

  it('respects custom maxAgeMs — refreshes when cache is just older than the limit', () => {
    const cached: WorkspaceContext = {
      snapshot: makeSnapshot({ cwd: CWD }),
      lastUpdated: Date.now() - 5_000, // 5 seconds ago
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockReturnValue(JSON.stringify(cached) as never);

    // Use 1-second max age — 5-second-old cache should be stale
    loadWorkspaceContext(CWD, 1_000);

    expect(mockScanWorkspace).toHaveBeenCalledWith(CWD);
  });

  it('does not call scanWorkspace when cache is within custom maxAgeMs', () => {
    const cached: WorkspaceContext = {
      snapshot: makeSnapshot({ cwd: CWD }),
      lastUpdated: Date.now() - 5_000, // 5 seconds ago
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockReturnValue(JSON.stringify(cached) as never);

    // Use 1-minute max age — 5-second-old cache is fresh
    loadWorkspaceContext(CWD, 60_000);

    expect(mockScanWorkspace).not.toHaveBeenCalled();
  });

  it('rebuilds when workspace cache file exceeds MAX_CONTEXT_FILE_BYTES (256 KB)', () => {
    mockExistsSync.mockReturnValue(true);
    // Simulate an oversized cache file
    mockStatSync.mockReturnValue({ size: 300 * 1024 } as never);

    loadWorkspaceContext(CWD);

    // Should skip the oversized cache and trigger a fresh scan
    expect(mockScanWorkspace).toHaveBeenCalledWith(CWD);
  });
});

// ─────────────────────────────────────────────────────────────────────
// refreshWorkspaceContext — scans and persists
// ─────────────────────────────────────────────────────────────────────

describe('refreshWorkspaceContext', () => {
  const CWD = '/refresh/project';

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockMkdirSync.mockReturnValue(undefined as never);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('calls scanWorkspace with the provided cwd', () => {
    mockScanWorkspace.mockReturnValue(makeSnapshot({ cwd: CWD }));
    refreshWorkspaceContext(CWD);
    expect(mockScanWorkspace).toHaveBeenCalledWith(CWD);
  });

  it('writes the workspace context to disk', () => {
    mockScanWorkspace.mockReturnValue(makeSnapshot({ cwd: CWD }));
    refreshWorkspaceContext(CWD);
    expect(mockWriteFile).toHaveBeenCalledOnce();
  });

  it('returns WorkspaceContext with snapshot and lastUpdated timestamp', () => {
    const snapshot = makeSnapshot({ cwd: CWD, projectType: 'rust' });
    mockScanWorkspace.mockReturnValue(snapshot);

    const before = Date.now();
    const result = refreshWorkspaceContext(CWD);
    const after = Date.now();

    expect(result.snapshot).toEqual(snapshot);
    expect(result.lastUpdated).toBeGreaterThanOrEqual(before);
    expect(result.lastUpdated).toBeLessThanOrEqual(after);
  });

  it('writes to a path containing the project name', () => {
    mockScanWorkspace.mockReturnValue(makeSnapshot({ cwd: CWD }));
    refreshWorkspaceContext(CWD);
    const [writePath] = mockWriteFile.mock.calls[0] as [string, ...unknown[]];
    expect(writePath).toContain('project');
    expect(writePath).toContain('workspace-');
  });
});

// ─────────────────────────────────────────────────────────────────────
// loadConversationContext — message filtering, role mapping, task detection
// ─────────────────────────────────────────────────────────────────────

describe('loadConversationContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty context when there is no current conversation ID', async () => {
    mockGetCurrentConversationId.mockReturnValue(null);
    const result = await loadConversationContext();
    expect(result).toEqual({ recentMessages: [] });
  });

  it('filters out non-message types (e.g. "system")', async () => {
    mockGetCurrentConversationId.mockReturnValue('conv-1');
    mockGetRecentMessages.mockResolvedValue([
      makeStoredMessage({ id: '1', conversationId: 'conv-1', type: 'user', content: 'hello', timestamp: 0 }),
      makeStoredMessage({ id: '2', conversationId: 'conv-1', type: 'system', content: 'ignored', timestamp: 1 }),
    ]);

    const result = await loadConversationContext();
    expect(result.recentMessages).toHaveLength(1);
    expect(result.recentMessages[0].content).toBe('hello');
  });

  it('maps "user" type to role "user"', async () => {
    mockGetCurrentConversationId.mockReturnValue('conv-1');
    mockGetRecentMessages.mockResolvedValue([
      makeStoredMessage({ id: '1', conversationId: 'conv-1', type: 'user', content: 'a question', timestamp: 0 }),
    ]);

    const result = await loadConversationContext();
    expect(result.recentMessages[0].role).toBe('user');
  });

  it('maps "response" type to role "assistant"', async () => {
    mockGetCurrentConversationId.mockReturnValue('conv-1');
    mockGetRecentMessages.mockResolvedValue([
      makeStoredMessage({ id: '1', conversationId: 'conv-1', type: 'response', content: 'the answer', timestamp: 0 }),
    ]);

    const result = await loadConversationContext();
    expect(result.recentMessages[0].role).toBe('assistant');
  });

  it('maps "assistant" type to role "assistant"', async () => {
    mockGetCurrentConversationId.mockReturnValue('conv-1');
    mockGetRecentMessages.mockResolvedValue([
      makeStoredMessage({ id: '1', conversationId: 'conv-1', type: 'assistant', content: 'also me', timestamp: 0 }),
    ]);

    const result = await loadConversationContext();
    expect(result.recentMessages[0].role).toBe('assistant');
  });

  it('identifies the most recent user message as the ongoingTask', async () => {
    mockGetCurrentConversationId.mockReturnValue('conv-1');
    mockGetRecentMessages.mockResolvedValue([
      makeStoredMessage({ id: '1', conversationId: 'conv-1', type: 'user', content: 'first task', timestamp: 0 }),
      makeStoredMessage({ id: '2', conversationId: 'conv-1', type: 'response', content: 'done', timestamp: 1 }),
      makeStoredMessage({ id: '3', conversationId: 'conv-1', type: 'user', content: 'second task', timestamp: 2 }),
    ]);

    const result = await loadConversationContext();
    expect(result.ongoingTask).toBe('second task');
  });

  it('leaves ongoingTask undefined when there are no user messages', async () => {
    mockGetCurrentConversationId.mockReturnValue('conv-1');
    mockGetRecentMessages.mockResolvedValue([
      makeStoredMessage({ id: '1', conversationId: 'conv-1', type: 'response', content: 'a response', timestamp: 0 }),
    ]);

    const result = await loadConversationContext();
    expect(result.ongoingTask).toBeUndefined();
  });

  it('returns empty context on message store error (resilient)', async () => {
    mockGetCurrentConversationId.mockReturnValue('conv-1');
    mockGetRecentMessages.mockRejectedValue(new Error('DB error'));

    const result = await loadConversationContext();
    expect(result).toEqual({ recentMessages: [] });
  });

  it('passes the limit parameter to getRecentMessages', async () => {
    mockGetCurrentConversationId.mockReturnValue('conv-1');
    mockGetRecentMessages.mockResolvedValue([]);

    await loadConversationContext(5);
    expect(mockGetRecentMessages).toHaveBeenCalledWith('conv-1', 5);
  });

  it('uses default limit of 10 when none is provided', async () => {
    mockGetCurrentConversationId.mockReturnValue('conv-1');
    mockGetRecentMessages.mockResolvedValue([]);

    await loadConversationContext();
    expect(mockGetRecentMessages).toHaveBeenCalledWith('conv-1', 10);
  });
});

// ─────────────────────────────────────────────────────────────────────
// storeLastClaudeResult — write JSON, enforce 2000-char cap
// ─────────────────────────────────────────────────────────────────────

describe('storeLastClaudeResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockMkdirSync.mockReturnValue(undefined as never);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('writes JSON containing the result, taskId, and a timestamp', () => {
    const before = Date.now();
    storeLastClaudeResult('task output', 'task-123');
    const after = Date.now();

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, ...unknown[]];
    const data = JSON.parse(content);

    expect(data.result).toBe('task output');
    expect(data.taskId).toBe('task-123');
    expect(data.timestamp).toBeGreaterThanOrEqual(before);
    expect(data.timestamp).toBeLessThanOrEqual(after);
  });

  it('truncates result to exactly 2000 characters', () => {
    const longResult = 'x'.repeat(3000);
    storeLastClaudeResult(longResult, 'task-1');

    const [, content] = mockWriteFile.mock.calls[0] as [string, string, ...unknown[]];
    const data = JSON.parse(content);

    expect(data.result).toHaveLength(2000);
    expect(data.result).toBe('x'.repeat(2000));
  });

  it('does not truncate results shorter than 2000 characters', () => {
    const shortResult = 'y'.repeat(500);
    storeLastClaudeResult(shortResult, 'task-1');

    const [, content] = mockWriteFile.mock.calls[0] as [string, string, ...unknown[]];
    const data = JSON.parse(content);

    expect(data.result).toBe(shortResult);
  });

  it('writes to a path containing "last-claude-result"', () => {
    storeLastClaudeResult('output', 'task-1');
    const [path] = mockWriteFile.mock.calls[0] as [string, ...unknown[]];
    expect(path).toContain('last-claude-result');
  });
});

// ─────────────────────────────────────────────────────────────────────
// cacheCodebaseContext — persists codebase summary by project name
// ─────────────────────────────────────────────────────────────────────

describe('cacheCodebaseContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockMkdirSync.mockReturnValue(undefined as never);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('writes the summary content to disk', () => {
    cacheCodebaseContext('/my/project', 'TypeScript monorepo with 3 packages');
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, ...unknown[]];
    expect(content).toBe('TypeScript monorepo with 3 packages');
  });

  it('uses the project directory name in the cache file path', () => {
    cacheCodebaseContext('/my/project', 'summary');
    const [path] = mockWriteFile.mock.calls[0] as [string, ...unknown[]];
    expect(path).toContain('codebase-project.txt');
  });

  it('uses a different path for different projects', () => {
    cacheCodebaseContext('/my/webapp', 'webapp summary');
    const [path] = mockWriteFile.mock.calls[0] as [string, ...unknown[]];
    expect(path).toContain('codebase-webapp.txt');
  });

  it('truncates summaries exceeding MAX_CONTEXT_FILE_BYTES on write', () => {
    const hugeSummary = 'x'.repeat(300 * 1024); // 300 KB
    cacheCodebaseContext('/my/project', hugeSummary);

    const [, content] = mockWriteFile.mock.calls[0] as [string, string, ...unknown[]];
    // Should be truncated to roughly 256 KB (body + truncation notice)
    expect(content.length).toBeLessThan(257 * 1024);
    expect(content.length).toBeLessThan(hugeSummary.length);
    expect(content).toContain('...[truncated');
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildHandoffContext — full orchestration
// ─────────────────────────────────────────────────────────────────────

describe('buildHandoffContext', () => {
  const CWD = '/test/project';

  beforeEach(() => {
    vi.clearAllMocks();
    // Clean slate: no files exist, no conversation
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockReturnValue(undefined as never);
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockImplementation(() => { throw new Error('not found'); });
    mockScanWorkspace.mockReturnValue(makeSnapshot({ cwd: CWD }));
    mockGetCurrentConversationId.mockReturnValue(null);
    mockStatSync.mockReturnValue({ size: 1024 } as never);
  });

  it('returns a HandoffContext with required fields', async () => {
    const ctx = await buildHandoffContext(CWD);
    expect(ctx).toMatchObject({
      conversation: expect.any(Object),
      workspace: expect.any(Object),
      relevantFacts: [],
      timestamp: expect.any(Number),
    });
  });

  it('passes provided memoryFacts through to relevantFacts', async () => {
    const facts = ['Project uses Redis', 'Owner prefers TypeScript'];
    const ctx = await buildHandoffContext(CWD, facts);
    expect(ctx.relevantFacts).toEqual(facts);
  });

  it('includes personality from PERSONALITY.md when it exists', async () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.includes('PERSONALITY.md'),
    );
    mockReadFile.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('PERSONALITY.md')) return 'Sharp and direct';
      throw new Error('not found');
    });

    const ctx = await buildHandoffContext(CWD);
    expect(ctx.personality).toBe('Sharp and direct');
  });

  it('leaves personality undefined when PERSONALITY.md is missing', async () => {
    const ctx = await buildHandoffContext(CWD);
    expect(ctx.personality).toBeUndefined();
  });

  it('skips oversized context files (file-size gate)', async () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && (p.includes('PERSONALITY.md') || p.includes('USER.md')),
    );
    // Return oversized stat for any file
    mockStatSync.mockReturnValue({ size: 300 * 1024 } as never);
    mockReadFile.mockReturnValue('should not be read' as never);

    const ctx = await buildHandoffContext(CWD);
    expect(ctx.personality).toBeUndefined();
    expect(ctx.userProfile).toBeUndefined();
  });

  it('includes user profile from USER.md when it exists', async () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.includes('USER.md'),
    );
    mockReadFile.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('USER.md')) return 'The user, UTC';
      throw new Error('not found');
    });

    const ctx = await buildHandoffContext(CWD);
    expect(ctx.userProfile).toBe('The user, UTC');
  });

  it('includes previousResult when stored result is within 10-minute TTL', async () => {
    const recentTime = Date.now() - 5 * 60 * 1000; // 5 minutes ago
    const stored = JSON.stringify({ result: 'task completed', taskId: 't1', timestamp: recentTime });

    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.includes('last-claude-result.json'),
    );
    mockReadFile.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('last-claude-result.json')) return stored;
      throw new Error('not found');
    });

    const ctx = await buildHandoffContext(CWD);
    expect(ctx.previousResult).toBe('task completed');
  });

  it('excludes previousResult when stored result is older than 10 minutes (TTL expired)', async () => {
    const oldTime = Date.now() - 11 * 60 * 1000; // 11 minutes ago
    const stored = JSON.stringify({ result: 'old result', taskId: 't1', timestamp: oldTime });

    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.includes('last-claude-result.json'),
    );
    mockReadFile.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('last-claude-result.json')) return stored;
      throw new Error('not found');
    });

    const ctx = await buildHandoffContext(CWD);
    expect(ctx.previousResult).toBeUndefined();
  });

  it('sets timestamp to approximately now', async () => {
    const before = Date.now();
    const ctx = await buildHandoffContext(CWD);
    const after = Date.now();
    expect(ctx.timestamp).toBeGreaterThanOrEqual(before);
    expect(ctx.timestamp).toBeLessThanOrEqual(after);
  });

  // ── Tone detection tests (via conversationTone field) ──

  describe('tone detection', () => {
    const setUserMessages = (content: string) => {
      mockGetCurrentConversationId.mockReturnValue('conv-1');
      mockGetRecentMessages.mockResolvedValue([
        makeStoredMessage({ id: '1', conversationId: 'conv-1', type: 'user', content, timestamp: 0 }),
      ]);
    };

    it('detects frustrated tone from "wtf"', async () => {
      setUserMessages('wtf why is this still broken');
      const ctx = await buildHandoffContext(CWD);
      expect(ctx.conversationTone).toContain('frustrated');
    });

    it('detects frustrated tone from "still not working"', async () => {
      setUserMessages('still not working after all that');
      const ctx = await buildHandoffContext(CWD);
      expect(ctx.conversationTone).toContain('frustrated');
    });

    it('detects frustrated tone from "keeps failing"', async () => {
      setUserMessages('this keeps failing every time');
      const ctx = await buildHandoffContext(CWD);
      expect(ctx.conversationTone).toContain('frustrated');
    });

    it('detects urgent tone from "asap"', async () => {
      setUserMessages('please fix this asap it is important');
      const ctx = await buildHandoffContext(CWD);
      expect(ctx.conversationTone).toContain('urgent');
    });

    it('detects urgent tone from "broken in prod"', async () => {
      setUserMessages('broken in prod need this fixed immediately');
      const ctx = await buildHandoffContext(CWD);
      expect(ctx.conversationTone).toContain('urgent');
    });

    it('detects exploratory tone from "what if"', async () => {
      setUserMessages('what if we tried a different approach here');
      const ctx = await buildHandoffContext(CWD);
      expect(ctx.conversationTone).toContain('creative');
    });

    it('detects exploratory tone from "brainstorm"', async () => {
      setUserMessages('let us brainstorm some options');
      const ctx = await buildHandoffContext(CWD);
      expect(ctx.conversationTone).toContain('creative');
    });

    it('returns undefined conversationTone for neutral messages', async () => {
      setUserMessages('please add a button to the login page');
      const ctx = await buildHandoffContext(CWD);
      expect(ctx.conversationTone).toBeUndefined();
    });

    it('returns undefined conversationTone when there are no user messages', async () => {
      mockGetCurrentConversationId.mockReturnValue(null);
      const ctx = await buildHandoffContext(CWD);
      expect(ctx.conversationTone).toBeUndefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// enhanceClaudeCodePrompt — main public API
// ─────────────────────────────────────────────────────────────────────

describe('enhanceClaudeCodePrompt', () => {
  const CWD = '/enhance/project';

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockReturnValue(undefined as never);
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockImplementation(() => { throw new Error('not found'); });
    mockScanWorkspace.mockReturnValue(makeSnapshot({ cwd: CWD }));
    mockGetCurrentConversationId.mockReturnValue(null);
    mockBuildCodingPrompt.mockReturnValue('MOCK_MINIMAL_PROMPT');
    mockStatSync.mockReturnValue({ size: 1024 } as never);
  });

  it('returns the original prompt unchanged', async () => {
    const { prompt } = await enhanceClaudeCodePrompt('refactor the auth module', CWD);
    expect(prompt).toBe('refactor the auth module');
  });

  it('returns a system prompt string', async () => {
    const { systemPrompt } = await enhanceClaudeCodePrompt('task', CWD);
    expect(typeof systemPrompt).toBe('string');
    expect(systemPrompt.length).toBeGreaterThan(0);
  });

  it('includes the handoff section in the system prompt', async () => {
    const { systemPrompt } = await enhanceClaudeCodePrompt('task', CWD);
    expect(systemPrompt).toContain('═══ HANDOFF ═══');
    expect(systemPrompt).toContain('Claude Code');
    expect(systemPrompt).toContain('Mia');
  });

  it('uses "minimal" mode for the coding prompt', async () => {
    await enhanceClaudeCodePrompt('task', CWD);
    expect(mockBuildCodingPrompt).toHaveBeenCalledWith('minimal');
  });

  it('includes the minimal coding prompt in the system prompt', async () => {
    const { systemPrompt } = await enhanceClaudeCodePrompt('task', CWD);
    expect(systemPrompt).toContain('MOCK_MINIMAL_PROMPT');
  });

  it('includes workspace state in the system prompt', async () => {
    const { systemPrompt } = await enhanceClaudeCodePrompt('task', CWD);
    expect(systemPrompt).toContain('WORKSPACE STATE');
  });

  it('passes memoryFacts through to context building', async () => {
    const facts = ['prefer TypeScript', 'no tabs'];
    const { systemPrompt } = await enhanceClaudeCodePrompt('task', CWD, facts);
    expect(systemPrompt).toContain('KNOWN FACTS');
    expect(systemPrompt).toContain('prefer TypeScript');
  });
});

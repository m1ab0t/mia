/**
 * Tests for context/context-manager.ts
 *
 * ContextManager orchestrates all context sources (codebase, personality,
 * workspace, memory, turn-memory, daily logs, tone) and assembles the final
 * system prompt. Getting this right is critical — a broken context manager
 * means every single agent turn gets degraded prompts.
 *
 * Covers:
 *   - init(): successful load, per-source failure resilience, status reporting
 *   - searchTurnMemory(): short-message skip, greeting skip, relevance filtering
 *   - buildSystemPrompt(): coding vs general mode, section ordering, conditional inclusion
 *   - setMode() / getCodebaseContext(): accessor behaviour
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mock objects ───────────────────────────────────────────────────────

const { mockMemoryStore } = vi.hoisted(() => {
  const mockMemoryStore = {
    getRecent: vi.fn<[], Promise<{ type: string; content: string }[]>>().mockResolvedValue([]),
    search: vi.fn<[], Promise<{ content: string; score: number }[]>>().mockResolvedValue([]),
  };
  return { mockMemoryStore };
});

// ── Module mocks (hoisted before any imports) ─────────────────────────────────

vi.mock('../utils/codebase_context', () => ({
  gatherCodebaseContext: vi.fn().mockResolvedValue({ gitBranch: 'main', files: [] }),
  formatContextForPrompt: vi.fn().mockReturnValue('CODEBASE_CONTEXT'),
}));

vi.mock('../utils/personality', () => ({
  loadPersonality: vi.fn().mockResolvedValue('You are MIA.'),
  formatPersonalityForPrompt: vi.fn().mockImplementation((p: string) => `PERSONALITY: ${p}`),
}));

vi.mock('../utils/workspace_context', () => ({
  loadWorkspaceFiles: vi.fn().mockResolvedValue([{ name: 'USER.md', content: 'About Richard' }]),
  formatWorkspaceContext: vi.fn().mockReturnValue('WORKSPACE_CONTEXT'),
}));

vi.mock('./index', () => ({
  refreshWorkspaceContext: vi.fn(),
}));

vi.mock('../memory/daily-log', () => ({
  loadRecentDailyLogs: vi.fn().mockResolvedValue(''),
}));

vi.mock('../memory/index', () => ({
  getMemoryStore: vi.fn().mockReturnValue(mockMemoryStore),
}));

vi.mock('../config', () => ({
  readMiaConfig: vi.fn().mockReturnValue({ useReranker: false }),
}));

vi.mock('../utils/conversation_tone', () => ({
  analyzeConversationTone: vi.fn().mockReturnValue('neutral'),
  formatToneForPrompt: vi.fn().mockReturnValue(''),
}));

vi.mock('../prompts/system_prompts', () => ({
  CODING_SYSTEM_PROMPT: 'CODING_INSTRUCTIONS',
  GENERAL_SYSTEM_PROMPT: 'GENERAL_INSTRUCTIONS',
  CONVERSATION_CONTINUITY_PROMPT: 'CONTINUITY_INSTRUCTIONS',
}));

// ── Import after mocks ─────────────────────────────────────────────────────────

import { ContextManager } from './context-manager';
import { gatherCodebaseContext, formatContextForPrompt } from '../utils/codebase_context';
import { loadPersonality, formatPersonalityForPrompt } from '../utils/personality';
import { loadWorkspaceFiles, formatWorkspaceContext } from '../utils/workspace_context';
import { refreshWorkspaceContext } from './index';
import { loadRecentDailyLogs } from '../memory/daily-log';
import { getMemoryStore } from '../memory/index';
import { readMiaConfig } from '../config';
import { analyzeConversationTone, formatToneForPrompt } from '../utils/conversation_tone';

const mockGatherCodebaseContext = gatherCodebaseContext as ReturnType<typeof vi.fn>;
const mockFormatContextForPrompt = formatContextForPrompt as ReturnType<typeof vi.fn>;
const mockLoadPersonality = loadPersonality as ReturnType<typeof vi.fn>;
const mockFormatPersonality = formatPersonalityForPrompt as ReturnType<typeof vi.fn>;
const mockLoadWorkspaceFiles = loadWorkspaceFiles as ReturnType<typeof vi.fn>;
const mockFormatWorkspaceContext = formatWorkspaceContext as ReturnType<typeof vi.fn>;
const mockRefreshWorkspaceContext = refreshWorkspaceContext as ReturnType<typeof vi.fn>;
const mockLoadRecentDailyLogs = loadRecentDailyLogs as ReturnType<typeof vi.fn>;
const mockGetMemoryStore = getMemoryStore as ReturnType<typeof vi.fn>;
const mockReadMiaConfig = readMiaConfig as ReturnType<typeof vi.fn>;
const mockAnalyzeConversationTone = analyzeConversationTone as ReturnType<typeof vi.fn>;
const mockFormatToneForPrompt = formatToneForPrompt as ReturnType<typeof vi.fn>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeManager(mode: 'coding' | 'general' = 'coding'): ContextManager {
  return new ContextManager({ workingDirectory: '/test/project', mode });
}

// ── init() ────────────────────────────────────────────────────────────────────

describe('ContextManager.init()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPersonality.mockResolvedValue('You are MIA.');
    mockGatherCodebaseContext.mockResolvedValue({ gitBranch: 'main' });
    mockLoadWorkspaceFiles.mockResolvedValue([]);
    mockLoadRecentDailyLogs.mockResolvedValue('');
    mockGetMemoryStore.mockReturnValue(mockMemoryStore);
    mockMemoryStore.getRecent.mockResolvedValue([]);
    mockRefreshWorkspaceContext.mockImplementation(() => {});
  });

  it('initialises without throwing when all sources succeed', async () => {
    const manager = makeManager();
    await expect(manager.init()).resolves.not.toThrow();
  });

  it('returns an array of status strings', async () => {
    const manager = makeManager();
    const status = await manager.init();
    expect(Array.isArray(status)).toBe(true);
  });

  it('includes a workspace snapshot status message on success', async () => {
    const manager = makeManager();
    const status = await manager.init();
    expect(status).toContain('Workspace snapshot created');
  });

  it('includes a daily-logs status message when logs are present', async () => {
    mockLoadRecentDailyLogs.mockResolvedValue('── Today ──\nSome work');
    const manager = makeManager();
    const status = await manager.init();
    expect(status).toContain('Daily logs loaded');
  });

  it('does not include daily-logs status when no logs exist', async () => {
    mockLoadRecentDailyLogs.mockResolvedValue('');
    const manager = makeManager();
    const status = await manager.init();
    expect(status).not.toContain('Daily logs loaded');
  });

  it('continues without error when workspace snapshot throws', async () => {
    mockRefreshWorkspaceContext.mockImplementation(() => { throw new Error('scan failed'); });
    const manager = makeManager();
    await expect(manager.init()).resolves.not.toThrow();
  });

  it('continues without error when loadRecentDailyLogs throws', async () => {
    mockLoadRecentDailyLogs.mockRejectedValue(new Error('fs error'));
    const manager = makeManager();
    await expect(manager.init()).resolves.not.toThrow();
  });

  it('continues without error when memory store throws', async () => {
    mockMemoryStore.getRecent.mockRejectedValue(new Error('lancedb unavailable'));
    const manager = makeManager();
    await expect(manager.init()).resolves.not.toThrow();
  });

  it('calls gatherCodebaseContext with the working directory', async () => {
    const manager = makeManager();
    await manager.init();
    expect(mockGatherCodebaseContext).toHaveBeenCalledWith('/test/project');
  });
});

// ── searchTurnMemory() ────────────────────────────────────────────────────────

describe('ContextManager.searchTurnMemory()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMemoryStore.mockReturnValue(mockMemoryStore);
    mockReadMiaConfig.mockReturnValue({ useReranker: false });
    mockMemoryStore.search.mockResolvedValue([]);
  });

  it('skips memory search for messages with fewer than 5 words', async () => {
    const manager = makeManager();
    await manager.searchTurnMemory('fix bug');
    expect(mockMemoryStore.search).not.toHaveBeenCalled();
  });

  it('skips memory search for single-word messages', async () => {
    const manager = makeManager();
    await manager.searchTurnMemory('hello');
    expect(mockMemoryStore.search).not.toHaveBeenCalled();
  });

  it('skips memory search for bare greeting "hi"', async () => {
    const manager = makeManager();
    await manager.searchTurnMemory('hi');
    expect(mockMemoryStore.search).not.toHaveBeenCalled();
  });

  it('skips memory search for greeting at start of message', async () => {
    const manager = makeManager();
    await manager.searchTurnMemory('hey how are you today');
    expect(mockMemoryStore.search).not.toHaveBeenCalled();
  });

  it('skips memory search for "thanks" prefix', async () => {
    const manager = makeManager();
    await manager.searchTurnMemory('thanks that worked great');
    expect(mockMemoryStore.search).not.toHaveBeenCalled();
  });

  it('performs memory search for substantive messages', async () => {
    mockMemoryStore.search.mockResolvedValue([]);
    const manager = makeManager();
    await manager.searchTurnMemory('refactor the authentication module to use JWT tokens');
    expect(mockMemoryStore.search).toHaveBeenCalledWith(
      'refactor the authentication module to use JWT tokens',
      expect.any(Number),
      expect.any(Boolean)
    );
  });

  it('filters out results below the relevance threshold (0.3)', async () => {
    mockMemoryStore.search.mockResolvedValue([
      { content: 'Low relevance fact', score: 0.1 },
      { content: 'Also low', score: 0.29 },
    ]);
    const manager = makeManager();
    await manager.searchTurnMemory('implement user authentication system with JWT');

    // Build a prompt — turn memory context should be empty
    await manager.init();
    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).not.toContain('Low relevance fact');
    expect(prompt).not.toContain('Also low');
  });

  it('includes results at or above the relevance threshold', async () => {
    mockMemoryStore.search.mockResolvedValue([
      { content: 'Richard uses OAuth for auth', score: 0.75 },
      { content: 'Project uses TypeScript', score: 0.5 },
    ]);
    const manager = makeManager();
    await manager.init();
    await manager.searchTurnMemory('implement user authentication in the application');

    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).toContain('Richard uses OAuth for auth');
  });

  it('limits results to top 3 even when more pass the threshold', async () => {
    mockMemoryStore.search.mockResolvedValue([
      { content: 'Fact A', score: 0.9 },
      { content: 'Fact B', score: 0.8 },
      { content: 'Fact C', score: 0.7 },
      { content: 'Fact D', score: 0.6 },
    ]);
    const manager = makeManager();
    await manager.init();
    await manager.searchTurnMemory('tell me about the authentication and security setup');

    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).toContain('Fact A');
    expect(prompt).toContain('Fact B');
    expect(prompt).toContain('Fact C');
    expect(prompt).not.toContain('Fact D');
  });

  it('continues without error when memory search throws', async () => {
    mockMemoryStore.search.mockRejectedValue(new Error('search index unavailable'));
    const manager = makeManager();
    await expect(
      manager.searchTurnMemory('implement user login with password hashing')
    ).resolves.not.toThrow();
  });
});

// ── buildSystemPrompt() ───────────────────────────────────────────────────────

describe('ContextManager.buildSystemPrompt()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPersonality.mockResolvedValue('You are MIA.');
    mockFormatPersonality.mockImplementation((p: string) => `PERSONALITY: ${p}`);
    mockFormatContextForPrompt.mockReturnValue('CODEBASE_CONTEXT');
    mockFormatWorkspaceContext.mockReturnValue('WORKSPACE_CONTEXT');
    mockGatherCodebaseContext.mockResolvedValue({ gitBranch: 'main' });
    mockLoadWorkspaceFiles.mockResolvedValue([{ name: 'USER.md', content: 'user info' }]);
    mockLoadRecentDailyLogs.mockResolvedValue('');
    mockGetMemoryStore.mockReturnValue(mockMemoryStore);
    mockMemoryStore.getRecent.mockResolvedValue([]);
    mockRefreshWorkspaceContext.mockImplementation(() => {});
    mockReadMiaConfig.mockReturnValue({ useReranker: false });
    mockAnalyzeConversationTone.mockReturnValue('neutral');
    mockFormatToneForPrompt.mockReturnValue('');
  });

  it('includes personality section at the start of the prompt', async () => {
    const manager = makeManager('coding');
    await manager.init();
    const prompt = manager.buildSystemPrompt([]);
    // Personality should appear before the system instructions
    const personalityIdx = prompt.indexOf('PERSONALITY:');
    const instructionsIdx = prompt.indexOf('CODING_INSTRUCTIONS');
    expect(personalityIdx).toBeGreaterThanOrEqual(0);
    expect(personalityIdx).toBeLessThan(instructionsIdx);
  });

  it('includes codebase context in coding mode', async () => {
    const manager = makeManager('coding');
    await manager.init();
    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).toContain('CODEBASE_CONTEXT');
  });

  it('does not include codebase context in general mode', async () => {
    const manager = makeManager('general');
    await manager.init();
    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).not.toContain('CODEBASE_CONTEXT');
  });

  it('uses CODING_SYSTEM_PROMPT in coding mode', async () => {
    const manager = makeManager('coding');
    await manager.init();
    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).toContain('CODING_INSTRUCTIONS');
    expect(prompt).not.toContain('GENERAL_INSTRUCTIONS');
  });

  it('uses GENERAL_SYSTEM_PROMPT in general mode', async () => {
    const manager = makeManager('general');
    await manager.init();
    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).toContain('GENERAL_INSTRUCTIONS');
    expect(prompt).not.toContain('CODING_INSTRUCTIONS');
  });

  it('always appends CONVERSATION_CONTINUITY_PROMPT', async () => {
    for (const mode of ['coding', 'general'] as const) {
      const manager = makeManager(mode);
      await manager.init();
      const prompt = manager.buildSystemPrompt([]);
      expect(prompt).toContain('CONTINUITY_INSTRUCTIONS');
    }
  });

  it('includes daily log section when logs are present', async () => {
    mockLoadRecentDailyLogs.mockResolvedValue('── Today ──\n- Deployed feature X');
    const manager = makeManager('coding');
    await manager.init();
    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).toContain('RECENT ACTIVITY LOG');
    expect(prompt).toContain('Deployed feature X');
  });

  it('omits daily log section when no logs exist', async () => {
    mockLoadRecentDailyLogs.mockResolvedValue('');
    const manager = makeManager('coding');
    await manager.init();
    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).not.toContain('RECENT ACTIVITY LOG');
  });

  it('includes workspace context when files are loaded', async () => {
    mockFormatWorkspaceContext.mockReturnValue('## USER.md\nAbout Richard');
    const manager = makeManager('coding');
    await manager.init();
    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).toContain('About Richard');
  });

  it('includes memory facts in coding mode prompt', async () => {
    mockMemoryStore.getRecent.mockResolvedValue([
      { type: 'fact', content: 'Richard prefers concise commits' },
      { type: 'conversation', content: 'some conversation' }, // non-fact, should be excluded
    ]);
    const manager = makeManager('coding');
    await manager.init();
    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).toContain('Richard prefers concise commits');
    expect(prompt).not.toContain('some conversation');
  });

  it('includes memory facts in general mode prompt', async () => {
    mockMemoryStore.getRecent.mockResolvedValue([
      { type: 'fact', content: 'User is in UTC timezone' },
    ]);
    const manager = makeManager('general');
    await manager.init();
    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).toContain('KNOWN FACTS');
    expect(prompt).toContain('User is in UTC timezone');
  });

  it('omits KNOWN FACTS section when no facts are in memory', async () => {
    mockMemoryStore.getRecent.mockResolvedValue([]);
    const manager = makeManager('coding');
    await manager.init();
    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).not.toContain('KNOWN FACTS');
  });

  it('appends tone hint when tone is non-neutral', async () => {
    mockAnalyzeConversationTone.mockReturnValue('frustrated');
    mockFormatToneForPrompt.mockReturnValue('TONE: User seems frustrated, be concise.');
    const manager = makeManager('coding');
    await manager.init();
    const prompt = manager.buildSystemPrompt([{ role: 'user', content: 'this is broken!' }]);
    expect(prompt).toContain('TONE: User seems frustrated, be concise.');
  });

  it('omits tone hint when tone is neutral', async () => {
    mockAnalyzeConversationTone.mockReturnValue('neutral');
    mockFormatToneForPrompt.mockReturnValue('');
    const manager = makeManager('coding');
    await manager.init();
    const prompt = manager.buildSystemPrompt([]);
    // formatToneForPrompt returning '' means no tone section added
    expect(mockFormatToneForPrompt).toHaveBeenCalledWith('neutral');
  });

  it('combines base memory and turn memory in the prompt', async () => {
    mockMemoryStore.getRecent.mockResolvedValue([
      { type: 'fact', content: 'Base fact about the project' },
    ]);
    mockMemoryStore.search.mockResolvedValue([
      { content: 'Relevant turn fact', score: 0.8 },
    ]);
    const manager = makeManager('coding');
    await manager.init();
    await manager.searchTurnMemory('implement feature with the new authentication approach');

    const prompt = manager.buildSystemPrompt([]);
    expect(prompt).toContain('Base fact about the project');
    expect(prompt).toContain('Relevant turn fact');
    expect(prompt).toContain('Relevant to current message');
  });
});

// ── setMode() / getCodebaseContext() ──────────────────────────────────────────

describe('ContextManager accessors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGatherCodebaseContext.mockResolvedValue({ gitBranch: 'feat/test', files: [] });
    mockLoadPersonality.mockResolvedValue(null);
    mockLoadWorkspaceFiles.mockResolvedValue([]);
    mockLoadRecentDailyLogs.mockResolvedValue('');
    mockGetMemoryStore.mockReturnValue(mockMemoryStore);
    mockMemoryStore.getRecent.mockResolvedValue([]);
    mockRefreshWorkspaceContext.mockImplementation(() => {});
  });

  it('getCodebaseContext() returns null before init()', () => {
    const manager = makeManager();
    expect(manager.getCodebaseContext()).toBeNull();
  });

  it('getCodebaseContext() returns context object after init()', async () => {
    const manager = makeManager();
    await manager.init();
    expect(manager.getCodebaseContext()).not.toBeNull();
    expect(manager.getCodebaseContext()).toMatchObject({ gitBranch: 'feat/test' });
  });

  it('setMode() switches the prompt mode from coding to general', async () => {
    mockFormatContextForPrompt.mockReturnValue('CODEBASE_SECTION');
    mockAnalyzeConversationTone.mockReturnValue('neutral');
    mockFormatToneForPrompt.mockReturnValue('');

    const manager = makeManager('coding');
    await manager.init();

    // Coding mode should include codebase
    const codingPrompt = manager.buildSystemPrompt([]);
    expect(codingPrompt).toContain('CODEBASE_SECTION');

    // Switch to general — codebase should disappear
    manager.setMode('general');
    const generalPrompt = manager.buildSystemPrompt([]);
    expect(generalPrompt).not.toContain('CODEBASE_SECTION');
  });

  it('setMode() switches the prompt mode from general to coding', async () => {
    mockFormatContextForPrompt.mockReturnValue('CODEBASE_SECTION');
    mockAnalyzeConversationTone.mockReturnValue('neutral');
    mockFormatToneForPrompt.mockReturnValue('');

    const manager = makeManager('general');
    await manager.init();

    // General mode: no codebase
    const generalPrompt = manager.buildSystemPrompt([]);
    expect(generalPrompt).not.toContain('CODEBASE_SECTION');

    // Switch to coding — codebase should appear
    manager.setMode('coding');
    const codingPrompt = manager.buildSystemPrompt([]);
    expect(codingPrompt).toContain('CODEBASE_SECTION');
  });
});

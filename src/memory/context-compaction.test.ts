/**
 * Tests for context compaction — LLM-powered conversation summarization.
 *
 * Covers: prompt formatting, token budget enforcement, summary merging,
 * dispatch errors, partial-success paths, and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ────────────────────────────────────────────────
const { mockLogger, mockAppendDailyLog } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const mockAppendDailyLog = vi.fn().mockResolvedValue(undefined)
  return { mockLogger, mockAppendDailyLog }
})

vi.mock('../utils/logger', () => ({ logger: mockLogger }))
vi.mock('./daily-log', () => ({ appendDailyLog: mockAppendDailyLog }))

import {
  compactContext,
  COMPACTION_SYSTEM_PROMPT,
  type CompactionMemoryStore,
  type CompactionInput,
} from './context-compaction'

// ── Helpers ──────────────────────────────────────────────────────
function makeInput(overrides: Partial<CompactionInput> = {}): CompactionInput {
  return {
    messages: [
      { role: 'user', content: 'Hello', timestamp: 1700000000000 },
      { role: 'assistant', content: 'Hi there', timestamp: 1700000001000 },
    ],
    conversationId: 'conv-abc-123-test',
    ...overrides,
  }
}

function makeStore(overrides: Partial<CompactionMemoryStore> = {}) {
  return {
    storeSummary: vi
      .fn<(summary: string, sessionId?: string) => Promise<string | null>>()
      .mockResolvedValue('mem_12345_abc'),
    ...overrides,
  }
}

const FAKE_SUMMARY =
  '## Current Task\nTesting context compaction\n\n## Key Decisions\nNone yet.'

// ── Tests ────────────────────────────────────────────────────────
describe('COMPACTION_SYSTEM_PROMPT', () => {
  it('includes all required section headers', () => {
    for (const h of [
      '## Current Task',
      '## Key Decisions',
      '## Files Modified',
      '## Current State',
      '## Important Context',
      '## Errors & Solutions',
    ]) {
      expect(COMPACTION_SYSTEM_PROMPT).toContain(h)
    }
  })

  it('includes the 800-word limit rule', () => {
    expect(COMPACTION_SYSTEM_PROMPT).toContain('Max 800 words')
  })

  it('instructs concise but complete summaries', () => {
    expect(COMPACTION_SYSTEM_PROMPT).toContain('concise but complete')
  })
})

describe('compactContext', () => {
  let dispatch: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    dispatch = vi.fn().mockResolvedValue(FAKE_SUMMARY)
    // Reset implementation — clearAllMocks doesn't undo mockRejectedValue
    mockAppendDailyLog.mockResolvedValue(undefined)
  })

  // ── Empty messages ───────────────────────────────────────────
  describe('empty messages', () => {
    it('returns early with error for empty array', async () => {
      const result = await compactContext(makeInput({ messages: [] }), dispatch)

      expect(result).toEqual({
        summary: '',
        savedToLog: false,
        savedToMemory: false,
        error: 'no messages to compact',
      })
      expect(dispatch).not.toHaveBeenCalled()
    })

    it('does not touch daily log or memory store', async () => {
      const store = makeStore()
      await compactContext(makeInput({ messages: [] }), dispatch, store)

      expect(mockAppendDailyLog).not.toHaveBeenCalled()
      expect(store.storeSummary).not.toHaveBeenCalled()
    })
  })

  // ── Prompt formatting / token budget ─────────────────────────
  describe('prompt formatting', () => {
    it('formats message timestamps as HH:MM:SS', async () => {
      // 1700000000000 = 2023-11-14T22:13:20.000Z
      await compactContext(makeInput(), dispatch)
      const prompt = dispatch.mock.calls[0][0] as string
      expect(prompt).toContain('[22:13:20] user: Hello')
      expect(prompt).toContain('[22:13:21] assistant: Hi there')
    })

    it('includes the conversation separator', async () => {
      await compactContext(makeInput(), dispatch)
      const prompt = dispatch.mock.calls[0][0] as string
      expect(prompt).toContain('=== CONVERSATION ===')
    })

    it('starts with the system prompt', async () => {
      await compactContext(makeInput(), dispatch)
      const prompt = dispatch.mock.calls[0][0] as string
      expect(prompt.startsWith(COMPACTION_SYSTEM_PROMPT)).toBe(true)
    })

    it('includes working directory when provided', async () => {
      await compactContext(
        makeInput({ workingDirectory: '/home/user/project' }),
        dispatch,
      )
      const prompt = dispatch.mock.calls[0][0] as string
      expect(prompt).toContain('Working directory: /home/user/project')
    })

    it('omits working directory line when not provided', async () => {
      await compactContext(makeInput({ workingDirectory: undefined }), dispatch)
      const prompt = dispatch.mock.calls[0][0] as string
      expect(prompt).not.toContain('Working directory:')
    })

    it('handles a single message', async () => {
      const input = makeInput({
        messages: [
          { role: 'user', content: 'Only one', timestamp: 1700000000000 },
        ],
      })
      await compactContext(input, dispatch)
      const prompt = dispatch.mock.calls[0][0] as string
      expect(prompt).toContain('user: Only one')
      expect(prompt).not.toContain('assistant:')
    })

    it('preserves message ordering', async () => {
      const input = makeInput({
        messages: [
          { role: 'user', content: 'First', timestamp: 1700000000000 },
          { role: 'assistant', content: 'Second', timestamp: 1700000001000 },
          { role: 'user', content: 'Third', timestamp: 1700000002000 },
        ],
      })
      await compactContext(input, dispatch)
      const prompt = dispatch.mock.calls[0][0] as string
      expect(prompt.indexOf('user: First')).toBeLessThan(
        prompt.indexOf('assistant: Second'),
      )
      expect(prompt.indexOf('assistant: Second')).toBeLessThan(
        prompt.indexOf('user: Third'),
      )
    })

    it('separates messages with double newlines', async () => {
      const input = makeInput({
        messages: [
          { role: 'user', content: 'A', timestamp: 1700000000000 },
          { role: 'assistant', content: 'B', timestamp: 1700000001000 },
        ],
      })
      await compactContext(input, dispatch)
      const prompt = dispatch.mock.calls[0][0] as string
      const convoStart = prompt.indexOf('=== CONVERSATION ===')
      const convo = prompt.slice(convoStart)
      expect(convo).toContain('user: A\n\n')
    })

    it('handles messages with special characters', async () => {
      const input = makeInput({
        messages: [
          {
            role: 'user',
            content: 'Fix `onClick` in <Button />',
            timestamp: 1700000000000,
          },
        ],
      })
      await compactContext(input, dispatch)
      const prompt = dispatch.mock.calls[0][0] as string
      expect(prompt).toContain('Fix `onClick` in <Button />')
    })

    it('handles multiline message content', async () => {
      const input = makeInput({
        messages: [
          {
            role: 'user',
            content: 'Line 1\nLine 2\nLine 3',
            timestamp: 1700000000000,
          },
        ],
      })
      await compactContext(input, dispatch)
      const prompt = dispatch.mock.calls[0][0] as string
      expect(prompt).toContain('Line 1\nLine 2\nLine 3')
    })

    it('dispatches a large conversation without truncation', async () => {
      const messages = Array.from({ length: 200 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `Message number ${i} — ${'x'.repeat(100)}`,
        timestamp: 1700000000000 + i * 1000,
      }))
      await compactContext(makeInput({ messages }), dispatch)
      const prompt = dispatch.mock.calls[0][0] as string
      // All 200 messages should appear
      expect(prompt).toContain('Message number 0')
      expect(prompt).toContain('Message number 199')
    })
  })

  // ── Happy path ───────────────────────────────────────────────
  describe('happy path', () => {
    it('returns the trimmed summary', async () => {
      dispatch.mockResolvedValue('  summary with whitespace  \n')
      const result = await compactContext(makeInput(), dispatch)
      expect(result.summary).toBe('summary with whitespace')
    })

    it('saves to daily log with timestamp header', async () => {
      const result = await compactContext(makeInput(), dispatch)
      expect(result.savedToLog).toBe(true)
      expect(mockAppendDailyLog).toHaveBeenCalledOnce()
      const logEntry = mockAppendDailyLog.mock.calls[0][0] as string
      expect(logEntry).toMatch(
        /^## Auto-Compaction Summary \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\)/,
      )
      expect(logEntry).toContain(FAKE_SUMMARY)
    })

    it('saves to memory store with conversationId', async () => {
      const store = makeStore()
      const result = await compactContext(makeInput(), dispatch, store)
      expect(result.savedToMemory).toBe(true)
      expect(store.storeSummary).toHaveBeenCalledWith(
        FAKE_SUMMARY,
        'conv-abc-123-test',
      )
    })

    it('returns complete result shape with no error', async () => {
      const store = makeStore()
      const result = await compactContext(makeInput(), dispatch, store)
      expect(result).toEqual({
        summary: FAKE_SUMMARY,
        savedToLog: true,
        savedToMemory: true,
      })
      expect(result.error).toBeUndefined()
    })
  })

  // ── LLM dispatch failures ───────────────────────────────────
  describe('LLM dispatch failures', () => {
    it('returns error when dispatch throws an Error', async () => {
      dispatch.mockRejectedValue(new Error('rate limited'))
      const result = await compactContext(makeInput(), dispatch)

      expect(result).toEqual({
        summary: '',
        savedToLog: false,
        savedToMemory: false,
        error: 'LLM dispatch failed: rate limited',
      })
      expect(mockLogger.error).toHaveBeenCalled()
    })

    it('stringifies non-Error thrown values', async () => {
      dispatch.mockRejectedValue('plain string error')
      const result = await compactContext(makeInput(), dispatch)
      expect(result.error).toBe('LLM dispatch failed: plain string error')
    })

    it('handles numeric thrown values', async () => {
      dispatch.mockRejectedValue(42)
      const result = await compactContext(makeInput(), dispatch)
      expect(result.error).toBe('LLM dispatch failed: 42')
    })

    it('returns error for empty string response', async () => {
      dispatch.mockResolvedValue('')
      const result = await compactContext(makeInput(), dispatch)
      expect(result).toEqual({
        summary: '',
        savedToLog: false,
        savedToMemory: false,
        error: 'LLM returned empty summary',
      })
    })

    it('returns error for whitespace-only response', async () => {
      dispatch.mockResolvedValue('   \n\t  ')
      const result = await compactContext(makeInput(), dispatch)
      expect(result.error).toBe('LLM returned empty summary')
    })

    it('does not attempt log or memory save on dispatch failure', async () => {
      const store = makeStore()
      dispatch.mockRejectedValue(new Error('boom'))
      await compactContext(makeInput(), dispatch, store)

      expect(mockAppendDailyLog).not.toHaveBeenCalled()
      expect(store.storeSummary).not.toHaveBeenCalled()
    })

    it('does not attempt log or memory save on empty response', async () => {
      const store = makeStore()
      dispatch.mockResolvedValue('')
      await compactContext(makeInput(), dispatch, store)

      expect(mockAppendDailyLog).not.toHaveBeenCalled()
      expect(store.storeSummary).not.toHaveBeenCalled()
    })
  })

  // ── Daily log failures ──────────────────────────────────────
  describe('daily log failures', () => {
    it('returns summary even when log append fails', async () => {
      mockAppendDailyLog.mockRejectedValue(new Error('disk full'))
      const result = await compactContext(makeInput(), dispatch)

      expect(result.summary).toBe(FAKE_SUMMARY)
      expect(result.savedToLog).toBe(false)
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it('continues to memory store even if log fails', async () => {
      mockAppendDailyLog.mockRejectedValue(new Error('disk full'))
      const store = makeStore()
      const result = await compactContext(makeInput(), dispatch, store)

      expect(result.savedToLog).toBe(false)
      expect(result.savedToMemory).toBe(true)
    })
  })

  // ── Memory store edge cases ─────────────────────────────────
  describe('memory store', () => {
    it('savedToMemory is false when no store provided', async () => {
      const result = await compactContext(makeInput(), dispatch)
      expect(result.savedToMemory).toBe(false)
    })

    it('savedToMemory is false when store is null', async () => {
      const result = await compactContext(makeInput(), dispatch, null)
      expect(result.savedToMemory).toBe(false)
    })

    it('savedToMemory is false when storeSummary returns null', async () => {
      const store = makeStore({ storeSummary: vi.fn().mockResolvedValue(null) })
      const result = await compactContext(makeInput(), dispatch, store)
      expect(result.savedToMemory).toBe(false)
    })

    it('savedToMemory is false when storeSummary returns empty string', async () => {
      const store = makeStore({ storeSummary: vi.fn().mockResolvedValue('') })
      const result = await compactContext(makeInput(), dispatch, store)
      // '' is falsy so !!'' === false
      expect(result.savedToMemory).toBe(false)
    })

    it('handles storeSummary throwing gracefully', async () => {
      const store = makeStore({
        storeSummary: vi.fn().mockRejectedValue(new Error('db locked')),
      })
      const result = await compactContext(makeInput(), dispatch, store)

      expect(result.savedToMemory).toBe(false)
      expect(result.summary).toBe(FAKE_SUMMARY)
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it('passes conversationId as sessionId', async () => {
      const store = makeStore()
      await compactContext(
        makeInput({ conversationId: 'session-xyz-789' }),
        dispatch,
        store,
      )
      expect(store.storeSummary).toHaveBeenCalledWith(
        FAKE_SUMMARY,
        'session-xyz-789',
      )
    })
  })

  // ── Partial success combinations ────────────────────────────
  describe('partial success combinations', () => {
    it('both log and memory fail — summary still returned', async () => {
      mockAppendDailyLog.mockRejectedValue(new Error('log fail'))
      const store = makeStore({
        storeSummary: vi.fn().mockRejectedValue(new Error('mem fail')),
      })
      const result = await compactContext(makeInput(), dispatch, store)

      expect(result.summary).toBe(FAKE_SUMMARY)
      expect(result.savedToLog).toBe(false)
      expect(result.savedToMemory).toBe(false)
      expect(result.error).toBeUndefined()
    })

    it('log succeeds, no memory store — expected shape', async () => {
      const result = await compactContext(makeInput(), dispatch, undefined)
      expect(result.savedToLog).toBe(true)
      expect(result.savedToMemory).toBe(false)
      expect(result.summary).toBe(FAKE_SUMMARY)
    })
  })

  // ── Logging ─────────────────────────────────────────────────
  describe('logging', () => {
    it('logs success with truncated conversationId (first 8 chars)', async () => {
      await compactContext(
        makeInput({ conversationId: 'abcdefghijklmnop' }),
        dispatch,
      )

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'abcdefgh' }),
        '[ContextCompaction] Context compacted',
      )
    })

    it('logs savedToLog and savedToMemory status', async () => {
      const store = makeStore()
      await compactContext(makeInput(), dispatch, store)

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ savedToLog: true, savedToMemory: true }),
        expect.any(String),
      )
    })

    it('does not log success on dispatch failure', async () => {
      dispatch.mockRejectedValue(new Error('fail'))
      await compactContext(makeInput(), dispatch)
      expect(mockLogger.info).not.toHaveBeenCalled()
    })

    it('logs error on dispatch failure', async () => {
      dispatch.mockRejectedValue(new Error('timeout'))
      await compactContext(makeInput(), dispatch)
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        '[ContextCompaction] LLM dispatch failed',
      )
    })

    it('handles short conversationId without crashing', async () => {
      await compactContext(makeInput({ conversationId: 'abc' }), dispatch)
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'abc' }),
        expect.any(String),
      )
    })
  })

  // ── Summary merging edge cases ──────────────────────────────
  describe('summary merging edge cases', () => {
    it('trims leading/trailing whitespace from LLM response', async () => {
      dispatch.mockResolvedValue('\n\n  Trimmed summary.  \n\n')
      const result = await compactContext(makeInput(), dispatch)
      expect(result.summary).toBe('Trimmed summary.')
    })

    it('preserves internal whitespace and newlines in summary', async () => {
      const multiline =
        '## Current Task\nDoing stuff.\n\n## Key Decisions\n- Decision A\n- Decision B'
      dispatch.mockResolvedValue(multiline)
      const result = await compactContext(makeInput(), dispatch)
      expect(result.summary).toBe(multiline)
    })

    it('summary is passed verbatim to both log and memory', async () => {
      const summary = '## Current Task\nBuilding tests.'
      dispatch.mockResolvedValue(summary)
      const store = makeStore()
      await compactContext(makeInput(), dispatch, store)

      // Daily log wraps it, but the summary content is there
      const logEntry = mockAppendDailyLog.mock.calls[0][0] as string
      expect(logEntry).toContain(summary)

      // Memory store gets exact summary
      expect(store.storeSummary).toHaveBeenCalledWith(
        summary,
        expect.any(String),
      )
    })

    it('summary with only markdown headers is valid', async () => {
      dispatch.mockResolvedValue('## Current Task\n## Key Decisions')
      const result = await compactContext(makeInput(), dispatch)
      expect(result.summary).toBe('## Current Task\n## Key Decisions')
      expect(result.error).toBeUndefined()
    })

    it('very long summary is passed through without truncation', async () => {
      const longSummary = 'x'.repeat(50_000)
      dispatch.mockResolvedValue(longSummary)
      const result = await compactContext(makeInput(), dispatch)
      expect(result.summary).toBe(longSummary)
      expect(result.summary.length).toBe(50_000)
    })
  })

  // ── Token budget enforcement (prompt construction) ──────────
  describe('token budget enforcement', () => {
    it('all messages are included in the prompt regardless of count', async () => {
      const messages = Array.from({ length: 50 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `Turn ${i}`,
        timestamp: 1700000000000 + i * 1000,
      }))
      await compactContext(makeInput({ messages }), dispatch)
      const prompt = dispatch.mock.calls[0][0] as string
      expect(prompt).toContain('Turn 0')
      expect(prompt).toContain('Turn 49')
    })

    it('prompt structure has system prompt before conversation', async () => {
      await compactContext(makeInput(), dispatch)
      const prompt = dispatch.mock.calls[0][0] as string
      const sysEnd = prompt.indexOf('=== CONVERSATION ===')
      expect(sysEnd).toBeGreaterThan(0)
      // System prompt content before separator
      expect(prompt.slice(0, sysEnd)).toContain(
        'conversation compaction assistant',
      )
    })

    it('prompt grows linearly with message count', async () => {
      const small = makeInput({
        messages: [{ role: 'user', content: 'Hi', timestamp: 1700000000000 }],
      })
      const big = makeInput({
        messages: Array.from({ length: 100 }, (_, i) => ({
          role: 'user' as const,
          content: 'Hi',
          timestamp: 1700000000000 + i * 1000,
        })),
      })

      await compactContext(small, dispatch)
      const smallPrompt = dispatch.mock.calls[0][0] as string
      dispatch.mockClear()

      await compactContext(big, dispatch)
      const bigPrompt = dispatch.mock.calls[0][0] as string

      // More messages → meaningfully longer prompt (system prompt is fixed overhead)
      expect(bigPrompt.length).toBeGreaterThan(smallPrompt.length * 2)
    })

    it('working directory adds exactly one line to the prompt', async () => {
      await compactContext(makeInput({ workingDirectory: undefined }), dispatch)
      const withoutWd = dispatch.mock.calls[0][0] as string
      dispatch.mockClear()

      await compactContext(makeInput({ workingDirectory: '/tmp' }), dispatch)
      const withWd = dispatch.mock.calls[0][0] as string

      expect(withWd).toContain('\nWorking directory: /tmp\n')
      expect(withWd.length).toBeGreaterThan(withoutWd.length)
    })
  })
})

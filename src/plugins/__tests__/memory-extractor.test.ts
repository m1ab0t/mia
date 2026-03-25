/**
 * Tests for MemoryExtractor — auto fact extraction post-dispatch.
 */

import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import { MemoryExtractor, type UtilityDispatchFn } from '../memory-extractor';
import type { PluginDispatchResult } from '../types';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(async () => '{}'),
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => undefined),
  };
});

function makeResult(
  output = 'Refactored auth module into JWT-based flow. Updated auth.ts and tests.',
  success = true,
  durationMs = 10_000,
): PluginDispatchResult {
  return { taskId: 'test-task', success, output, durationMs };
}

function makeStore() {
  const stored: string[] = [];
  return {
    storeFact: vi.fn(async (fact: string, _source?: string) => {
      stored.push(fact);
      return `mem_${stored.length}`;
    }),
    stored,
  };
}

function makeDispatch(response = 'NONE'): UtilityDispatchFn {
  return vi.fn(async () => response);
}

function makeExtractor(
  store: ReturnType<typeof makeStore> | null,
  opts: ConstructorParameters<typeof MemoryExtractor>[1] = {},
  dispatch?: UtilityDispatchFn,
): { extractor: MemoryExtractor; spy: MockInstance } {
  const extractor = new MemoryExtractor(
    store,
    { enabled: true, minDurationMs: 0, ...opts },
    dispatch ?? makeDispatch(),
  );
  const spy = vi.spyOn(extractor, '_callExtractor');
  return { extractor, spy };
}

describe('MemoryExtractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('early-exit guards', () => {
    it('returns immediately when disabled', async () => {
      const store = makeStore();
      const extractor = new MemoryExtractor(store, { enabled: false });
      const result = await extractor.extractAndStore('prompt', makeResult(), 'conv-1');
      expect(result.reason).toContain('disabled');
      expect(result.stored).toBe(0);
      expect(store.storeFact).not.toHaveBeenCalled();
    });

    it('skips when memory store is null', async () => {
      const extractor = new MemoryExtractor(null, { enabled: true });
      const result = await extractor.extractAndStore('prompt', makeResult(), 'conv-1');
      expect(result.reason).toContain('memory store unavailable');
      expect(result.stored).toBe(0);
    });

    it('skips when dispatch was not successful', async () => {
      const { extractor, spy } = makeExtractor(makeStore());
      const result = await extractor.extractAndStore('prompt', makeResult('error', false, 10_000), 'conv-1');
      expect(result.reason).toContain('not successful');
      expect(result.stored).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    });

    it('skips when duration is below threshold', async () => {
      const { extractor, spy } = makeExtractor(makeStore(), { minDurationMs: 5_000 });
      const result = await extractor.extractAndStore('prompt', makeResult('quick', true, 1_000), 'conv-1');
      expect(result.reason).toContain('too short');
      expect(result.stored).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    });

    it('skips when no utility dispatch is available', async () => {
      const store = makeStore();
      const extractor = new MemoryExtractor(store, { enabled: true, minDurationMs: 0 });
      const result = await extractor.extractAndStore('prompt', makeResult(), 'conv-1');
      expect(result.reason).toContain('no utility dispatch');
      expect(result.stored).toBe(0);
    });
  });

  describe('extractAndStore — happy path', () => {
    it('stores facts returned from _callExtractor', async () => {
      const store = makeStore();
      const { extractor, spy } = makeExtractor(store);
      spy.mockResolvedValue(['The project uses pnpm workspaces', 'Tests run with vitest']);

      const result = await extractor.extractAndStore('prompt', makeResult(), 'conv-1');
      expect(result.facts).toHaveLength(2);
      expect(result.stored).toBe(2);
      expect(result.skipped).toBe(0);
      expect(store.storeFact).toHaveBeenCalledTimes(2);
      expect(store.storeFact).toHaveBeenCalledWith('The project uses pnpm workspaces', expect.any(String));
    });

    it('includes conversationId and projectDir in source', async () => {
      const store = makeStore();
      const { extractor, spy } = makeExtractor(store);
      spy.mockResolvedValue(['A meaningful project fact here']);

      await extractor.extractAndStore('prompt', makeResult(), 'conv-abc', '/home/user/myproject');

      const [, source] = store.storeFact.mock.calls[0];
      expect(source).toContain('conv-abc');
      expect(source).toContain('/home/user/myproject');
    });

    it('returns reason when no facts extracted', async () => {
      const store = makeStore();
      const { extractor, spy } = makeExtractor(store);
      spy.mockResolvedValue([]);

      const result = await extractor.extractAndStore('prompt', makeResult(), 'conv-1');
      expect(result.stored).toBe(0);
      expect(result.reason).toContain('no extractable facts');
    });
  });

  describe('deduplication', () => {
    it('assigns a 16-char hash to each extracted fact', async () => {
      const store = makeStore();
      const { extractor, spy } = makeExtractor(store);
      spy.mockResolvedValue(['The project uses TypeScript with strict mode enabled']);

      const result = await extractor.extractAndStore('prompt', makeResult(), 'conv-1');
      expect(result.facts[0].hash).toHaveLength(16);
    });

    it('skips facts whose hash is already in the dedup cache', async () => {
      const { readFile } = await import('fs/promises');

      const { createHash } = await import('crypto');
      const hash = createHash('sha1')
        .update('first fact already seen in cache')
        .digest('hex')
        .substring(0, 16);

      (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ [hash]: true }));

      const store = makeStore();
      const { extractor, spy } = makeExtractor(store);
      spy.mockResolvedValue([
        'first fact already seen in cache',
        'second brand new fact not seen before',
      ]);

      const result = await extractor.extractAndStore('prompt', makeResult(), 'conv-2');
      expect(result.stored).toBe(1);
      expect(result.skipped).toBe(1);
      expect(store.storeFact).toHaveBeenCalledTimes(1);
      expect(store.storeFact.mock.calls[0][0]).toBe('second brand new fact not seen before');
    });

    it('does not store same fact across two calls', async () => {
      const { readFile, writeFile } = await import('fs/promises');
      let savedCache = '{}';
      (readFile as ReturnType<typeof vi.fn>).mockImplementation(async () => savedCache);
      (writeFile as ReturnType<typeof vi.fn>).mockImplementation(async (_path: string, data: string) => {
        savedCache = data;
      });

      const store = makeStore();
      const { extractor, spy } = makeExtractor(store);
      const fact = 'A stable fact that does not change between runs';
      spy.mockResolvedValue([fact]);

      const r1 = await extractor.extractAndStore('prompt', makeResult(), 'conv-3');
      expect(r1.stored).toBe(1);

      const r2 = await extractor.extractAndStore('prompt', makeResult(), 'conv-4');
      expect(r2.stored).toBe(0);
      expect(r2.skipped).toBe(1);
    });
  });

  describe('error handling', () => {
    it('handles _callExtractor errors gracefully', async () => {
      const store = makeStore();
      const { extractor, spy } = makeExtractor(store);
      spy.mockRejectedValue(new Error('plugin dispatch failed'));

      const result = await extractor.extractAndStore('prompt', makeResult(), 'conv-1');
      expect(result.reason).toContain('dispatch error');
      expect(result.stored).toBe(0);
    });

    it('handles store write errors without throwing', async () => {
      const store = makeStore();
      store.storeFact.mockRejectedValue(new Error('memory store write failure'));
      const { extractor, spy } = makeExtractor(store);
      spy.mockResolvedValue(['A valid meaningful fact that should be written to store']);

      const result = await extractor.extractAndStore('prompt', makeResult(), 'conv-1');
      expect(result.stored).toBe(0);
    });
  });

  describe('_callExtractor — response parsing', () => {
    it('strips leading "- " markers from lines', async () => {
      const dispatch = makeDispatch(
        '- TypeScript project with strict mode\n- pnpm workspace manager\n- vitest for testing',
      );
      const extractor = new MemoryExtractor(makeStore(), {}, dispatch);
      const facts = await extractor._callExtractor('prompt', 'output');
      expect(facts).toHaveLength(3);
      expect(facts[0]).toBe('TypeScript project with strict mode');
    });

    it('strips bullet variants and *', async () => {
      const dispatch = makeDispatch(
        '• Bullet fact here long enough\n* Asterisk fact here long enough',
      );
      const extractor = new MemoryExtractor(makeStore(), {}, dispatch);
      const facts = await extractor._callExtractor('prompt', 'output');
      expect(facts.every(f => !f.startsWith('•') && !f.startsWith('*'))).toBe(true);
    });

    it('returns empty array for NONE response', async () => {
      const dispatch = makeDispatch('NONE');
      const extractor = new MemoryExtractor(makeStore(), {}, dispatch);
      const facts = await extractor._callExtractor('prompt', 'output');
      expect(facts).toHaveLength(0);
    });

    it('filters lines shorter than 10 chars', async () => {
      const dispatch = makeDispatch(
        '- ok\n- A valid fact that passes the length filter\n- x',
      );
      const extractor = new MemoryExtractor(makeStore(), {}, dispatch);
      const facts = await extractor._callExtractor('prompt', 'output');
      expect(facts).toHaveLength(1);
      expect(facts[0]).toContain('valid fact');
    });

    it('respects maxFacts limit', async () => {
      const dispatch = makeDispatch(
        '- Fact one is a valid fact\n- Fact two is a valid fact\n- Fact three is a valid fact\n- Fact four is a valid fact',
      );
      const extractor = new MemoryExtractor(makeStore(), { maxFacts: 2 }, dispatch);
      const facts = await extractor._callExtractor('prompt', 'output');
      expect(facts.length).toBeLessThanOrEqual(2);
    });

    it('truncates long prompts and appends ellipsis', async () => {
      let capturedPrompt = '';
      const dispatch: UtilityDispatchFn = vi.fn(async (p: string) => {
        capturedPrompt = p;
        return 'NONE';
      });

      const extractor = new MemoryExtractor(makeStore(), { promptCharLimit: 50 }, dispatch);
      await extractor._callExtractor('X'.repeat(200), 'output');

      expect(capturedPrompt).toContain('…');
      expect(capturedPrompt.match(/X{200}/)).toBeNull();
    });

    it('truncates long outputs', async () => {
      let capturedPrompt = '';
      const dispatch: UtilityDispatchFn = vi.fn(async (p: string) => {
        capturedPrompt = p;
        return 'NONE';
      });

      const extractor = new MemoryExtractor(makeStore(), { outputCharLimit: 50 }, dispatch);
      await extractor._callExtractor('short prompt', 'Y'.repeat(300));

      expect(capturedPrompt).toContain('…');
      expect(capturedPrompt.match(/Y{300}/)).toBeNull();
    });

    it('propagates dispatch errors', async () => {
      const dispatch: UtilityDispatchFn = vi.fn(async () => {
        throw new Error('network error');
      });

      const extractor = new MemoryExtractor(makeStore(), {}, dispatch);
      await expect(extractor._callExtractor('prompt', 'output')).rejects.toThrow('network error');
    });
  });

  describe('setUtilityDispatch', () => {
    it('allows wiring dispatch after construction', async () => {
      const store = makeStore();
      const extractor = new MemoryExtractor(store, { enabled: true, minDurationMs: 0 });

      // Before wiring — should skip
      const r1 = await extractor.extractAndStore('prompt', makeResult(), 'conv-1');
      expect(r1.reason).toContain('no utility dispatch');

      // Wire it up
      const dispatch = vi.fn(async () => '- A fact extracted via late-bound dispatch');
      extractor.setUtilityDispatch(dispatch);

      const r2 = await extractor.extractAndStore('prompt', makeResult(), 'conv-2');
      expect(r2.stored).toBe(1);
      expect(dispatch).toHaveBeenCalled();
    });
  });
});

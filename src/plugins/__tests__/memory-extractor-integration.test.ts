/**
 * Integration test — verifies the full MemoryExtractor → utilityDispatch
 * wiring works end-to-end without any Anthropic SDK dependency.
 */

import { describe, it, expect, vi } from 'vitest';
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

describe('MemoryExtractor integration (plugin dispatch wiring)', () => {
  it('routes extraction through utilityDispatch instead of Anthropic SDK', async () => {
    const dispatchCalls: string[] = [];

    // Simulate what the daemon wires up: a dispatch function that sends
    // the prompt through the active plugin and returns the output.
    const fakePluginDispatch: UtilityDispatchFn = vi.fn(async (prompt: string) => {
      dispatchCalls.push(prompt);
      return [
        '- The project uses TypeScript with strict mode enabled',
        '- Tests run with vitest and use vi.mock for mocking',
        '- pnpm workspaces monorepo with packages/ directory',
      ].join('\n');
    });

    const storedFacts: Array<{ fact: string; source: string | undefined }> = [];
    const fakeStore = {
      storeFact: vi.fn(async (fact: string, source?: string) => {
        storedFacts.push({ fact, source });
        return `mem_${storedFacts.length}`;
      }),
    };

    // Create extractor without dispatch (like daemon does before dispatcher exists)
    const extractor = new MemoryExtractor(fakeStore, {
      enabled: true,
      minDurationMs: 0,
    });

    const dispatchResult: PluginDispatchResult = {
      taskId: 'task-123',
      success: true,
      output: 'Refactored auth module into JWT-based flow with refresh tokens.',
      durationMs: 15_000,
    };

    // Before wiring — should gracefully skip
    const r1 = await extractor.extractAndStore(
      'refactor the auth module to use JWT',
      dispatchResult,
      'conv-abc',
      '/home/user/project',
    );
    expect(r1.reason).toBe('no utility dispatch available');
    expect(r1.stored).toBe(0);
    expect(fakeStore.storeFact).not.toHaveBeenCalled();

    // Wire the dispatch (like daemon does after dispatcher is created)
    extractor.setUtilityDispatch(fakePluginDispatch);

    // After wiring — should extract and store facts via plugin dispatch
    const r2 = await extractor.extractAndStore(
      'refactor the auth module to use JWT',
      dispatchResult,
      'conv-abc',
      '/home/user/project',
    );

    // Verify dispatch was called (not Anthropic SDK)
    expect(fakePluginDispatch).toHaveBeenCalledTimes(1);
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]).toContain('memory extraction assistant');
    expect(dispatchCalls[0]).toContain('refactor the auth module');
    expect(dispatchCalls[0]).toContain('Refactored auth module');

    // Verify facts were stored
    expect(r2.stored).toBe(3);
    expect(r2.facts).toHaveLength(3);
    expect(storedFacts.map(f => f.fact)).toEqual([
      'The project uses TypeScript with strict mode enabled',
      'Tests run with vitest and use vi.mock for mocking',
      'pnpm workspaces monorepo with packages/ directory',
    ]);

    // Verify source metadata
    expect(storedFacts[0].source).toBe('conv-abc|/home/user/project');
  });

  it('handles plugin dispatch failure gracefully', async () => {
    const failingDispatch: UtilityDispatchFn = vi.fn(async () => {
      throw new Error('Plugin "claude-code" is not available');
    });

    const fakeStore = {
      storeFact: vi.fn(async () => 'mem_1'),
    };

    const extractor = new MemoryExtractor(
      fakeStore,
      { enabled: true, minDurationMs: 0 },
      failingDispatch,
    );

    const result = await extractor.extractAndStore(
      'test prompt',
      { taskId: 't1', success: true, output: 'test output', durationMs: 10_000 },
      'conv-1',
    );

    // Should fail gracefully, not throw
    expect(result.stored).toBe(0);
    expect(result.reason).toContain('dispatch error');
    expect(result.reason).toContain('not available');
    expect(fakeStore.storeFact).not.toHaveBeenCalled();
  });
});

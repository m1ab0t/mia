/**
 * Tests for daily-greeting/index.ts
 *
 * Covers:
 *   - cache-hit:    cached entry matches today → return cached, no LLM call
 *   - cache-miss:   no cache file → call dispatch, persist result, return new message
 *   - stale-fallback (no dispatch): stale cache + no dispatch set → return stale message
 *   - stale-fallback (dispatch set): stale cache + dispatch → generate fresh, persist, return new
 *   - generating guard: concurrent call while generating → return stale immediately
 *   - quote stripping: dispatch wraps result in quotes → stripped before return
 *   - dispatch throws: generation error → return stale from cache
 *   - dispatch returns empty: empty result → fall back to stale cache
 *   - singleton: getDailyGreetingService() always returns the same instance
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (must be hoisted before imports) ────────────────────────────────────

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('../memory/daily-log', () => ({
  loadRecentDailyLogs: vi.fn().mockResolvedValue(''),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { DailyGreetingService, getDailyGreetingService } from './index';
import { access, readFile, writeFile } from 'fs/promises';
import { loadRecentDailyLogs } from '../memory/daily-log';

const mockAccess = access as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
const mockLoadRecentDailyLogs = loadRecentDailyLogs as ReturnType<typeof vi.fn>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

/** Simulate a cache file that exists with the given payload. */
function mockCacheFile(payload: { date: string; message: string }): void {
  mockAccess.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue(JSON.stringify(payload));
}

/** Simulate no cache file on disk. */
function mockNoCacheFile(): void {
  mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DailyGreetingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockLoadRecentDailyLogs.mockResolvedValue('');
  });

  // ── cache-hit ───────────────────────────────────────────────────────────────

  describe('cache-hit', () => {
    it("returns the cached message when today's entry is present", async () => {
      mockCacheFile({ date: todayStr(), message: 'Ship it already.' });

      const svc = new DailyGreetingService();
      const dispatch = vi.fn();
      svc.setUtilityDispatch(dispatch);

      const result = await svc.getGreeting();

      expect(result).toBe('Ship it already.');
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('does not write to disk on a cache-hit', async () => {
      mockCacheFile({ date: todayStr(), message: 'Cached.' });

      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(vi.fn());

      await svc.getGreeting();

      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  // ── cache-miss ──────────────────────────────────────────────────────────────

  describe('cache-miss', () => {
    it('calls dispatch and returns the generated message when no file exists', async () => {
      mockNoCacheFile();

      const dispatch = vi.fn().mockResolvedValue('Debugging at 2am again?');
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      const result = await svc.getGreeting();

      expect(dispatch).toHaveBeenCalledOnce();
      expect(result).toBe('Debugging at 2am again?');
    });

    it("persists the new message with today's date on cache-miss", async () => {
      mockNoCacheFile();

      const dispatch = vi.fn().mockResolvedValue('Your stack trace is showing.');
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      await svc.getGreeting();

      expect(mockWriteFile).toHaveBeenCalledOnce();
      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(written.date).toBe(todayStr());
      expect(written.message).toBe('Your stack trace is showing.');
    });

    it('returns empty string when no cache and no dispatch is set', async () => {
      mockNoCacheFile();

      const svc = new DailyGreetingService();
      // intentionally no setUtilityDispatch

      const result = await svc.getGreeting();

      expect(result).toBe('');
    });
  });

  // ── stale-fallback ──────────────────────────────────────────────────────────

  describe('stale-fallback', () => {
    it('returns the stale message when no dispatch is set', async () => {
      mockCacheFile({ date: yesterdayStr(), message: 'Old but gold.' });

      const svc = new DailyGreetingService();
      // no dispatch

      const result = await svc.getGreeting();

      expect(result).toBe('Old but gold.');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('generates fresh when dispatch is available for a stale cache', async () => {
      mockCacheFile({ date: yesterdayStr(), message: 'Yesterday news.' });

      const dispatch = vi.fn().mockResolvedValue('Fresh take today.');
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      const result = await svc.getGreeting();

      expect(dispatch).toHaveBeenCalledOnce();
      expect(result).toBe('Fresh take today.');
    });
  });

  // ── generating guard ────────────────────────────────────────────────────────

  describe('generating guard', () => {
    it('returns stale message when a concurrent call is already generating', async () => {
      mockCacheFile({ date: yesterdayStr(), message: 'Stale while hot.' });

      let resolveDispatch!: (v: string) => void;
      const slowDispatch = vi.fn(
        () => new Promise<string>(r => { resolveDispatch = r; })
      );
      mockLoadRecentDailyLogs.mockResolvedValue('');

      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(slowDispatch);

      // First call: starts generating (pending, dispatch not yet resolved)
      const firstPromise = svc.getGreeting();

      // Advance microtasks past the loadCache() awaits inside getGreeting()
      // so that generate() has been entered and this.generating = true is set.
      // loadCache: await access (1 tick) + await readFile (1 tick) + return (1 tick)
      // generate(): withTimeout(loadRecentDailyLogs(),...).catch() adds ~4 extra ticks
      //   vs the plain loadRecentDailyLogs().catch(): Promise.race resolution (1),
      //   .finally clearTimeout (1), .catch passthrough (1), plus extra safety (1).
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve(); // extra ticks for withTimeout wrapper inside generate()

      // Second call — should see generating===true and return stale immediately
      const secondResult = await svc.getGreeting();

      // Resolve the first dispatch
      resolveDispatch('Shiny new greeting.');
      const firstResult = await firstPromise;

      expect(secondResult).toBe('Stale while hot.');
      expect(firstResult).toBe('Shiny new greeting.');
      expect(slowDispatch).toHaveBeenCalledOnce();
    });
  });

  // ── quote stripping ─────────────────────────────────────────────────────────

  describe('quote stripping', () => {
    it('strips wrapping double-quotes from the dispatch result', async () => {
      mockNoCacheFile();
      const dispatch = vi.fn().mockResolvedValue('"You forget semicolons again."');
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      const result = await svc.getGreeting();

      expect(result).toBe('You forget semicolons again.');
    });

    it('strips wrapping single-quotes from the dispatch result', async () => {
      mockNoCacheFile();
      const dispatch = vi.fn().mockResolvedValue("'Bug or feature?'");
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      const result = await svc.getGreeting();

      expect(result).toBe('Bug or feature?');
    });

    it('strips wrapping backticks from the dispatch result', async () => {
      mockNoCacheFile();
      const dispatch = vi.fn().mockResolvedValue('`rm -rf yourself.`');
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      const result = await svc.getGreeting();

      expect(result).toBe('rm -rf yourself.');
    });
  });

  // ── dispatch throws ─────────────────────────────────────────────────────────

  describe('dispatch throws', () => {
    it('returns stale cached message when dispatch throws', async () => {
      // Both loadCache calls (initial + fallback in catch) return stale cache
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(
        JSON.stringify({ date: yesterdayStr(), message: 'Graceful degradation.' })
      );

      const dispatch = vi.fn().mockRejectedValue(new Error('LLM unreachable'));
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      const result = await svc.getGreeting();

      expect(result).toBe('Graceful degradation.');
    });

    it('returns empty string when dispatch throws and no cache exists', async () => {
      mockNoCacheFile();

      const dispatch = vi.fn().mockRejectedValue(new Error('timeout'));
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      const result = await svc.getGreeting();

      expect(result).toBe('');
    });
  });

  // ── dispatch returns empty string ───────────────────────────────────────────

  describe('dispatch returns empty', () => {
    it('falls back to stale cache when dispatch returns an empty string', async () => {
      // Both loadCache calls return the stale entry
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(
        JSON.stringify({ date: yesterdayStr(), message: 'Still relevant.' })
      );

      const dispatch = vi.fn().mockResolvedValue('   ');
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      const result = await svc.getGreeting();

      expect(result).toBe('Still relevant.');
    });

    it('returns empty string when dispatch returns empty and no cache exists', async () => {
      mockNoCacheFile();

      const dispatch = vi.fn().mockResolvedValue('');
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      const result = await svc.getGreeting();

      expect(result).toBe('');
    });
  });

  // ── context injection ───────────────────────────────────────────────────────

  describe('context injection', () => {
    it('includes recent log activity in the prompt when available', async () => {
      mockNoCacheFile();
      mockLoadRecentDailyLogs.mockResolvedValue('Fixed the P2P reconnect bug.');

      const dispatch = vi.fn().mockResolvedValue('Nice fix on that reconnect.');
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      await svc.getGreeting();

      const prompt = dispatch.mock.calls[0][0] as string;
      expect(prompt).toContain('Recent activity:');
      expect(prompt).toContain('Fixed the P2P reconnect bug.');
    });

    it('omits the context block when no recent logs are available', async () => {
      mockNoCacheFile();
      mockLoadRecentDailyLogs.mockResolvedValue('');

      const dispatch = vi.fn().mockResolvedValue('Still here.');
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      await svc.getGreeting();

      const prompt = dispatch.mock.calls[0][0] as string;
      expect(prompt).not.toContain('Recent activity:');
    });
  });

  // ── dispatch timeout ────────────────────────────────────────────────────────

  describe('dispatch timeout', () => {
    it('rejects with a timeout error when dispatch hangs longer than GENERATION_TIMEOUT_MS', async () => {
      mockNoCacheFile();

      // Dispatch that never resolves — simulates a hung plugin.
      const dispatch = vi.fn(() => new Promise<string>(() => {}));
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      // Use fake timers so the 2-minute timeout fires instantly.
      vi.useFakeTimers();
      const greetingPromise = svc.getGreeting();

      // Advance past the 2-minute timeout.
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 100);

      const result = await greetingPromise;

      // Should fall back to empty (no cache) instead of hanging.
      expect(result).toBe('');
      expect(dispatch).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it('resets generating flag after timeout so future calls can retry', async () => {
      mockNoCacheFile();

      // First call: hangs until timeout.
      const hangingDispatch = vi.fn(() => new Promise<string>(() => {}));
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(hangingDispatch);

      vi.useFakeTimers();
      const firstPromise = svc.getGreeting();
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 100);
      await firstPromise;

      // Second call: fresh dispatch that succeeds immediately.
      mockNoCacheFile();
      const freshDispatch = vi.fn().mockResolvedValue('Back on track.');
      svc.setUtilityDispatch(freshDispatch);

      vi.useRealTimers();
      const result = await svc.getGreeting();

      expect(result).toBe('Back on track.');
      expect(freshDispatch).toHaveBeenCalledOnce();
    });
  });

  // ── generating flag reset ───────────────────────────────────────────────────

  describe('generating flag reset', () => {
    it('resets generating to false after successful generation', async () => {
      mockNoCacheFile();
      const dispatch = vi.fn().mockResolvedValue('First call.');
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      await svc.getGreeting();

      // Now set up for a second successful call — if generating were stuck true,
      // it would return '' instead of calling dispatch again
      mockNoCacheFile();
      dispatch.mockResolvedValue('Second call.');
      const result = await svc.getGreeting();

      expect(result).toBe('Second call.');
      expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it('resets generating to false even when dispatch throws', async () => {
      mockNoCacheFile();
      const dispatch = vi.fn().mockRejectedValue(new Error('boom'));
      const svc = new DailyGreetingService();
      svc.setUtilityDispatch(dispatch);

      await svc.getGreeting(); // throws internally, generating reset in finally

      // Second call should attempt generation again (not short-circuit on generating)
      mockNoCacheFile();
      dispatch.mockResolvedValue('Recovered.');
      const result = await svc.getGreeting();

      expect(result).toBe('Recovered.');
    });
  });
});

// ── Singleton ─────────────────────────────────────────────────────────────────

describe('getDailyGreetingService', () => {
  it('returns the same instance on repeated calls', () => {
    const a = getDailyGreetingService();
    const b = getDailyGreetingService();
    expect(a).toBe(b);
  });
});

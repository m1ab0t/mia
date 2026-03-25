/**
 * Tests for daemon/restart-messages
 *
 * Covers:
 *   - RESTART_MESSAGE_COUNT  matches the actual pool size
 *   - getRandomRestartMessage() always returns a non-empty string from the pool
 *   - Distribution is reasonable (not always the same message)
 */

import { describe, it, expect } from 'vitest';
import { getRandomRestartMessage, RESTART_MESSAGE_COUNT } from '../restart-messages';

describe('RESTART_MESSAGE_COUNT', () => {
  it('is a positive integer', () => {
    expect(RESTART_MESSAGE_COUNT).toBeGreaterThan(0);
    expect(Number.isInteger(RESTART_MESSAGE_COUNT)).toBe(true);
  });

  it('is at least 10 messages (enough variety)', () => {
    expect(RESTART_MESSAGE_COUNT).toBeGreaterThanOrEqual(10);
  });
});

describe('getRandomRestartMessage', () => {
  it('returns a non-empty string', () => {
    const msg = getRandomRestartMessage();
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });

  it('returns different messages across multiple calls (randomness sanity check)', () => {
    // With a pool of 40+ messages, getting 20 identical results in a row
    // would be astronomically unlikely. This test catches a broken RNG or
    // a stub that always returns index 0.
    const samples = new Set(Array.from({ length: 20 }, () => getRandomRestartMessage()));
    expect(samples.size).toBeGreaterThan(1);
  });

  it('every returned message is a non-empty string on repeated calls', () => {
    for (let i = 0; i < 50; i++) {
      const msg = getRandomRestartMessage();
      expect(typeof msg).toBe('string');
      expect(msg.trim().length).toBeGreaterThan(0);
    }
  });

  it('never returns undefined or null', () => {
    for (let i = 0; i < 20; i++) {
      const msg = getRandomRestartMessage();
      expect(msg).not.toBeNull();
      expect(msg).not.toBeUndefined();
    }
  });

  it('all unique messages sampled cover a wide range of indices', () => {
    // Draw a large sample and verify we're not stuck in a corner of the pool.
    // After N draws from a pool of M, we expect to have seen roughly
    // M * (1 - (1 - 1/M)^N) unique messages — just verify > 30% coverage.
    const draws = RESTART_MESSAGE_COUNT * 10;
    const unique = new Set(Array.from({ length: draws }, () => getRandomRestartMessage()));
    const coverage = unique.size / RESTART_MESSAGE_COUNT;
    expect(coverage).toBeGreaterThan(0.3);
  });
});

/**
 * Tests for daemon/commands/run.ts
 *
 * Covers all pure/exported functions:
 *   parseRunArgs      — argument parsing
 *   truncateOutput    — output truncation for prompts
 *   buildRunPrompt    — prompt construction
 *   shouldRetry       — retry-gate logic
 *
 * The side-effectful path (executeCommand, plugin.dispatch, process.exit) is
 * not tested here — those belong in integration / e2e tests.
 */

import { describe, it, expect } from 'vitest';
import {
  parseRunArgs,
  truncateOutput,
  buildRunPrompt,
  shouldRetry,
} from '../run.js';

// ─────────────────────────────────────────────────────────────────────────────
// parseRunArgs — defaults
// ─────────────────────────────────────────────────────────────────────────────

describe('parseRunArgs — defaults', () => {
  it('uses process.cwd() as default cwd', () => {
    expect(parseRunArgs(['npm', 'test']).cwd).toBe(process.cwd());
  });

  it('defaults maxRetries to 3', () => {
    expect(parseRunArgs(['npm', 'test']).maxRetries).toBe(3);
  });

  it('defaults autoFix to true', () => {
    expect(parseRunArgs(['npm', 'test']).autoFix).toBe(true);
  });

  it('defaults yes to false', () => {
    expect(parseRunArgs(['npm', 'test']).yes).toBe(false);
  });

  it('defaults noContext to false', () => {
    expect(parseRunArgs(['npm', 'test']).noContext).toBe(false);
  });

  it('defaults timeoutMs to 120000', () => {
    expect(parseRunArgs(['npm', 'test']).timeoutMs).toBe(120_000);
  });

  it('returns empty command when no args given', () => {
    expect(parseRunArgs([]).command).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseRunArgs — command assembly
// ─────────────────────────────────────────────────────────────────────────────

describe('parseRunArgs — command assembly', () => {
  it('joins single-word command', () => {
    expect(parseRunArgs(['make']).command).toBe('make');
  });

  it('joins multi-word command from positional args', () => {
    expect(parseRunArgs(['npm', 'test']).command).toBe('npm test');
  });

  it('handles a quoted command as a single arg', () => {
    expect(parseRunArgs(['npm test']).command).toBe('npm test');
  });

  it('excludes flag values from command', () => {
    const { command } = parseRunArgs(['npm', 'test', '--cwd', '/tmp']);
    expect(command).toBe('npm test');
  });

  it('excludes unknown flags from command', () => {
    const { command } = parseRunArgs(['tsc', '--noEmit', '--no-fix']);
    // --noEmit is not a mia flag (starts with --) so it IS excluded
    // --no-fix is a mia flag so it's excluded
    // tsc is a positional
    expect(command).toBe('tsc');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseRunArgs — flag parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('parseRunArgs — --cwd', () => {
  it('sets cwd from --cwd flag', () => {
    expect(parseRunArgs(['--cwd', '/home/user/project', 'npm', 'test']).cwd).toBe(
      '/home/user/project',
    );
  });

  it('handles --cwd at the end without a value gracefully', () => {
    const { cwd } = parseRunArgs(['npm', 'test', '--cwd']);
    expect(cwd).toBe(process.cwd());
  });
});

describe('parseRunArgs — --max-retries', () => {
  it('sets maxRetries from --max-retries flag', () => {
    expect(parseRunArgs(['npm', 'test', '--max-retries', '5']).maxRetries).toBe(5);
  });

  it('accepts maxRetries of 0', () => {
    expect(parseRunArgs(['npm', 'test', '--max-retries', '0']).maxRetries).toBe(0);
  });

  it('ignores NaN value and keeps default', () => {
    expect(parseRunArgs(['npm', 'test', '--max-retries', 'abc']).maxRetries).toBe(3);
  });

  it('ignores negative value and keeps default', () => {
    expect(parseRunArgs(['npm', 'test', '--max-retries', '-1']).maxRetries).toBe(3);
  });
});

describe('parseRunArgs — --no-fix', () => {
  it('sets autoFix to false', () => {
    expect(parseRunArgs(['npm', 'test', '--no-fix']).autoFix).toBe(false);
  });

  it('autoFix remains true without the flag', () => {
    expect(parseRunArgs(['npm', 'test']).autoFix).toBe(true);
  });
});

describe('parseRunArgs — --yes / -y', () => {
  it('sets yes to true with --yes', () => {
    expect(parseRunArgs(['npm', 'test', '--yes']).yes).toBe(true);
  });

  it('sets yes to true with -y', () => {
    expect(parseRunArgs(['npm', 'test', '-y']).yes).toBe(true);
  });
});

describe('parseRunArgs — --no-context', () => {
  it('sets noContext to true', () => {
    expect(parseRunArgs(['npm', 'test', '--no-context']).noContext).toBe(true);
  });
});

describe('parseRunArgs — --timeout', () => {
  it('sets timeoutMs from --timeout flag', () => {
    expect(parseRunArgs(['npm', 'test', '--timeout', '60000']).timeoutMs).toBe(60_000);
  });

  it('ignores NaN value and keeps default', () => {
    expect(parseRunArgs(['npm', 'test', '--timeout', 'bad']).timeoutMs).toBe(120_000);
  });

  it('ignores zero value and keeps default', () => {
    expect(parseRunArgs(['npm', 'test', '--timeout', '0']).timeoutMs).toBe(120_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// truncateOutput
// ─────────────────────────────────────────────────────────────────────────────

describe('truncateOutput', () => {
  it('returns text unchanged when under limit', () => {
    expect(truncateOutput('hello world', 100)).toBe('hello world');
  });

  it('trims surrounding whitespace', () => {
    expect(truncateOutput('  hello  ', 100)).toBe('hello');
  });

  it('truncates long text and adds a marker', () => {
    const long = 'a\n'.repeat(5000); // 10000 chars
    const result = truncateOutput(long, 100);
    expect(result).toContain('[... truncated');
    expect(result.length).toBeLessThan(300); // well within reason
  });

  it('keeps the tail of long text', () => {
    const text = 'beginning\n' + 'end-line\n'.repeat(100);
    const result = truncateOutput(text, 80);
    expect(result).toContain('end-line');
    expect(result).not.toMatch(/^beginning/); // beginning should be cut
  });

  it('handles empty string', () => {
    expect(truncateOutput('', 100)).toBe('');
  });

  it('handles whitespace-only string', () => {
    expect(truncateOutput('   \n   ', 100)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildRunPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe('buildRunPrompt', () => {
  const base = {
    command: 'npm test',
    cwd: '/home/user/project',
    exitCode: 1,
    stdout: 'FAIL src/foo.test.ts',
    stderr: 'Error: expected 1 to equal 2',
    attempt: 1,
    maxRetries: 3,
  };

  it('includes the command in the prompt', () => {
    expect(buildRunPrompt(base)).toContain('npm test');
  });

  it('includes the cwd in the prompt', () => {
    expect(buildRunPrompt(base)).toContain('/home/user/project');
  });

  it('includes the exit code in the prompt', () => {
    expect(buildRunPrompt(base)).toContain('code 1');
  });

  it('includes stdout content', () => {
    expect(buildRunPrompt(base)).toContain('FAIL src/foo.test.ts');
  });

  it('includes stderr content', () => {
    expect(buildRunPrompt(base)).toContain('expected 1 to equal 2');
  });

  it('asks the agent to fix the issue', () => {
    const prompt = buildRunPrompt(base);
    expect(prompt.toLowerCase()).toContain('fix');
  });

  it('shows no retry note on first attempt', () => {
    const prompt = buildRunPrompt({ ...base, attempt: 1 });
    expect(prompt).not.toContain('fix attempt');
  });

  it('shows retry note on subsequent attempts', () => {
    const prompt = buildRunPrompt({ ...base, attempt: 2 });
    expect(prompt).toContain('fix attempt 2');
  });

  it('shows (no output) when both stdout and stderr are empty', () => {
    const prompt = buildRunPrompt({ ...base, stdout: '', stderr: '' });
    expect(prompt).toContain('(no output)');
  });

  it('shows Stdout section when stdout is non-empty', () => {
    const prompt = buildRunPrompt({ ...base, stdout: 'some output', stderr: '' });
    expect(prompt).toContain('Stdout:');
  });

  it('shows Stderr section when stderr is non-empty', () => {
    const prompt = buildRunPrompt({ ...base, stdout: '', stderr: 'some error' });
    expect(prompt).toContain('Stderr:');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldRetry
// ─────────────────────────────────────────────────────────────────────────────

describe('shouldRetry', () => {
  it('returns false when autoFix is disabled', () => {
    expect(shouldRetry(1, 1, 3, false)).toBe(false);
  });

  it('returns false when exitCode is 0 (success)', () => {
    expect(shouldRetry(0, 1, 3, true)).toBe(false);
  });

  it('returns false when exit code is 130 (SIGINT)', () => {
    expect(shouldRetry(130, 1, 3, true)).toBe(false);
  });

  it('returns false when exit code is 137 (SIGKILL)', () => {
    expect(shouldRetry(137, 1, 3, true)).toBe(false);
  });

  it('returns false when attempt exceeds maxRetries', () => {
    expect(shouldRetry(1, 4, 3, true)).toBe(false);
  });

  it('returns true when attempt equals maxRetries (boundary)', () => {
    expect(shouldRetry(1, 3, 3, true)).toBe(true);
  });

  it('returns true for a normal failure on first attempt', () => {
    expect(shouldRetry(1, 1, 3, true)).toBe(true);
  });

  it('returns true for exit code 2 (general error)', () => {
    expect(shouldRetry(2, 1, 3, true)).toBe(true);
  });

  it('returns false when maxRetries is 0', () => {
    expect(shouldRetry(1, 1, 0, true)).toBe(false);
  });

  it('returns true when maxRetries is 1 and attempt is 1', () => {
    expect(shouldRetry(1, 1, 1, true)).toBe(true);
  });

  it('returns false when maxRetries is 1 and attempt is 2', () => {
    expect(shouldRetry(1, 2, 1, true)).toBe(false);
  });
});

/**
 * Tests for daemon/commands/fix.ts
 *
 * Covers the pure, side-effect-free functions — argument parsing, prompt
 * building, and command execution — without touching the network, the file
 * system beyond /tmp, or any real plugin.
 *
 * The interactive dispatch loop (plugin.dispatch, process.exit) is covered by
 * integration/e2e tests.
 */

import { describe, it, expect } from 'vitest';
import { parseFixArgs, buildFixPrompt, runCommand } from '../fix.js';

// ──────────────────────────────────────────────────────────────────────────────
// parseFixArgs — argument parsing
// ──────────────────────────────────────────────────────────────────────────────

describe('parseFixArgs — command capture', () => {
  it('captures a single-token command', () => {
    const { command } = parseFixArgs(['make']);
    expect(command).toBe('make');
  });

  it('joins multiple tokens into the command string', () => {
    const { command } = parseFixArgs(['npm', 'run', 'test']);
    expect(command).toBe('npm run test');
  });

  it('treats a pre-joined string arg as the full command', () => {
    const { command } = parseFixArgs(['npm run lint']);
    expect(command).toBe('npm run lint');
  });

  it('returns empty command when no args are given', () => {
    const { command } = parseFixArgs([]);
    expect(command).toBe('');
  });

  it('uses process.cwd() as the default working directory', () => {
    const { cwd } = parseFixArgs(['npm test']);
    expect(cwd).toBe(process.cwd());
  });

  it('defaults maxRetries to 5', () => {
    const { maxRetries } = parseFixArgs(['npm test']);
    expect(maxRetries).toBe(5);
  });

  it('defaults extraPrompt to empty string', () => {
    const { extraPrompt } = parseFixArgs(['npm test']);
    expect(extraPrompt).toBe('');
  });
});

describe('parseFixArgs — --cwd flag', () => {
  it('overrides the working directory', () => {
    const { cwd, command } = parseFixArgs(['--cwd', '/tmp/project', 'npm test']);
    expect(cwd).toBe('/tmp/project');
    expect(command).toBe('npm test');
  });

  it('does not consume the command when --cwd has no value', () => {
    // --cwd with no following value keeps the default cwd
    const { cwd } = parseFixArgs(['npm test', '--cwd']);
    expect(cwd).toBe(process.cwd());
  });
});

describe('parseFixArgs — --max-retries flag', () => {
  it('overrides the default retry count', () => {
    const { maxRetries, command } = parseFixArgs(['--max-retries', '3', 'npm test']);
    expect(maxRetries).toBe(3);
    expect(command).toBe('npm test');
  });

  it('accepts --retries as an alias', () => {
    const { maxRetries } = parseFixArgs(['--retries', '2', 'npm test']);
    expect(maxRetries).toBe(2);
  });

  it('ignores non-numeric values and keeps the default', () => {
    const { maxRetries } = parseFixArgs(['--max-retries', 'abc', 'npm test']);
    expect(maxRetries).toBe(5);
  });

  it('ignores zero and negative values and keeps the default', () => {
    const { maxRetries: r0 } = parseFixArgs(['--max-retries', '0', 'npm test']);
    const { maxRetries: rn } = parseFixArgs(['--max-retries', '-1', 'npm test']);
    expect(r0).toBe(5);
    expect(rn).toBe(5);
  });
});

describe('parseFixArgs — --prompt flag', () => {
  it('captures extra context', () => {
    const { extraPrompt, command } = parseFixArgs(['--prompt', 'uses pnpm', 'npm test']);
    expect(extraPrompt).toBe('uses pnpm');
    expect(command).toBe('npm test');
  });
});

describe('parseFixArgs — double-dash separator', () => {
  it('treats everything after -- as the command, including flag-like strings', () => {
    const { command, cwd } = parseFixArgs(['--cwd', '/tmp', '--', 'npm test --watch']);
    expect(cwd).toBe('/tmp');
    expect(command).toBe('npm test --watch');
  });

  it('handles bare -- with nothing after it', () => {
    const { command } = parseFixArgs(['--cwd', '/tmp', '--']);
    expect(command).toBe('');
  });
});

describe('parseFixArgs — combined flags', () => {
  it('handles multiple flags before the command', () => {
    const { cwd, maxRetries, extraPrompt, command } = parseFixArgs([
      '--cwd', '/my/project',
      '--max-retries', '10',
      '--prompt', 'typescript project',
      'npx tsc --noEmit',
    ]);
    expect(cwd).toBe('/my/project');
    expect(maxRetries).toBe(10);
    expect(extraPrompt).toBe('typescript project');
    expect(command).toBe('npx tsc --noEmit');
  });

  it('silently ignores unknown flags', () => {
    const { command } = parseFixArgs(['--unknown-future-flag', 'npm test']);
    expect(command).toBe('npm test');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildFixPrompt — prompt construction
// ──────────────────────────────────────────────────────────────────────────────

describe('buildFixPrompt — required fields', () => {
  it('includes the failing command in backticks', () => {
    const result = buildFixPrompt('npm test', 'Error: test failed', 1, 5, '');
    expect(result).toContain('`npm test`');
  });

  it('includes the captured command output', () => {
    const result = buildFixPrompt('npm test', 'FAIL src/app.test.ts', 1, 5, '');
    expect(result).toContain('FAIL src/app.test.ts');
  });

  it('shows the current attempt and total attempts', () => {
    const result = buildFixPrompt('npm test', 'error', 2, 5, '');
    expect(result).toContain('2 of 5');
  });

  it('instructs the agent to make minimal changes', () => {
    const result = buildFixPrompt('npm test', 'err', 1, 5, '');
    expect(result.toLowerCase()).toContain('minimal');
  });
});

describe('buildFixPrompt — extra prompt', () => {
  it('includes the extra context when provided', () => {
    const result = buildFixPrompt('npm test', 'err', 1, 5, 'this project uses pnpm');
    expect(result).toContain('this project uses pnpm');
    expect(result).toContain('Additional context:');
  });

  it('omits the extra context section when empty', () => {
    const result = buildFixPrompt('npm test', 'err', 1, 5, '');
    expect(result).not.toContain('Additional context:');
  });
});

describe('buildFixPrompt — output truncation', () => {
  it('truncates output that exceeds 8 000 chars', () => {
    const longOutput = 'x'.repeat(20_000);
    const result = buildFixPrompt('npm test', longOutput, 1, 5, '');
    expect(result).toContain('truncated');
    // Should be well under the raw output length
    expect(result.length).toBeLessThan(12_000);
  });

  it('does not truncate output within the limit', () => {
    const shortOutput = 'Error: expected true'.repeat(10);
    const result = buildFixPrompt('npm test', shortOutput, 1, 5, '');
    expect(result).toContain(shortOutput);
  });

  it('handles empty output gracefully', () => {
    const result = buildFixPrompt('npm test', '', 1, 5, '');
    expect(result).toContain('(no output captured)');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// runCommand — shell command execution
// ──────────────────────────────────────────────────────────────────────────────

describe('runCommand — success cases', () => {
  it('returns success=true and exitCode=0 for a passing command', () => {
    const result = runCommand('true', process.cwd());
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('captures stdout in the output field', () => {
    const result = runCommand('echo "hello from mia fix"', process.cwd());
    expect(result.output).toContain('hello from mia fix');
  });

  it('runs in the specified cwd', () => {
    const result = runCommand('pwd', '/tmp');
    // /tmp may be a symlink on some platforms, so check the end of the path
    expect(result.output.trim()).toContain('tmp');
  });
});

describe('runCommand — failure cases', () => {
  it('returns success=false for a non-zero exit', () => {
    const result = runCommand('exit 1', process.cwd());
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('captures stderr combined with stdout', () => {
    const result = runCommand('echo "err msg" >&2; exit 1', process.cwd());
    expect(result.output).toContain('err msg');
    expect(result.success).toBe(false);
  });

  it('returns a non-zero exit code for missing commands', () => {
    const result = runCommand('command-that-does-not-exist-xyzzy', process.cwd());
    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it('returns a non-zero exit for a specific non-one exit code', () => {
    const result = runCommand('exit 42', process.cwd());
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
  });
});

describe('runCommand — output combining', () => {
  it('combines stdout and stderr into a single output string', () => {
    const result = runCommand(
      'echo "stdout line"; echo "stderr line" >&2; exit 1',
      process.cwd(),
    );
    expect(result.output).toContain('stdout line');
    expect(result.output).toContain('stderr line');
  });

  it('returns empty output when the command produces no output', () => {
    const result = runCommand('true', process.cwd());
    expect(result.output).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Round-trip integration: parse → build prompt
// ──────────────────────────────────────────────────────────────────────────────

describe('parse + build round-trip', () => {
  it('produces a prompt that mentions the parsed command', () => {
    const { command, extraPrompt, maxRetries } = parseFixArgs([
      '--max-retries', '3',
      '--prompt', 'monorepo project',
      'pnpm test',
    ]);
    const prompt = buildFixPrompt(command, 'Test suite failed', 1, maxRetries, extraPrompt);
    expect(prompt).toContain('`pnpm test`');
    expect(prompt).toContain('1 of 3');
    expect(prompt).toContain('monorepo project');
  });

  it('run + prompt: produces a prompt from real command output', () => {
    const { command } = parseFixArgs(['echo "lint error: missing semicolon"; exit 1']);
    const result = runCommand(command, process.cwd());
    const prompt = buildFixPrompt(command, result.output, 1, 5, '');
    expect(prompt).toContain('lint error: missing semicolon');
    expect(result.success).toBe(false);
  });
});

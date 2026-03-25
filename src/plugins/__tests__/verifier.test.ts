import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PostDispatchVerifier } from '../verifier';
import type { PluginContext, PluginDispatchResult } from '../types';

const baseContext: PluginContext = {
  memoryFacts: [],
  codebaseContext: 'TypeScript monorepo',
  gitContext: 'Branch: master, clean',
  workspaceSnapshot: '100 files',
  projectInstructions: '',
};

function makeResult(output: string, success = true): PluginDispatchResult {
  return {
    taskId: 'test-task',
    success,
    output,
    durationMs: 500,
  };
}

describe('PostDispatchVerifier', () => {
  let verifier: PostDispatchVerifier;

  beforeEach(() => {
    verifier = new PostDispatchVerifier({ enabled: true, semanticCheck: false });
  });

  it('passes on good output', async () => {
    const result = await verifier.verify(
      'refactor the auth module',
      makeResult('Refactored auth.ts: moved logic into separate functions.'),
      baseContext
    );
    expect(result.passed).toBe(true);
    expect(result.checks.every(c => c.passed)).toBe(true);
  });

  it('fails on empty output', async () => {
    const result = await verifier.verify(
      'refactor the auth module',
      makeResult(''),
      baseContext
    );
    expect(result.passed).toBe(false);
    const emptyCheck = result.checks.find(c => c.name === 'non-empty-output');
    expect(emptyCheck?.passed).toBe(false);
  });

  it('fails on whitespace-only output', async () => {
    const result = await verifier.verify(
      'refactor the auth module',
      makeResult('   \n  '),
      baseContext
    );
    expect(result.passed).toBe(false);
  });

  it('fails when output contains Error: pattern', async () => {
    const result = await verifier.verify(
      'run tests',
      makeResult('Error: ENOENT: no such file or directory'),
      baseContext
    );
    expect(result.passed).toBe(false);
    const errCheck = result.checks.find(c => c.name === 'no-error-signals');
    expect(errCheck?.passed).toBe(false);
  });

  it('fails when output contains ENOENT', async () => {
    const result = await verifier.verify(
      'read file',
      makeResult('ENOENT: cannot read file'),
      baseContext
    );
    expect(result.passed).toBe(false);
  });

  it('fails when output contains a fatal OS error', async () => {
    const result = await verifier.verify(
      'compile project',
      makeResult('fatal error: cannot open output file: Permission denied'),
      baseContext
    );
    expect(result.passed).toBe(false);
  });

  it('passes for short prompt with short output', async () => {
    const result = await verifier.verify(
      'ls',
      makeResult('README.md\nsrc/'),
      baseContext
    );
    expect(result.passed).toBe(true);
  });

  it('flags very short output for long prompt', async () => {
    const result = await verifier.verify(
      'Please do a comprehensive refactoring of the entire authentication module, add tests, and update the documentation',
      makeResult('ok'),
      baseContext
    );
    const lengthCheck = result.checks.find(c => c.name === 'reasonable-output-length');
    expect(lengthCheck?.passed).toBe(false);
  });

  it('returns passed=true when disabled', async () => {
    const disabled = new PostDispatchVerifier({ enabled: false });
    const result = await disabled.verify('anything', makeResult(''), baseContext);
    expect(result.passed).toBe(true);
    expect(result.summary).toContain('disabled');
  });

  it('summary describes failed checks', async () => {
    const result = await verifier.verify(
      'do something',
      makeResult(''),
      baseContext
    );
    expect(result.summary).toContain('failed');
  });
});

// ── Error pattern coverage ────────────────────────────────────────────────────

describe('PostDispatchVerifier — error patterns', () => {
  let verifier: PostDispatchVerifier;

  beforeEach(() => {
    verifier = new PostDispatchVerifier({ enabled: true });
  });

  it('detects EACCES (permission denied)', async () => {
    const result = await verifier.verify(
      'write to /etc/hosts',
      makeResult('EACCES: permission denied, open \'/etc/hosts\''),
      baseContext
    );
    const errCheck = result.checks.find(c => c.name === 'no-error-signals');
    expect(errCheck?.passed).toBe(false);
  });

  it('detects Go/Rust panic', async () => {
    const result = await verifier.verify(
      'run the binary',
      makeResult('panic: runtime error: index out of range [0] with length 0'),
      baseContext
    );
    const errCheck = result.checks.find(c => c.name === 'no-error-signals');
    expect(errCheck?.passed).toBe(false);
  });

  it('detects Segmentation fault', async () => {
    const result = await verifier.verify(
      'run native code',
      makeResult('Segmentation fault (core dumped)'),
      baseContext
    );
    const errCheck = result.checks.find(c => c.name === 'no-error-signals');
    expect(errCheck?.passed).toBe(false);
  });

  it('detects "Command failed with exit code"', async () => {
    const result = await verifier.verify(
      'run npm install',
      makeResult('Command failed with exit code 1: npm install'),
      baseContext
    );
    const errCheck = result.checks.find(c => c.name === 'no-error-signals');
    expect(errCheck?.passed).toBe(false);
  });

  it('does NOT flag tutorial text that mentions error concepts', async () => {
    // Should not false-positive on documentation / educational content
    const result = await verifier.verify(
      'explain error handling',
      makeResult(
        'In JavaScript, you handle errors with try-catch. ' +
        'When an error occurs you can catch the Error object. ' +
        'Async functions should handle rejected promises carefully.'
      ),
      baseContext
    );
    const errCheck = result.checks.find(c => c.name === 'no-error-signals');
    expect(errCheck?.passed).toBe(true);
  });

  it('error signal check details string when pattern matched', async () => {
    const result = await verifier.verify(
      'read config',
      makeResult('ENOENT: no such file or directory, open \'/tmp/missing.json\''),
      baseContext
    );
    const errCheck = result.checks.find(c => c.name === 'no-error-signals');
    expect(errCheck?.details).toContain('OS/runtime error');
  });
});

// ── retryOnFailure behaviour ─────────────────────────────────────────────────

describe('PostDispatchVerifier — retryOnFailure', () => {
  it('does not retry when checks pass', async () => {
    const retryDispatch = vi.fn().mockResolvedValue(
      makeResult('retry output that should never be called')
    );

    const verifier = new PostDispatchVerifier({ enabled: true, retryOnFailure: true });
    const result = await verifier.verify(
      'do a task',
      makeResult('Good output with plenty of content here.'),
      baseContext,
      retryDispatch,
    );

    expect(result.passed).toBe(true);
    expect(retryDispatch).not.toHaveBeenCalled();
  });

  it('does not retry when retryOnFailure is false (default)', async () => {
    const retryDispatch = vi.fn().mockResolvedValue(makeResult('retry result'));

    const verifier = new PostDispatchVerifier({ enabled: true, retryOnFailure: false });
    const result = await verifier.verify(
      'do a task',
      makeResult(''),   // empty → checks fail
      baseContext,
      retryDispatch,
    );

    expect(result.passed).toBe(false);
    expect(retryDispatch).not.toHaveBeenCalled();
  });

  it('does not retry when checks fail but no retryDispatch callback provided', async () => {
    const verifier = new PostDispatchVerifier({ enabled: true, retryOnFailure: true });
    const result = await verifier.verify(
      'do a task',
      makeResult(''),  // empty → checks fail
      baseContext,
      // no retryDispatch
    );

    expect(result.passed).toBe(false);
    // Summary should describe the original failure (no "(retry)" prefix)
    expect(result.summary).not.toContain('(retry)');
  });

  it('retries once when checks fail and retryOnFailure is true', async () => {
    const goodRetryResult = makeResult('Here is a detailed and correct response after retry.');
    const retryDispatch = vi.fn().mockResolvedValue(goodRetryResult);

    const verifier = new PostDispatchVerifier({ enabled: true, retryOnFailure: true });
    const result = await verifier.verify(
      'do a task',
      makeResult(''),  // empty → initial checks fail
      baseContext,
      retryDispatch,
    );

    expect(retryDispatch).toHaveBeenCalledOnce();
    // Retry produced good output → should pass
    expect(result.passed).toBe(true);
    // Summary should carry the "(retry)" prefix
    expect(result.summary).toContain('(retry)');
  });

  it('returns failed retry result with "(retry)" prefix when retry also fails checks', async () => {
    // Retry returns output that is also empty → retry checks fail too
    const retryDispatch = vi.fn().mockResolvedValue(makeResult(''));

    const verifier = new PostDispatchVerifier({ enabled: true, retryOnFailure: true });
    const result = await verifier.verify(
      'do a task',
      makeResult(''),
      baseContext,
      retryDispatch,
    );

    expect(retryDispatch).toHaveBeenCalledOnce();
    expect(result.passed).toBe(false);
    expect(result.summary).toContain('(retry)');
  });

  it('returns original failed result when retryDispatch throws', async () => {
    const retryDispatch = vi.fn().mockRejectedValue(new Error('plugin crashed'));

    const verifier = new PostDispatchVerifier({ enabled: true, retryOnFailure: true });
    const result = await verifier.verify(
      'do a task',
      makeResult(''),  // empty → initial checks fail
      baseContext,
      retryDispatch,
    );

    expect(retryDispatch).toHaveBeenCalledOnce();
    // Should return the original (pre-retry) failure, not throw
    expect(result.passed).toBe(false);
    // Summary should NOT have the "(retry)" prefix since we fell back
    expect(result.summary).not.toContain('(retry)');
  });

  it('calls retryDispatch at most once even when multiple checks fail', async () => {
    // Both non-empty AND error-signal checks fail
    const badOutput = 'ENOENT'; // short + error signal
    const retryDispatch = vi.fn().mockResolvedValue(
      makeResult('A proper retry response that is long enough and clean.')
    );

    const verifier = new PostDispatchVerifier({ enabled: true, retryOnFailure: true });
    await verifier.verify(
      'Please refactor the entire auth module and add comprehensive tests',
      makeResult(badOutput),
      baseContext,
      retryDispatch,
    );

    // Retry is attempted exactly once regardless of how many checks failed
    expect(retryDispatch).toHaveBeenCalledOnce();
  });
});

// ── semanticCheck option ──────────────────────────────────────────────────────

describe('PostDispatchVerifier — semanticCheck', () => {
  it('adds a semantic-relevance check when semanticCheck=true', async () => {
    const verifier = new PostDispatchVerifier({ enabled: true, semanticCheck: true });
    const result = await verifier.verify(
      'refactor auth',
      makeResult('Refactored auth.ts: extracted helpers.'),
      baseContext
    );

    const semanticCheck = result.checks.find(c => c.name === 'semantic-relevance');
    expect(semanticCheck).toBeDefined();
    // Current implementation always passes (placeholder)
    expect(semanticCheck?.passed).toBe(true);
  });

  it('omits semantic-relevance check when semanticCheck=false', async () => {
    const verifier = new PostDispatchVerifier({ enabled: true, semanticCheck: false });
    const result = await verifier.verify(
      'refactor auth',
      makeResult('Refactored auth.ts: extracted helpers.'),
      baseContext
    );

    const semanticCheck = result.checks.find(c => c.name === 'semantic-relevance');
    expect(semanticCheck).toBeUndefined();
  });
});

// ── summary and check shape ───────────────────────────────────────────────────

describe('PostDispatchVerifier — summary and check shape', () => {
  it('summary says "All verification checks passed" when everything passes', async () => {
    const verifier = new PostDispatchVerifier({ enabled: true });
    const result = await verifier.verify(
      'list files',
      makeResult('src/\ntest/\npackage.json'),
      baseContext
    );
    expect(result.summary).toBe('All verification checks passed');
  });

  it('summary names each failed check', async () => {
    const verifier = new PostDispatchVerifier({ enabled: true });
    // Empty output → non-empty-output fails
    // Short output for long prompt → reasonable-output-length fails
    const result = await verifier.verify(
      'Please do a comprehensive refactoring of the entire authentication module with full test coverage',
      makeResult(''),
      baseContext
    );
    expect(result.summary).toContain('non-empty-output');
    // reasonable-output-length also fails (0 chars for long prompt)
    expect(result.summary).toContain('reasonable-output-length');
  });

  it('every check has a name, passed boolean, and optional details', async () => {
    const verifier = new PostDispatchVerifier({ enabled: true });
    const result = await verifier.verify(
      'ls',
      makeResult(''),
      baseContext
    );
    for (const check of result.checks) {
      expect(typeof check.name).toBe('string');
      expect(check.name.length).toBeGreaterThan(0);
      expect(typeof check.passed).toBe('boolean');
      if (check.details !== undefined) {
        expect(typeof check.details).toBe('string');
      }
    }
  });

  it('non-empty-output check provides details when it fails', async () => {
    const verifier = new PostDispatchVerifier({ enabled: true });
    const result = await verifier.verify('task', makeResult(''), baseContext);
    const check = result.checks.find(c => c.name === 'non-empty-output');
    expect(check?.details).toBeTruthy();
  });

  it('reasonable-output-length check provides details when it fails', async () => {
    const verifier = new PostDispatchVerifier({ enabled: true });
    const result = await verifier.verify(
      'Please write a complete implementation of the OAuth2 PKCE flow for a mobile application with full error handling',
      makeResult('ok'),
      baseContext
    );
    const check = result.checks.find(c => c.name === 'reasonable-output-length');
    expect(check?.details).toContain('chars');
  });
});

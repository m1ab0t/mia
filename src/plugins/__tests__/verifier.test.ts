import { describe, it, expect, beforeEach } from 'vitest';
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

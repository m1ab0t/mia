/**
 * Tests for utils/ignore-error
 *
 * Covers:
 *   - ignoreError(tag) returns a function
 *   - The returned function writes a formatted message to stderr
 *   - Error objects, plain strings, and unknown values are all handled
 *   - The tag is included in the output
 *   - The function does not throw for any input
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ignoreError } from './ignore-error';

describe('ignoreError', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('returns a function', () => {
    const handler = ignoreError('test-tag');
    expect(typeof handler).toBe('function');
  });

  it('writes to stderr when called with an Error', () => {
    const handler = ignoreError('my-tag');
    handler(new Error('something went wrong'));
    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = String(stderrSpy.mock.calls[0][0]);
    expect(output).toContain('my-tag');
    expect(output).toContain('something went wrong');
  });

  it('includes the tag in the stderr output', () => {
    const handler = ignoreError('shutdown');
    handler(new Error('ENOENT'));
    const output = String(stderrSpy.mock.calls[0][0]);
    expect(output).toContain('[shutdown]');
  });

  it('handles a plain string error', () => {
    const handler = ignoreError('session-save');
    handler('string error message');
    const output = String(stderrSpy.mock.calls[0][0]);
    expect(output).toContain('string error message');
    expect(output).toContain('session-save');
  });

  it('handles a numeric error value', () => {
    const handler = ignoreError('tag');
    expect(() => handler(42)).not.toThrow();
    const output = String(stderrSpy.mock.calls[0][0]);
    expect(output).toContain('42');
  });

  it('handles null without throwing', () => {
    const handler = ignoreError('tag');
    expect(() => handler(null)).not.toThrow();
  });

  it('handles undefined without throwing', () => {
    const handler = ignoreError('tag');
    expect(() => handler(undefined)).not.toThrow();
  });

  it('handles an object without message property', () => {
    const handler = ignoreError('tag');
    expect(() => handler({ code: 'ENOENT' })).not.toThrow();
  });

  it('uses Error.message (not toString) when err is an Error instance', () => {
    const handler = ignoreError('tag');
    handler(new Error('original message'));
    const output = String(stderrSpy.mock.calls[0][0]);
    // Should contain the message, not "Error: message"
    expect(output).toContain('original message');
    // The output should NOT include the "Error: " prefix from toString()
    expect(output).not.toMatch(/Error: original message/);
  });

  it('stderr output ends with a newline', () => {
    const handler = ignoreError('tag');
    handler(new Error('oops'));
    const output = String(stderrSpy.mock.calls[0][0]);
    expect(output).toMatch(/\n$/);
  });

  it('different tags produce distinct output', () => {
    ignoreError('alpha')(new Error('err1'));
    ignoreError('beta')(new Error('err2'));
    const out1 = String(stderrSpy.mock.calls[0][0]);
    const out2 = String(stderrSpy.mock.calls[1][0]);
    expect(out1).toContain('[alpha]');
    expect(out2).toContain('[beta]');
  });

  it('can be used as a .catch() handler without throw', async () => {
    const p = Promise.reject(new Error('async fail'));
    await expect(p.catch(ignoreError('async-tag'))).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledOnce();
  });
});

/**
 * Tests for daemon/commands/ask.ts
 *
 * Tests the pure argument-parsing and prompt-assembly logic without touching
 * any real plugin, file system state, or the network.  The side-effectful
 * dispatch path (plugin.dispatch, process.exit) is exercised separately via
 * integration/e2e tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseAskArgs, buildAskPrompt } from '../ask.js';
import { readStdinContent } from '../parse-utils.js';

// ──────────────────────────────────────────────────────────────────────────────
// parseAskArgs
// ──────────────────────────────────────────────────────────────────────────────

describe('parseAskArgs — basic prompt collection', () => {
  it('collects a single-word prompt', () => {
    const result = parseAskArgs(['hello']);
    expect(result.promptParts).toEqual(['hello']);
  });

  it('collects a multi-word prompt', () => {
    const result = parseAskArgs(['explain', 'the', 'auth', 'flow']);
    expect(result.promptParts).toEqual(['explain', 'the', 'auth', 'flow']);
  });

  it('returns empty promptParts when no args are given', () => {
    const result = parseAskArgs([]);
    expect(result.promptParts).toEqual([]);
  });

  it('uses process.cwd() as default cwd', () => {
    const result = parseAskArgs([]);
    expect(result.cwd).toBe(process.cwd());
  });

  it('has rawMode=false by default', () => {
    const result = parseAskArgs(['hello']);
    expect(result.rawMode).toBe(false);
  });

  it('has noContext=false by default', () => {
    const result = parseAskArgs(['hello']);
    expect(result.noContext).toBe(false);
  });
});

describe('parseAskArgs — --cwd flag', () => {
  it('sets cwd from --cwd flag', () => {
    const result = parseAskArgs(['--cwd', '/home/user/project', 'fix', 'bug']);
    expect(result.cwd).toBe('/home/user/project');
    expect(result.promptParts).toEqual(['fix', 'bug']);
  });

  it('handles --cwd at the end without a value (no crash)', () => {
    // --cwd with no following arg — the argv[i+1] guard keeps cwd as default
    const result = parseAskArgs(['fix', 'bug', '--cwd']);
    expect(result.cwd).toBe(process.cwd());
    expect(result.promptParts).toEqual(['fix', 'bug']);
  });

  it('handles multiple flags before the prompt', () => {
    const result = parseAskArgs(['--cwd', '/tmp', '--raw', 'describe', 'this']);
    expect(result.cwd).toBe('/tmp');
    expect(result.rawMode).toBe(true);
    expect(result.promptParts).toEqual(['describe', 'this']);
  });
});

describe('parseAskArgs — --raw flag', () => {
  it('sets rawMode=true when --raw is present', () => {
    const result = parseAskArgs(['--raw', 'hello']);
    expect(result.rawMode).toBe(true);
    expect(result.promptParts).toEqual(['hello']);
  });

  it('rawMode does not consume the next arg as a value', () => {
    const result = parseAskArgs(['--raw', 'some', 'prompt']);
    expect(result.promptParts).toEqual(['some', 'prompt']);
  });
});

describe('parseAskArgs — --no-context flag', () => {
  it('sets noContext=true when --no-context is present', () => {
    const result = parseAskArgs(['--no-context', 'hello']);
    expect(result.noContext).toBe(true);
    expect(result.promptParts).toEqual(['hello']);
  });
});

describe('parseAskArgs — double-dash separator', () => {
  it('treats everything after -- as prompt, even flag-like strings', () => {
    const result = parseAskArgs(['--raw', '--', '--not-a-flag', 'hello']);
    expect(result.rawMode).toBe(true);
    expect(result.promptParts).toEqual(['--not-a-flag', 'hello']);
  });

  it('handles bare -- with no following args', () => {
    const result = parseAskArgs(['--raw', '--']);
    expect(result.promptParts).toEqual([]);
  });
});

describe('parseAskArgs — --model flag', () => {
  it('has model=undefined by default', () => {
    const result = parseAskArgs(['hello']);
    expect(result.model).toBeUndefined();
  });

  it('sets model from --model flag', () => {
    const result = parseAskArgs(['--model', 'claude-opus-4-5', 'hello']);
    expect(result.model).toBe('claude-opus-4-5');
    expect(result.promptParts).toEqual(['hello']);
  });

  it('sets model when --model is last flag before prompt parts', () => {
    const result = parseAskArgs(['--no-context', '--model', 'gpt-4o', 'explain', 'this']);
    expect(result.model).toBe('gpt-4o');
    expect(result.noContext).toBe(true);
    expect(result.promptParts).toEqual(['explain', 'this']);
  });

  it('handles --model combined with --cwd and --raw', () => {
    const result = parseAskArgs(['--cwd', '/tmp', '--raw', '--model', 'gemini-2.5-pro', 'hi']);
    expect(result.cwd).toBe('/tmp');
    expect(result.rawMode).toBe(true);
    expect(result.model).toBe('gemini-2.5-pro');
    expect(result.promptParts).toEqual(['hi']);
  });

  it('handles --model with no following value (treated as unknown flag, model stays undefined)', () => {
    // --model at end of argv with no value — guard keeps model as undefined
    const result = parseAskArgs(['hello', '--model']);
    expect(result.model).toBeUndefined();
    expect(result.promptParts).toEqual(['hello']);
  });

  it('model value does not appear in promptParts', () => {
    const result = parseAskArgs(['--model', 'claude-sonnet-4-5', 'my', 'prompt']);
    expect(result.promptParts).toEqual(['my', 'prompt']);
    expect(result.promptParts).not.toContain('claude-sonnet-4-5');
  });
});

describe('parseAskArgs — unknown flags are silently ignored', () => {
  it('ignores unknown --flags without crashing', () => {
    const result = parseAskArgs(['--unknown-future-flag', 'my', 'prompt']);
    expect(result.promptParts).toEqual(['my', 'prompt']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildAskPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildAskPrompt — prompt assembly', () => {
  it('joins parts with a space when no stdin', () => {
    const result = buildAskPrompt(['explain', 'the', 'auth', 'flow'], '');
    expect(result).toBe('explain the auth flow');
  });

  it('returns stdin content alone when no cli parts', () => {
    const result = buildAskPrompt([], 'file content here');
    expect(result).toBe('file content here');
  });

  it('prepends stdin before cli prompt when both are present', () => {
    const result = buildAskPrompt(['summarize this'], 'file content here');
    expect(result).toBe('file content here\n\nsummarize this');
  });

  it('returns empty string when both parts and stdin are empty', () => {
    const result = buildAskPrompt([], '');
    expect(result).toBe('');
  });

  it('trims whitespace from stdin', () => {
    const result = buildAskPrompt(['summarize'], '  padded content  ');
    expect(result).toBe('padded content\n\nsummarize');
  });

  it('trims whitespace from parts join', () => {
    const result = buildAskPrompt(['  hello  '], '');
    expect(result).toBe('hello');
  });

  it('handles multiline stdin correctly', () => {
    const stdin = 'line one\nline two\nline three';
    const result = buildAskPrompt(['what does this do?'], stdin);
    expect(result).toBe('line one\nline two\nline three\n\nwhat does this do?');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// readStdinContent — TTY guard
// ──────────────────────────────────────────────────────────────────────────────

describe('readStdinContent — TTY detection', () => {
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    // Restore original value (may be undefined)
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it('resolves immediately with empty string when stdin is a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
    const result = await readStdinContent();
    expect(result).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Integration-level: prompt → parts → final prompt round-trip
// ──────────────────────────────────────────────────────────────────────────────

describe('full round-trip: parseAskArgs + buildAskPrompt', () => {
  it('produces the expected prompt string from argv + stdin', () => {
    const { promptParts } = parseAskArgs(['--cwd', '/tmp', 'summarize', 'this']);
    const finalPrompt = buildAskPrompt(promptParts, 'file content');
    expect(finalPrompt).toBe('file content\n\nsummarize this');
  });

  it('handles the git diff pipe pattern', () => {
    const { promptParts } = parseAskArgs(['write', 'a', 'commit', 'message']);
    const gitDiffOutput = 'diff --git a/foo.ts b/foo.ts\n+added line';
    const finalPrompt = buildAskPrompt(promptParts, gitDiffOutput);
    expect(finalPrompt.startsWith('diff --git')).toBe(true);
    expect(finalPrompt).toContain('write a commit message');
  });

  it('handles raw mode flag without polluting prompt', () => {
    const { promptParts, rawMode } = parseAskArgs(['--raw', 'list', 'files']);
    const finalPrompt = buildAskPrompt(promptParts, '');
    expect(rawMode).toBe(true);
    expect(finalPrompt).toBe('list files');
    expect(finalPrompt).not.toContain('--raw');
  });

  it('handles --cwd flag without polluting prompt', () => {
    const { promptParts, cwd } = parseAskArgs(['--cwd', '/my/project', 'fix', 'bug']);
    const finalPrompt = buildAskPrompt(promptParts, '');
    expect(cwd).toBe('/my/project');
    expect(finalPrompt).toBe('fix bug');
    expect(finalPrompt).not.toContain('/my/project');
  });

  it('handles --model flag without polluting prompt', () => {
    const { promptParts, model } = parseAskArgs(['--model', 'claude-opus-4-5', 'complex', 'question']);
    const finalPrompt = buildAskPrompt(promptParts, '');
    expect(model).toBe('claude-opus-4-5');
    expect(finalPrompt).toBe('complex question');
    expect(finalPrompt).not.toContain('claude-opus-4-5');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles a prompt that is just whitespace (treated as empty)', () => {
    const result = buildAskPrompt(['   '], '');
    expect(result).toBe('');
  });

  it('handles stdin that is only whitespace (treated as empty)', () => {
    const result = buildAskPrompt(['fix', 'it'], '   \n  ');
    expect(result).toBe('fix it');
  });

  it('handles very long prompts without truncation', () => {
    const longWord = 'a'.repeat(10_000);
    const result = buildAskPrompt([longWord], '');
    expect(result).toBe(longWord);
  });

  it('parseAskArgs handles an arg array with only --', () => {
    const result = parseAskArgs(['--']);
    expect(result.promptParts).toEqual([]);
  });
});

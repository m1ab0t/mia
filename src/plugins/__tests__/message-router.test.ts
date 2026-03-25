/**
 * message-router tests
 *
 * Covers the full behaviour of classifyPrompt():
 *   - Length-based shortcut (> 300 chars -> coding)
 *   - Each technical pattern group
 *   - General-message detection
 *   - Case insensitivity (prompt is lowercased before matching)
 *   - Whitespace trimming
 *   - Edge cases and boundary conditions
 *
 * classifyPrompt is a pure, deterministic function — no mocks required.
 */

import { describe, it, expect } from 'vitest';
import { classifyPrompt, type RouteType } from '../message-router.js';

// ── Helper ────────────────────────────────────────────────────────────────────

function assertRoute(prompt: string, expected: RouteType): void {
  expect(classifyPrompt(prompt)).toBe(expected);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('classifyPrompt', () => {
  // ── Length-based shortcut ───────────────────────────────────────────────────

  describe('length-based routing', () => {
    it('classifies empty string as general', () => {
      assertRoute('', 'general');
    });

    it('classifies a short non-technical message as general', () => {
      assertRoute('Hi there!', 'general');
    });

    it('classifies a 300-char non-technical message as general (boundary is > 300, not >=)', () => {
      // Exactly 300 chars of plain text — the shortcut is > 300, so this falls
      // through to pattern matching, which finds nothing technical -> general.
      const msg = 'a'.repeat(300);
      assertRoute(msg, 'general');
    });

    it('classifies a 301-char message as coding regardless of content', () => {
      // > 300 chars triggers the coding shortcut before pattern matching.
      const msg = 'a'.repeat(301);
      assertRoute(msg, 'coding');
    });

    it('classifies a 1000-char message as coding', () => {
      assertRoute('x'.repeat(1000), 'coding');
    });

    it('classifies a long conversational paragraph as coding via the length shortcut', () => {
      const msg = 'This is a very long message that goes on and on without any technical keywords '.repeat(5);
      assertRoute(msg, 'coding');
    });
  });

  // ── Code construct patterns ─────────────────────────────────────────────────

  describe('code construct patterns (file, function, class, method, …)', () => {
    it.each([
      ['open the file for me', 'file'],
      ['list all files in src/', 'files'],
      ['write some code here', 'code'],
      ['create a function that adds numbers', 'function'],
      ['refactor this class', 'class'],
      ['update this method', 'method'],
      ['what does this variable hold', 'variable'],
      ['fix the import path', 'import'],
      ['add a named export', 'export'],
      ['create a new module', 'module'],
    ] as [string, string][])('classifies "%s" as coding (keyword: %s)', (prompt) => {
      assertRoute(prompt, 'coding');
    });
  });

  // ── Action word patterns ────────────────────────────────────────────────────

  describe('action word patterns (refactor, implement, create, add, remove, …)', () => {
    it.each([
      'refactor this component',
      'implement the auth flow',
      'create a new endpoint',
      'add error handling here',
      'remove the dead code',
      'delete this helper function',
      'update the config value',
      'change the return type',
      'write unit tests for this',
      'edit this file please',
    ])('classifies "%s" as coding', (prompt) => {
      assertRoute(prompt, 'coding');
    });
  });

  // ── Tech stack patterns ─────────────────────────────────────────────────────

  describe('tech stack patterns (typescript, javascript, react, node, api, …)', () => {
    it.each([
      'convert this to typescript',
      'use javascript instead',
      'add a react component',
      'configure the node server',
      'build a rest api',
      'update the database schema',
      'optimise this query',
      'add a new endpoint to the api',
    ])('classifies "%s" as coding', (prompt) => {
      assertRoute(prompt, 'coding');
    });
  });

  // ── Version control patterns ────────────────────────────────────────────────

  describe('version control patterns (git, commit, branch, merge, push, …)', () => {
    it.each([
      'what does git status show',
      'how do i commit this',
      'create a new branch',
      'how to merge these branches',
      'push to origin master',
      'pull the latest changes',
      'show me the diff',
      'stash my changes now',
      'rebase onto main please',
    ])('classifies "%s" as coding', (prompt) => {
      assertRoute(prompt, 'coding');
    });
  });

  // ── Tooling / package manager patterns ─────────────────────────────────────

  describe('tooling patterns (npm, yarn, build, test, deploy, …)', () => {
    it.each([
      'run npm install for me',
      'add a package with yarn',
      'install using pnpm',
      'how do I build this project',
      'run the test suite now',
      'start the dev server',
      'deploy to production',
      'lint the entire codebase',
      'compile the typescript files',
    ])('classifies "%s" as coding', (prompt) => {
      assertRoute(prompt, 'coding');
    });
  });

  // ── Error and debugging patterns ────────────────────────────────────────────

  describe('error and debugging patterns (bug, error, fix, debug, problem, …)', () => {
    it.each([
      'there is a bug in this function',
      'getting an error on line 42',
      'can you fix this issue',
      'help me debug this crash',
      'the problem is in the config',
      'the app keeps crashing on start',
      'this test keeps failing',
      'something is broken in auth',
      'catching an unhandled exception',
    ])('classifies "%s" as coding', (prompt) => {
      assertRoute(prompt, 'coding');
    });
  });

  // ── File path and extension patterns ───────────────────────────────────────

  describe('file path and extension patterns', () => {
    it('matches a backtick-quoted .ts file path', () => {
      assertRoute('look at `src/index.ts` please', 'coding');
    });

    it('matches a double-quoted .json path', () => {
      assertRoute('check "config/app.json" for errors', 'coding');
    });

    it('matches a single-quoted .js path', () => {
      assertRoute("open 'dist/bundle.js' in the browser", 'coding');
    });

    it('matches a .py file by extension', () => {
      assertRoute('run script.py to start', 'coding');
    });

    it('matches a .go file extension', () => {
      assertRoute('open main.go please', 'coding');
    });

    it('matches a .java file extension', () => {
      assertRoute('the error is in App.java there', 'coding');
    });

    it('matches a .rs file extension', () => {
      assertRoute('look at lib.rs for context', 'coding');
    });

    it('matches a plain filename with extension (no quotes)', () => {
      assertRoute('README.md needs updating', 'coding');
    });

    it('matches a path containing directory separators', () => {
      assertRoute('check packages/mia/src/index.ts for details', 'coding');
    });
  });

  // ── General messages (no technical match) ───────────────────────────────────

  describe('general (non-coding) messages', () => {
    it.each([
      'Hello, how are you?',
      'What is your name?',
      'Tell me a joke',
      "What's the weather today?",
      'Summarize the last conversation',
      'How was your day?',
      'Thanks for your help',
      'Good morning',
      'I agree with that',
      'Sounds good to me',
    ])('classifies "%s" as general', (prompt) => {
      assertRoute(prompt, 'general');
    });
  });

  // ── Case insensitivity ──────────────────────────────────────────────────────

  describe('case insensitivity (prompt is lowercased before matching)', () => {
    it('matches TYPESCRIPT in uppercase', () => {
      assertRoute('use TYPESCRIPT for this', 'coding');
    });

    it('matches Git with mixed case', () => {
      assertRoute('run Git status now', 'coding');
    });

    it('matches FILE in uppercase', () => {
      assertRoute('show me the FILE', 'coding');
    });

    it('matches REFACTOR in uppercase', () => {
      assertRoute('Can you REFACTOR This please?', 'coding');
    });

    it('matches "Claude" in title case', () => {
      assertRoute('Use Claude for this task', 'coding');
    });

    it('matches "Coding" in title case', () => {
      assertRoute('Is this a Coding task?', 'coding');
    });
  });

  // ── Whitespace handling ─────────────────────────────────────────────────────

  describe('whitespace handling', () => {
    it('trims leading spaces before pattern matching', () => {
      assertRoute('   write a function', 'coding');
    });

    it('trims trailing spaces and classifies correctly', () => {
      assertRoute('tell me a joke   ', 'general');
    });

    it('trims a leading tab character', () => {
      assertRoute('\twrite a function', 'coding');
    });

    it('classifies whitespace-only input as general', () => {
      assertRoute('   ', 'general');
    });

    it('trims before applying the length boundary (301+ -> coding)', () => {
      // 301 a's with surrounding spaces -> after trim: 301 a's -> coding
      const msg = ' ' + 'a'.repeat(301) + ' ';
      assertRoute(msg, 'coding');
    });

    it('trims before applying the length boundary (300 chars -> general after trim)', () => {
      // 300 a's with surrounding spaces -> after trim: 300 a's -> pattern check -> general
      const msg = ' ' + 'a'.repeat(300) + ' ';
      assertRoute(msg, 'general');
    });
  });

  // ── Edge cases and documented design decisions ──────────────────────────────

  describe('edge cases', () => {
    it('returns coding for "fix" alone (matches error/debug pattern)', () => {
      assertRoute('fix this', 'coding');
    });

    it('returns coding for "api" as a standalone term', () => {
      assertRoute('check the api', 'coding');
    });

    it('returns general for a two-word phrase with no technical terms', () => {
      assertRoute('do it', 'general');
    });

    it('returns general for a single non-technical greeting', () => {
      assertRoute('Hi', 'general');
    });

    it('returns general for a unicode-rich non-technical message', () => {
      assertRoute('cafe au lait', 'general');
    });

    it('returns coding for "claude" keyword (matches tech/assistant pattern)', () => {
      assertRoute('use claude for this', 'coding');
    });

    it('returns coding for "code" standalone (matches code construct pattern)', () => {
      assertRoute('review this code', 'coding');
    });

    it('returns coding for "node" — by design the router errs toward coding when uncertain', () => {
      // "node" hits the tech-stack pattern even when meaning a graph/tree node.
      // Per the design doc: fallback to coding — the general path cannot substitute
      // for missing codebase context.
      assertRoute('what is a node', 'coding');
    });

    it('returns coding for a bare file reference like "index.ts"', () => {
      assertRoute('open index.ts', 'coding');
    });
  });
});

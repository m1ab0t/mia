/**
 * Tests for plugins/trace-logger — TraceLogger class
 *
 * Covers:
 *   - startTrace()       creates in-memory trace, returns UUID
 *   - recordEvent()      appends events to the active trace
 *   - endTrace()         writes NDJSON to disk, removes from active map
 *   - disabled mode      all public methods are safe no-ops
 *   - retention cleanup  old files removed on construction, recent kept
 *   - custom tracesDir   writes to the path provided in options
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TraceLogger } from './trace-logger';
import type { PluginContext, DispatchOptions, PluginDispatchResult } from './types';

// ── Fixture helpers ───────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mia-trace-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    memoryFacts: [],
    codebaseContext: '',
    gitContext: '',
    workspaceSnapshot: '',
    projectInstructions: '',
    ...overrides,
  };
}

function makeOptions(overrides: Partial<DispatchOptions> = {}): DispatchOptions {
  return {
    conversationId: 'test-conv-123',
    workingDirectory: '/tmp/project',
    ...overrides,
  };
}

function makeResult(overrides: Partial<PluginDispatchResult> = {}): PluginDispatchResult {
  return {
    taskId: 'task-001',
    success: true,
    output: 'Done.',
    durationMs: 1234,
    ...overrides,
  };
}

/**
 * Read all NDJSON lines from a trace file and return parsed objects.
 */
function readTraceFile(tracesDir: string): Record<string, unknown>[] {
  const files = require('fs').readdirSync(tracesDir).filter((f: string) => f.endsWith('.ndjson'));
  if (files.length === 0) return [];
  const content = readFileSync(join(tracesDir, files[0]), 'utf-8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line: string) => JSON.parse(line));
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('TraceLogger — constructor', () => {
  it('creates the traces directory if it does not exist', async () => {
    const tracesDir = join(tmpDir, 'traces-new');
    const logger = new TraceLogger({ tracesDir });
    await logger.waitForReady();
    expect(existsSync(tracesDir)).toBe(true);
  });

  it('does not throw when the directory already exists', () => {
    const tracesDir = join(tmpDir, 'traces-exist');
    mkdirSync(tracesDir, { recursive: true });
    expect(() => new TraceLogger({ tracesDir })).not.toThrow();
  });

  it('does not create the directory when disabled', () => {
    const tracesDir = join(tmpDir, 'traces-disabled');
    new TraceLogger({ enabled: false, tracesDir });
    expect(existsSync(tracesDir)).toBe(false);
  });
});

// ── startTrace ────────────────────────────────────────────────────────────────

describe('TraceLogger — startTrace', () => {
  it('returns a non-empty string (UUID-like)', () => {
    const logger = new TraceLogger({ tracesDir: join(tmpDir, 'traces') });
    const id = logger.startTrace('claude-code', 'conv-1', 'hello', makeContext(), makeOptions());
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returns a UUID even when disabled', () => {
    const logger = new TraceLogger({ enabled: false, tracesDir: join(tmpDir, 'traces') });
    const id = logger.startTrace('claude-code', 'conv-1', 'hello', makeContext(), makeOptions());
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returns unique IDs for consecutive calls', () => {
    const logger = new TraceLogger({ tracesDir: join(tmpDir, 'traces') });
    const id1 = logger.startTrace('plugin', 'c1', 'p1', makeContext(), makeOptions());
    const id2 = logger.startTrace('plugin', 'c2', 'p2', makeContext(), makeOptions());
    expect(id1).not.toBe(id2);
  });
});

// ── recordEvent ───────────────────────────────────────────────────────────────

describe('TraceLogger — recordEvent', () => {
  it('does not throw for an unknown traceId', () => {
    const logger = new TraceLogger({ tracesDir: join(tmpDir, 'traces') });
    expect(() => logger.recordEvent('no-such-id', 'token', { text: 'hi' })).not.toThrow();
  });

  it('is a no-op when disabled', () => {
    const tracesDir = join(tmpDir, 'traces');
    const logger = new TraceLogger({ enabled: false, tracesDir });
    const id = logger.startTrace('plugin', 'conv', 'prompt', makeContext(), makeOptions());
    expect(() => logger.recordEvent(id, 'token', { text: 'hello' })).not.toThrow();
  });

  it('records events that appear in the flushed trace', async () => {
    const tracesDir = join(tmpDir, 'traces');
    const logger = new TraceLogger({ tracesDir });
    const id = logger.startTrace('test-plugin', 'conv-x', 'do stuff', makeContext(), makeOptions());

    logger.recordEvent(id, 'token', { text: 'partial' });
    logger.recordEvent(id, 'tool_call', { tool: 'read' });
    logger.endTrace(id, makeResult());
    await logger.waitForFlush();

    const traces = readTraceFile(tracesDir);
    expect(traces).toHaveLength(1);
    const trace = traces[0] as { events: Array<{ type: string; data: unknown }> };
    const types = trace.events.map((e) => e.type);
    expect(types).toContain('token');
    expect(types).toContain('tool_call');
  });

  it('events include a timestamp string', async () => {
    const tracesDir = join(tmpDir, 'traces');
    const logger = new TraceLogger({ tracesDir });
    const id = logger.startTrace('plugin', 'conv', 'prompt', makeContext(), makeOptions());
    logger.recordEvent(id, 'abort', { reason: 'test' });
    logger.endTrace(id, makeResult());
    await logger.waitForFlush();

    const traces = readTraceFile(tracesDir);
    const trace = traces[0] as { events: Array<{ type: string; timestamp: string }> };
    const abortEvent = trace.events.find((e) => e.type === 'abort');
    expect(abortEvent).toBeDefined();
    expect(typeof abortEvent!.timestamp).toBe('string');
  });
});

// ── endTrace ─────────────────────────────────────────────────────────────────

describe('TraceLogger — endTrace', () => {
  it('writes an NDJSON file to the traces directory', async () => {
    const tracesDir = join(tmpDir, 'traces');
    const logger = new TraceLogger({ tracesDir });
    const id = logger.startTrace('claude-code', 'conv-1', 'hello world', makeContext(), makeOptions());
    logger.endTrace(id, makeResult());
    await logger.waitForFlush();

    const files = require('fs').readdirSync(tracesDir);
    expect(files.some((f: string) => f.endsWith('.ndjson'))).toBe(true);
  });

  it('written trace contains expected top-level fields', async () => {
    const tracesDir = join(tmpDir, 'traces');
    const logger = new TraceLogger({ tracesDir });
    const id = logger.startTrace('opencode', 'conv-42', 'refactor auth', makeContext(), makeOptions());
    logger.endTrace(id, makeResult({ output: 'Done.', durationMs: 500 }));
    await logger.waitForFlush();

    const traces = readTraceFile(tracesDir);
    const trace = traces[0] as Record<string, unknown>;
    expect(trace.traceId).toBeDefined();
    expect(trace.plugin).toBe('opencode');
    expect(trace.conversationId).toBe('conv-42');
    expect(trace.prompt).toBe('refactor auth');
    expect(trace.durationMs).toBe(500);
    expect(Array.isArray(trace.events)).toBe(true);
  });

  it('written trace contains the result', async () => {
    const tracesDir = join(tmpDir, 'traces');
    const logger = new TraceLogger({ tracesDir });
    const id = logger.startTrace('plugin', 'conv', 'do x', makeContext(), makeOptions());
    const result = makeResult({ success: false, output: 'err msg', durationMs: 999 });
    logger.endTrace(id, result);
    await logger.waitForFlush();

    const traces = readTraceFile(tracesDir);
    const trace = traces[0] as { result: PluginDispatchResult };
    expect(trace.result.success).toBe(false);
    expect(trace.result.output).toBe('err msg');
    expect(trace.result.durationMs).toBe(999);
  });

  it('does not throw for an unknown traceId', () => {
    const logger = new TraceLogger({ tracesDir: join(tmpDir, 'traces') });
    expect(() => logger.endTrace('ghost-id', makeResult())).not.toThrow();
  });

  it('is a no-op when disabled — writes no files', () => {
    const tracesDir = join(tmpDir, 'traces-off');
    mkdirSync(tracesDir, { recursive: true });
    const logger = new TraceLogger({ enabled: false, tracesDir });
    const id = logger.startTrace('plugin', 'conv', 'hi', makeContext(), makeOptions());
    logger.endTrace(id, makeResult());

    const files = require('fs').readdirSync(tracesDir);
    expect(files.filter((f: string) => f.endsWith('.ndjson'))).toHaveLength(0);
  });

  it('appends multiple traces to the same daily file', async () => {
    const tracesDir = join(tmpDir, 'traces');
    const logger = new TraceLogger({ tracesDir });

    const id1 = logger.startTrace('plugin', 'c1', 'first', makeContext(), makeOptions());
    logger.endTrace(id1, makeResult());
    await logger.waitForFlush();

    const id2 = logger.startTrace('plugin', 'c2', 'second', makeContext(), makeOptions());
    logger.endTrace(id2, makeResult());
    await logger.waitForFlush();

    const traces = readTraceFile(tracesDir);
    expect(traces.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Retention cleanup ─────────────────────────────────────────────────────────

describe('TraceLogger — retention cleanup', () => {
  it('deletes trace files older than retentionDays', async () => {
    const tracesDir = join(tmpDir, 'traces-retention');
    mkdirSync(tracesDir, { recursive: true });

    // Plant an old file with mtime set to 30 days ago
    const oldFile = join(tracesDir, '2020-01-01.ndjson');
    writeFileSync(oldFile, '{"old":true}\n');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, thirtyDaysAgo, thirtyDaysAgo);

    // Construction triggers async cleanup — await it so the assertion sees the result
    const logger = new TraceLogger({ tracesDir, retentionDays: 7 });
    await logger.waitForCleanup();

    expect(existsSync(oldFile)).toBe(false);
  });

  it('keeps trace files within the retention window', async () => {
    const tracesDir = join(tmpDir, 'traces-keep');
    mkdirSync(tracesDir, { recursive: true });

    // Plant a recent file (mtime = now, so well within retention)
    const recentFile = join(tracesDir, '2099-12-31.ndjson');
    writeFileSync(recentFile, '{"recent":true}\n');

    const logger = new TraceLogger({ tracesDir, retentionDays: 7 });
    await logger.waitForCleanup();

    expect(existsSync(recentFile)).toBe(true);
  });

  it('ignores non-.ndjson files during cleanup', async () => {
    const tracesDir = join(tmpDir, 'traces-misc');
    mkdirSync(tracesDir, { recursive: true });

    const txtFile = join(tracesDir, 'notes.txt');
    writeFileSync(txtFile, 'ignore me');
    const veryOld = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    utimesSync(txtFile, veryOld, veryOld);

    const logger = new TraceLogger({ tracesDir, retentionDays: 7 });
    await logger.waitForCleanup();

    expect(existsSync(txtFile)).toBe(true);
  });

  it('does not throw when traces directory does not exist yet', async () => {
    const tracesDir = join(tmpDir, 'traces-nonexistent');
    // Do NOT create the directory; let the constructor handle it
    const logger = new TraceLogger({ tracesDir, retentionDays: 7 });
    await expect(logger.waitForCleanup()).resolves.toBeUndefined();
  });
});

// ── Full lifecycle ────────────────────────────────────────────────────────────

describe('TraceLogger — full start → record → end lifecycle', () => {
  it('produces a valid, parseable NDJSON trace with all recorded events', async () => {
    const tracesDir = join(tmpDir, 'traces-lifecycle');
    const logger = new TraceLogger({ tracesDir });

    const context = makeContext({ codebaseContext: 'TypeScript', gitContext: 'main' });
    const options = makeOptions({ conversationId: 'conv-lifecycle', model: 'claude-3-5-sonnet' });

    const id = logger.startTrace('claude-code', 'conv-lifecycle', 'add feature X', context, options);

    logger.recordEvent(id, 'token', { text: 'Sure, ' });
    logger.recordEvent(id, 'token', { text: 'I will ' });
    logger.recordEvent(id, 'tool_call', { tool: 'Write', path: 'src/feature.ts' });
    logger.recordEvent(id, 'tool_result', { tool: 'Write', ok: true });

    const result = makeResult({
      taskId: id,
      success: true,
      output: 'Feature X added.',
      durationMs: 3210,
    });
    logger.endTrace(id, result);
    await logger.waitForFlush();

    const traces = readTraceFile(tracesDir);
    expect(traces).toHaveLength(1);

    const trace = traces[0] as {
      traceId: string;
      plugin: string;
      conversationId: string;
      prompt: string;
      events: Array<{ type: string }>;
      result: { success: boolean };
      durationMs: number;
    };

    expect(trace.traceId).toBe(id);
    expect(trace.plugin).toBe('claude-code');
    expect(trace.conversationId).toBe('conv-lifecycle');
    expect(trace.prompt).toBe('add feature X');
    expect(trace.events).toHaveLength(4);
    expect(trace.result.success).toBe(true);
    expect(trace.durationMs).toBe(3210);
  });
});

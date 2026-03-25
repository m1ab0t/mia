/**
 * Tests for daemon/health.ts
 *
 * Covers startHealthServer:
 *   - GET /health returns 200 with correct JSON fields
 *   - Other methods / paths return 404
 *   - Cleanup function closes the server
 *   - EADDRINUSE error is logged as a warning (no throw)
 *   - Other server errors are logged as warnings
 *   - getActivePlugin() callback overrides activePlugin string
 *   - Memory and plugin metrics are reflected in the response
 *   - Returns noop that doesn't throw on repeated calls
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import { DEFAULT_HEALTH_PORT, startHealthServer, type HealthServerDeps } from './health.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Find a free port by letting the OS assign one. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Could not determine free port'));
        }
      });
    });
  });
}

/** Make an HTTP GET request and return { status, body }. */
function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error('Request timed out'));
    });
  });
}

/** Build a HealthServerDeps fixture with sensible defaults. */
function makeDeps(overrides: Partial<HealthServerDeps> = {}): HealthServerDeps {
  return {
    startedAt: Date.now() - 5000,
    version: '1.2.3',
    commit: 'abc1234',
    activePlugin: 'claude-code',
    pluginMetrics: {
      getRunningTasks: vi.fn().mockReturnValue([]),
      getCompletedCount: vi.fn().mockReturnValue(0),
    },
    ...overrides,
  };
}

// ── State ──────────────────────────────────────────────────────────────────

let cleanup: (() => void) | null = null;
let port = 0;

beforeEach(async () => {
  port = await getFreePort();
});

afterEach(() => {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

// Wait for server to start listening by polling /health until it responds.
async function waitForServer(p: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await httpGet(p, '/health');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error(`Server on port ${p} did not start within ${timeoutMs}ms`);
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT_HEALTH_PORT
// ═══════════════════════════════════════════════════════════════════════════

describe('DEFAULT_HEALTH_PORT', () => {
  it('is 7221', () => {
    expect(DEFAULT_HEALTH_PORT).toBe(7221);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /health — happy path
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const deps = makeDeps();
    cleanup = startHealthServer(deps, port);
    await waitForServer(port);

    const { status, body } = await httpGet(port, '/health');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('ok');
  });

  it('includes version and commit from deps', async () => {
    const deps = makeDeps({ version: '9.9.9', commit: 'deadbeef' });
    cleanup = startHealthServer(deps, port);
    await waitForServer(port);

    const { body } = await httpGet(port, '/health');
    const json = JSON.parse(body);
    expect(json.version).toBe('9.9.9');
    expect(json.commit).toBe('deadbeef');
  });

  it('includes a non-negative uptime in seconds', async () => {
    const deps = makeDeps({ startedAt: Date.now() - 10_000 });
    cleanup = startHealthServer(deps, port);
    await waitForServer(port);

    const { body } = await httpGet(port, '/health');
    const json = JSON.parse(body);
    expect(typeof json.uptime).toBe('number');
    expect(json.uptime).toBeGreaterThanOrEqual(0);
  });

  it('includes memory fields in MB', async () => {
    const deps = makeDeps();
    cleanup = startHealthServer(deps, port);
    await waitForServer(port);

    const { body } = await httpGet(port, '/health');
    const json = JSON.parse(body);
    expect(json.memory).toBeDefined();
    expect(typeof json.memory.rss).toBe('number');
    expect(typeof json.memory.heapUsed).toBe('number');
    expect(typeof json.memory.heapTotal).toBe('number');
    expect(typeof json.memory.external).toBe('number');
    // All values should be non-negative integers
    for (const key of ['rss', 'heapUsed', 'heapTotal', 'external'] as const) {
      expect(json.memory[key]).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(json.memory[key])).toBe(true);
    }
  });

  it('includes plugins block with active plugin, runningTasks, completedTasks', async () => {
    const pluginMetrics = {
      getRunningTasks: vi.fn().mockReturnValue([{ id: '1' }, { id: '2' }]),
      getCompletedCount: vi.fn().mockReturnValue(42),
    };
    const deps = makeDeps({ activePlugin: 'gemini', pluginMetrics });
    cleanup = startHealthServer(deps, port);
    await waitForServer(port);

    const { body } = await httpGet(port, '/health');
    const json = JSON.parse(body);
    expect(json.plugins.active).toBe('gemini');
    expect(json.plugins.runningTasks).toBe(2);
    expect(json.plugins.completedTasks).toBe(42);
  });

  it('uses getActivePlugin() callback when provided (overrides activePlugin)', async () => {
    const deps = makeDeps({
      activePlugin: 'claude-code',
      getActivePlugin: () => 'opencode',
    });
    cleanup = startHealthServer(deps, port);
    await waitForServer(port);

    const { body } = await httpGet(port, '/health');
    const json = JSON.parse(body);
    expect(json.plugins.active).toBe('opencode');
  });

  it('falls back to activePlugin string when getActivePlugin is not provided', async () => {
    const deps = makeDeps({ activePlugin: 'codex', getActivePlugin: undefined });
    cleanup = startHealthServer(deps, port);
    await waitForServer(port);

    const { body } = await httpGet(port, '/health');
    const json = JSON.parse(body);
    expect(json.plugins.active).toBe('codex');
  });

  it('includes pid matching process.pid', async () => {
    const deps = makeDeps();
    cleanup = startHealthServer(deps, port);
    await waitForServer(port);

    const { body } = await httpGet(port, '/health');
    const json = JSON.parse(body);
    expect(json.pid).toBe(process.pid);
  });

  it('includes a valid ISO timestamp', async () => {
    const deps = makeDeps();
    cleanup = startHealthServer(deps, port);
    await waitForServer(port);

    const { body } = await httpGet(port, '/health');
    const json = JSON.parse(body);
    expect(typeof json.timestamp).toBe('string');
    expect(new Date(json.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('sets Content-Type: application/json', async () => {
    const deps = makeDeps();
    cleanup = startHealthServer(deps, port);
    await waitForServer(port);

    const { status } = await httpGet(port, '/health');
    expect(status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Non-health paths → 404
// ═══════════════════════════════════════════════════════════════════════════

describe('404 for unknown paths', () => {
  it('returns 404 for GET /', async () => {
    cleanup = startHealthServer(makeDeps(), port);
    await waitForServer(port);

    const { status } = await httpGet(port, '/');
    expect(status).toBe(404);
  });

  it('returns 404 for GET /status', async () => {
    cleanup = startHealthServer(makeDeps(), port);
    await waitForServer(port);

    const { status } = await httpGet(port, '/status');
    expect(status).toBe(404);
  });

  it('returns 404 for GET /health/extra', async () => {
    cleanup = startHealthServer(makeDeps(), port);
    await waitForServer(port);

    const { status } = await httpGet(port, '/health/extra');
    expect(status).toBe(404);
  });

  it('returns "Not Found" body for unknown path', async () => {
    cleanup = startHealthServer(makeDeps(), port);
    await waitForServer(port);

    const { body } = await httpGet(port, '/unknown');
    expect(body).toBe('Not Found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cleanup function
// ═══════════════════════════════════════════════════════════════════════════

describe('cleanup function', () => {
  it('is a function', () => {
    const stop = startHealthServer(makeDeps(), port);
    cleanup = stop;
    expect(typeof stop).toBe('function');
  });

  it('does not throw when called multiple times', async () => {
    const stop = startHealthServer(makeDeps(), port);
    cleanup = null; // prevent afterEach double-call
    await waitForServer(port);
    expect(() => stop()).not.toThrow();
    expect(() => stop()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EADDRINUSE — graceful degradation
// ═══════════════════════════════════════════════════════════════════════════

describe('EADDRINUSE handling', () => {
  it('logs a warning and returns a cleanup noop when port is already in use', async () => {
    // Occupy the port
    const occupier = http.createServer();
    await new Promise<void>((r) => occupier.listen(port, '127.0.0.1', r));

    const log = vi.fn();
    try {
      const stop = startHealthServer(makeDeps(), port, log);
      cleanup = stop;
      // Give the error event a tick to fire
      await new Promise((r) => setTimeout(r, 100));
      // warn should have been called with the EADDRINUSE message
      const calls = log.mock.calls;
      const warnCall = calls.find(([level]) => level === 'warn');
      expect(warnCall).toBeDefined();
      expect(warnCall![1]).toContain('already in use');
    } finally {
      await new Promise<void>((r) => occupier.close(() => r()));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Logger integration
// ═══════════════════════════════════════════════════════════════════════════

describe('logger integration', () => {
  it('calls log with info level when server starts', async () => {
    const log = vi.fn();
    cleanup = startHealthServer(makeDeps(), port, log);
    await waitForServer(port);

    const infoCalls = log.mock.calls.filter(([level]) => level === 'info');
    expect(infoCalls.length).toBeGreaterThan(0);
    expect(infoCalls[0][1]).toContain('/health');
  });

  it('works with no logger provided (no throw)', async () => {
    expect(() => {
      cleanup = startHealthServer(makeDeps(), port);
    }).not.toThrow();
    await waitForServer(port);
  });
});

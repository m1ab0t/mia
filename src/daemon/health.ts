/**
 * Lightweight HTTP health-check endpoint for external probes (PM2, uptime monitors, etc.).
 *
 * Listens on 0.0.0.0 (all interfaces) for external monitoring probes.
 * Default port: 7221, configurable via MIA_HEALTH_PORT env var or mia.json daemon.healthPort.
 *
 * GET /health → 200 JSON with uptime, memory, and plugin status.
 * Any other path → 404.
 */

import { createServer, type Server } from 'node:http';
import type { PluginMetrics } from './status';

export const DEFAULT_HEALTH_PORT = 7221;

export interface HealthServerDeps {
  startedAt: number;
  version: string;
  commit: string;
  activePlugin: string;
  pluginMetrics: PluginMetrics;
  getActivePlugin?: () => string;
}

/** Maximum concurrent connections to prevent FD exhaustion from slow/stuck clients. */
const MAX_CONNECTIONS = 10;

/** Socket idle timeout (ms). Connections with no activity are killed after this. */
const SOCKET_TIMEOUT_MS = 5_000;

/** Keep-alive timeout (ms). Prevents idle persistent connections from leaking FDs. */
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

/**
 * Start the health-check HTTP server.
 *
 * Returns a cleanup function that closes the server.
 * If the port is already in use, logs a warning and returns a noop.
 */
export function startHealthServer(
  deps: HealthServerDeps,
  port: number = DEFAULT_HEALTH_PORT,
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void,
): () => void {
  const logger = log ?? (() => {});

  const server: Server = createServer((req, res) => {
    // Only respond to GET /health
    if (req.method !== 'GET' || req.url !== '/health') {
      // Drain any unread request body before responding.
      //
      // For HTTP/1.1 keep-alive connections that send a body (POST, PUT, etc.),
      // Node.js's HTTP/1.1 framing requires the body to be fully consumed before
      // the socket can be safely reused for the next request.  Without req.resume(),
      // the socket sits in a "dirty" state — unread bytes remain in the receive
      // buffer — and Node.js sets Connection: close to avoid protocol confusion.
      // That means every unexpected request forces a TCP teardown + reconnect, which:
      //   1. Holds the socket FD open until the OS reclaims it (up to TIME_WAIT)
      //   2. Under probe storms (aggressive monitoring, port scanners) can race the
      //      maxConnections=10 cap, blocking legitimate health probes
      //
      // req.resume() puts the request stream in flowing mode so Node.js discards
      // the body immediately, the socket stays clean, and the connection is either
      // properly recycled (keep-alive) or cleanly closed — no FD held beyond the
      // response.  This is the correct HTTP-level fix; the socket timeout is a
      // second line of defence, not a replacement.
      try { req.resume(); } catch { /* stream already ended or destroyed */ }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    try {
      const now = Date.now();
      const mem = process.memoryUsage();
      const running = deps.pluginMetrics.getRunningTasks();
      const activePlugin = deps.getActivePlugin?.() ?? deps.activePlugin;

      const body = JSON.stringify({
        status: 'ok',
        uptime: Math.round((now - deps.startedAt) / 1000),
        version: deps.version,
        commit: deps.commit,
        memory: {
          rss: Math.round(mem.rss / 1024 / 1024),
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          external: Math.round(mem.external / 1024 / 1024),
        },
        plugins: {
          active: activePlugin,
          runningTasks: running.length,
          completedTasks: deps.pluginMetrics.getCompletedCount(),
        },
        pid: process.pid,
        timestamp: new Date(now).toISOString(),
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  // ── Connection safety limits ──────────────────────────────────────
  // The health server listens on 0.0.0.0 (all interfaces), so it's
  // reachable from the network. Without limits, slow or malicious
  // clients can hold connections open indefinitely, exhausting the
  // process's file descriptor budget. Once FDs run out, the daemon
  // can't spawn plugin child processes — total loss of functionality.
  //
  // - maxConnections: hard cap on concurrent sockets. Excess connections
  //   are rejected at the TCP level (immediate RST). Health probes are
  //   tiny JSON responses; 10 concurrent is generous.
  // - keepAliveTimeout: close persistent connections after 5s of idle.
  //   Prevents keep-alive clients from pinning sockets open.
  // - socket timeout: per-socket inactivity guard. If a client opens a
  //   connection and sends nothing (slowloris), the socket is destroyed
  //   after 5s. Applied via the 'connection' event for full coverage.
  try {
    server.maxConnections = MAX_CONNECTIONS;
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    // requestTimeout was added in Node 18.0.0 — set it if available.
    // It limits how long the server waits for the complete request
    // (headers + body) before destroying the socket.
    if ('requestTimeout' in server) {
      (server as any).requestTimeout = SOCKET_TIMEOUT_MS;
    }
    server.on('connection', (socket) => {
      socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
        try { socket.destroy(); } catch { /* best-effort */ }
      });
    });
  } catch {
    // Safety: timeout configuration must never prevent the server from starting.
  }

  // Don't let the health server keep the process alive during shutdown.
  server.unref();

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger('warn', `Health server: port ${port} already in use — health endpoint disabled`);
    } else {
      logger('warn', `Health server error: ${err.message}`);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger('info', `Health endpoint listening on http://0.0.0.0:${port}/health`);
  });

  return () => {
    try {
      server.close();
    } catch {
      // Best-effort cleanup.
    }
  };
}

/**
 * TraceLogger — Structured persistent logging of plugin dispatches.
 *
 * Writes NDJSON to ~/.mia/traces/YYYY-MM-DD.ndjson
 * Enforces 7-day (configurable) retention by deleting old files on startup.
 */

import { existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { PluginContext, PluginDispatchResult, DispatchOptions } from './types';
import type { VerificationResult } from './verifier';

export interface TraceEvent {
  type: 'token' | 'tool_call' | 'tool_result' | 'abort' | 'error';
  timestamp: string;
  data: unknown;
}

export interface DispatchTrace {
  traceId: string;
  timestamp: string;
  plugin: string;
  conversationId: string;
  prompt: string;
  context: PluginContext;
  options: DispatchOptions;
  events: TraceEvent[];
  result?: PluginDispatchResult;
  verification?: VerificationResult;
  durationMs?: number;
}

export interface ToolLatencySummaryEntry {
  name: string;
  calls: number;
  avgMs: number;
  maxMs: number;
}

export interface TraceLoggerOptions {
  enabled?: boolean;
  retentionDays?: number;
  tracesDir?: string;
}

export class TraceLogger {
  private enabled: boolean;
  private retentionDays: number;
  private tracesDir: string;
  private activeTraces = new Map<string, DispatchTrace>();
  /** Short-lived cache: traceId → latency summary, kept until read once. */
  private latencySummaryCache = new Map<string, ToolLatencySummaryEntry[]>();

  constructor(opts: TraceLoggerOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.retentionDays = opts.retentionDays ?? 7;
    this.tracesDir = opts.tracesDir ?? join(homedir(), '.mia', 'traces');

    if (this.enabled) {
      this._ensureDir();
      this._cleanupOldTraces();
    }
  }

  /**
   * Start a new trace for a dispatch.
   * Returns the traceId.
   */
  startTrace(
    plugin: string,
    conversationId: string,
    prompt: string,
    context: PluginContext,
    options: DispatchOptions
  ): string {
    if (!this.enabled) return randomUUID();

    const traceId = randomUUID();
    const trace: DispatchTrace = {
      traceId,
      timestamp: new Date().toISOString(),
      plugin,
      conversationId,
      prompt,
      context,
      options,
      events: [],
    };

    this.activeTraces.set(traceId, trace);
    return traceId;
  }

  /**
   * Record an event for an active trace.
   */
  recordEvent(traceId: string, type: TraceEvent['type'], data: unknown): void {
    if (!this.enabled) return;

    const trace = this.activeTraces.get(traceId);
    if (!trace) return;

    trace.events.push({
      type,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  /**
   * End a trace and flush to disk.
   */
  endTrace(
    traceId: string,
    result: PluginDispatchResult,
    verification?: VerificationResult,
  ): void {
    if (!this.enabled) return;

    const trace = this.activeTraces.get(traceId);
    if (!trace) return;

    trace.result = result;
    trace.verification = verification;
    trace.durationMs = result.durationMs;

    // Build per-tool latency summary from tool_result events before flushing.
    const latencyMap = new Map<string, { totalMs: number; count: number; maxMs: number }>();
    for (const ev of trace.events) {
      if (ev.type !== 'tool_result') continue;
      const data = ev.data as Record<string, unknown> | null;
      const name = typeof data?.name === 'string' ? data.name : 'unknown';
      const latencyMs = typeof data?.latencyMs === 'number' ? data.latencyMs : null;
      if (latencyMs === null) continue;
      const entry = latencyMap.get(name) ?? { totalMs: 0, count: 0, maxMs: 0 };
      entry.totalMs += latencyMs;
      entry.count++;
      if (latencyMs > entry.maxMs) entry.maxMs = latencyMs;
      latencyMap.set(name, entry);
    }
    if (latencyMap.size > 0) {
      const summary: ToolLatencySummaryEntry[] = [];
      for (const [name, s] of latencyMap) {
        summary.push({ name, calls: s.count, avgMs: Math.round(s.totalMs / s.count), maxMs: s.maxMs });
      }
      this.latencySummaryCache.set(traceId, summary);
    }

    this._flush(trace);
    this.activeTraces.delete(traceId);
  }

  /**
   * Return the per-tool latency summary computed during `endTrace`.
   * Consumes the cached entry — subsequent calls return [].
   */
  summarizeToolLatency(traceId: string): ToolLatencySummaryEntry[] {
    const summary = this.latencySummaryCache.get(traceId) ?? [];
    this.latencySummaryCache.delete(traceId);
    return summary;
  }

  private _flush(trace: DispatchTrace): void {
    try {
      const dateStr = new Date().toISOString().substring(0, 10); // YYYY-MM-DD
      const filePath = join(this.tracesDir, `${dateStr}.ndjson`);
      const line = JSON.stringify(trace) + '\n';
      appendFileSync(filePath, line, 'utf-8');
    } catch {
      // Non-critical — trace logging should never crash the daemon
    }
  }

  private _ensureDir(): void {
    if (!existsSync(this.tracesDir)) {
      mkdirSync(this.tracesDir, { recursive: true });
    }
  }

  private _cleanupOldTraces(): void {
    try {
      if (!existsSync(this.tracesDir)) return;

      const cutoffMs = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      const files = readdirSync(this.tracesDir);

      for (const file of files) {
        if (!file.endsWith('.ndjson')) continue;
        const filePath = join(this.tracesDir, file);
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < cutoffMs) {
            unlinkSync(filePath);
          }
        } catch {
          // Non-critical
        }
      }
    } catch {
      // Non-critical
    }
  }
}

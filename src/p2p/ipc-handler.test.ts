/**
 * IpcHandler — unit tests.
 *
 * Covers:
 *   - send() with/without broken stdout
 *   - markStdoutBroken() flag
 *   - armShutdownWatchdog() force-exit after timeout
 *   - onStdinEnd() reentrancy guard + graceful shutdown sequence
 *   - handleDaemonCommand() routing for every DaemonToAgent variant
 *   - Pending-request resolution (plugins_list, scheduler_response,
 *     suggestions_list, daily_greeting_response, plugin_test_result,
 *     persona_generate_result)
 *   - get_recent_messages happy path + timeout fallback
 *   - shutdown reentrancy guard
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IpcHandler } from './ipc-handler.js';
import type { IpcHandlerOptions, SwarmFunctions, MessageStoreApi } from './ipc-handler.js';
import type { DaemonToAgent, PluginInfo, ScheduledTaskInfo, SuggestionInfo } from './ipc-types.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeSwarm(): SwarmFunctions {
  return {
    sendP2PRawToken: vi.fn().mockResolvedValue(undefined),
    sendP2PToolCall: vi.fn().mockResolvedValue(undefined),
    sendP2PToolResult: vi.fn().mockResolvedValue(undefined),
    sendP2PResponse: vi.fn().mockResolvedValue(undefined),
    sendP2PResponseForConversation: vi.fn().mockResolvedValue(undefined),
    sendP2PThinking: vi.fn().mockResolvedValue(undefined),
    sendP2PTokenUsage: vi.fn().mockResolvedValue(undefined),
    sendP2PDispatchCost: vi.fn(),
    sendP2PRouteInfo: vi.fn().mockResolvedValue(undefined),
    sendP2PBashStream: vi.fn().mockResolvedValue(undefined),
    sendP2PSchedulerLog: vi.fn(),
    broadcastConversationList: vi.fn().mockResolvedValue(undefined),
    broadcastPluginSwitched: vi.fn(),
    broadcastConfigReloaded: vi.fn(),
    broadcastQueueBackpressure: vi.fn(),
    broadcastQueueMessageDropped: vi.fn(),
    broadcastPluginError: vi.fn(),
    broadcastSuggestions: vi.fn(),
    broadcastTaskStatus: vi.fn(),
    disconnectP2P: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMessageStore(messages: Awaited<ReturnType<MessageStoreApi['getRecentMessages']>> = []): MessageStoreApi {
  return {
    getRecentMessages: vi.fn().mockResolvedValue(messages),
  };
}

function makeOpts(
  overrides: Partial<IpcHandlerOptions> = {},
): IpcHandlerOptions & { write: ReturnType<typeof vi.fn>; exit: ReturnType<typeof vi.fn>; logError: ReturnType<typeof vi.fn> } {
  const write = vi.fn();
  const exit = vi.fn();
  const logError = vi.fn();
  const ignoreError = vi.fn().mockReturnValue(vi.fn());
  return {
    write,
    exit,
    logError,
    ignoreError,
    swarm: makeSwarm(),
    messageStore: makeMessageStore(),
    ...overrides,
  };
}

// ── send() ────────────────────────────────────────────────────────────────

describe('IpcHandler.send()', () => {
  it('writes JSON-encoded message when stdout is intact', () => {
    const opts = makeOpts();
    const handler = new IpcHandler(opts);
    handler.send({ type: 'ready', key: 'abc123' });
    expect(opts.write).toHaveBeenCalledOnce();
    const written = opts.write.mock.calls[0][0];
    expect(JSON.parse(written)).toMatchObject({ type: 'ready', key: 'abc123' });
  });

  it('appends a newline to the written payload', () => {
    const opts = makeOpts();
    const handler = new IpcHandler(opts);
    handler.send({ type: 'peer_connected', peerCount: 1 });
    expect(opts.write.mock.calls[0][0]).toMatch(/\n$/);
  });

  it('drops silently when stdout is broken', () => {
    const opts = makeOpts();
    const handler = new IpcHandler(opts);
    handler.markStdoutBroken();
    handler.send({ type: 'peer_connected', peerCount: 1 });
    expect(opts.write).not.toHaveBeenCalled();
  });
});

// ── markStdoutBroken() / isStdoutBroken ──────────────────────────────────

describe('IpcHandler stdout broken flag', () => {
  it('isStdoutBroken starts false', () => {
    const handler = new IpcHandler(makeOpts());
    expect(handler.isStdoutBroken).toBe(false);
  });

  it('markStdoutBroken() sets isStdoutBroken to true', () => {
    const handler = new IpcHandler(makeOpts());
    handler.markStdoutBroken();
    expect(handler.isStdoutBroken).toBe(true);
  });
});

// ── armShutdownWatchdog() ─────────────────────────────────────────────────

describe('IpcHandler.armShutdownWatchdog()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('calls exit(1) after SHUTDOWN_TIMEOUT_MS if not cleared', () => {
    const opts = makeOpts();
    const handler = new IpcHandler(opts);
    handler.armShutdownWatchdog();
    vi.advanceTimersByTime(IpcHandler.SHUTDOWN_TIMEOUT_MS);
    expect(opts.exit).toHaveBeenCalledWith(1);
  });

  it('does NOT call exit if cleared before timeout', () => {
    const opts = makeOpts();
    const handler = new IpcHandler(opts);
    const timer = handler.armShutdownWatchdog();
    clearTimeout(timer);
    vi.advanceTimersByTime(IpcHandler.SHUTDOWN_TIMEOUT_MS + 1000);
    expect(opts.exit).not.toHaveBeenCalled();
  });
});

// ── onStdinEnd() ──────────────────────────────────────────────────────────

describe('IpcHandler.onStdinEnd()', () => {
  it('calls disconnectP2P and then exit(0)', async () => {
    const opts = makeOpts();
    const handler = new IpcHandler(opts);
    // Override armShutdownWatchdog to avoid timer leak in test
    vi.spyOn(handler, 'armShutdownWatchdog').mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
    await handler.onStdinEnd();
    expect(opts.swarm.disconnectP2P).toHaveBeenCalled();
    expect(opts.exit).toHaveBeenCalledWith(0);
  });

  it('is idempotent — second call is a no-op', async () => {
    const opts = makeOpts();
    const handler = new IpcHandler(opts);
    vi.spyOn(handler, 'armShutdownWatchdog').mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
    await handler.onStdinEnd();
    await handler.onStdinEnd();
    expect(opts.swarm.disconnectP2P).toHaveBeenCalledOnce();
    expect(opts.exit).toHaveBeenCalledOnce();
  });

  it('sets shutdownInProgress to true', async () => {
    const opts = makeOpts();
    const handler = new IpcHandler(opts);
    vi.spyOn(handler, 'armShutdownWatchdog').mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
    expect(handler.shutdownInProgress).toBe(false);
    await handler.onStdinEnd();
    expect(handler.shutdownInProgress).toBe(true);
  });
});

// ── handleDaemonCommand() — streaming / broadcast variants ────────────────

describe('IpcHandler.handleDaemonCommand() — streaming', () => {
  let opts: ReturnType<typeof makeOpts>;
  let handler: IpcHandler;

  beforeEach(() => {
    opts = makeOpts();
    handler = new IpcHandler(opts);
  });

  it('token → sendP2PRawToken', async () => {
    await handler.handleDaemonCommand({ type: 'token', text: 'hello', conversationId: 'c1' });
    expect(opts.swarm.sendP2PRawToken).toHaveBeenCalledWith('hello', 'c1');
  });

  it('tool_call → sendP2PToolCall with all opts', async () => {
    const cmd: DaemonToAgent = {
      type: 'tool_call',
      name: 'bash',
      input: { cmd: 'ls' },
      conversationId: 'c2',
      toolCallId: 'tc1',
      description: 'List files',
      filePath: '/tmp/x',
    };
    await handler.handleDaemonCommand(cmd);
    expect(opts.swarm.sendP2PToolCall).toHaveBeenCalledWith(
      'bash',
      { cmd: 'ls' },
      'c2',
      { toolCallId: 'tc1', description: 'List files', filePath: '/tmp/x' },
    );
  });

  it('tool_result → sendP2PToolResult', async () => {
    const cmd: DaemonToAgent = {
      type: 'tool_result',
      name: 'bash',
      result: 'ok',
      error: false,
      conversationId: 'c3',
      toolCallId: 'tc2',
      duration: 100,
      exitCode: 0,
      truncated: false,
    };
    await handler.handleDaemonCommand(cmd);
    expect(opts.swarm.sendP2PToolResult).toHaveBeenCalledWith(
      'bash', 'ok', false, 'c3',
      { toolCallId: 'tc2', duration: 100, exitCode: 0, truncated: false },
    );
  });

  it('response → sendP2PResponse', async () => {
    await handler.handleDaemonCommand({ type: 'response', message: 'hi' });
    expect(opts.swarm.sendP2PResponse).toHaveBeenCalledWith('hi');
  });

  it('response_for_conversation → sendP2PResponseForConversation', async () => {
    await handler.handleDaemonCommand({ type: 'response_for_conversation', message: 'yo', conversationId: 'cx' });
    expect(opts.swarm.sendP2PResponseForConversation).toHaveBeenCalledWith('yo', 'cx');
  });

  it('thinking → sendP2PThinking', async () => {
    await handler.handleDaemonCommand({ type: 'thinking', content: '...', conversationId: 'cy' });
    expect(opts.swarm.sendP2PThinking).toHaveBeenCalledWith('...', 'cy');
  });

  it('token_usage → sendP2PTokenUsage', async () => {
    await handler.handleDaemonCommand({
      type: 'token_usage',
      currentTokens: 100,
      maxTokens: 200000,
      percentUsed: 0.05,
      model: 'claude-opus-4-5',
      conversationId: 'cz',
    });
    expect(opts.swarm.sendP2PTokenUsage).toHaveBeenCalledWith(100, 200000, 0.05, 'claude-opus-4-5', 'cz');
  });

  it('dispatch_cost → sendP2PDispatchCost', async () => {
    const costPayload = {
      conversationId: 'c4',
      model: 'claude-opus-4-5',
      inputTokens: 500,
      outputTokens: 150,
      cachedTokens: 0,
      estimatedCostUsd: 0.01,
      durationMs: 3000,
      plugin: 'claude-code',
    };
    await handler.handleDaemonCommand({ type: 'dispatch_cost', ...costPayload });
    expect(opts.swarm.sendP2PDispatchCost).toHaveBeenCalledWith(costPayload);
  });

  it('route_info → sendP2PRouteInfo', async () => {
    await handler.handleDaemonCommand({ type: 'route_info', route: 'coding', reason: 'has code' });
    expect(opts.swarm.sendP2PRouteInfo).toHaveBeenCalledWith('coding', 'has code');
  });

  it('bash_stream → sendP2PBashStream', async () => {
    await handler.handleDaemonCommand({
      type: 'bash_stream',
      toolCallId: 'tc3',
      chunk: 'line\n',
      stream: 'stdout',
      conversationId: 'c5',
    });
    expect(opts.swarm.sendP2PBashStream).toHaveBeenCalledWith('tc3', 'line\n', 'stdout', 'c5');
  });

  it('scheduler_log → sendP2PSchedulerLog', async () => {
    await handler.handleDaemonCommand({
      type: 'scheduler_log',
      level: 'info',
      message: 'done',
      taskId: 'tid1',
      taskName: 'nightly',
      elapsedMs: 420,
    });
    expect(opts.swarm.sendP2PSchedulerLog).toHaveBeenCalledWith('info', 'done', 'tid1', 'nightly', 420);
  });
});

// ── handleDaemonCommand() — broadcast variants ────────────────────────────

describe('IpcHandler.handleDaemonCommand() — broadcasts', () => {
  let opts: ReturnType<typeof makeOpts>;
  let handler: IpcHandler;

  beforeEach(() => {
    opts = makeOpts();
    handler = new IpcHandler(opts);
  });

  it('broadcast_conversation_list → broadcastConversationList', async () => {
    await handler.handleDaemonCommand({ type: 'broadcast_conversation_list' });
    expect(opts.swarm.broadcastConversationList).toHaveBeenCalledOnce();
  });

  it('broadcast_plugin_switched → broadcastPluginSwitched', async () => {
    await handler.handleDaemonCommand({ type: 'broadcast_plugin_switched', activePlugin: 'opencode' });
    expect(opts.swarm.broadcastPluginSwitched).toHaveBeenCalledWith('opencode');
  });

  it('broadcast_config_reloaded → broadcastConfigReloaded', async () => {
    await handler.handleDaemonCommand({ type: 'broadcast_config_reloaded', changes: ['plugin', 'persona'] });
    expect(opts.swarm.broadcastConfigReloaded).toHaveBeenCalledWith(['plugin', 'persona']);
  });

  it('task_status → broadcastTaskStatus', async () => {
    await handler.handleDaemonCommand({ type: 'task_status', running: true, conversationId: 'c9' });
    expect(opts.swarm.broadcastTaskStatus).toHaveBeenCalledWith(true, 'c9');
  });

  it('queue_backpressure → broadcastQueueBackpressure', async () => {
    await handler.handleDaemonCommand({ type: 'queue_backpressure', depth: 5, maxDepth: 10 });
    expect(opts.swarm.broadcastQueueBackpressure).toHaveBeenCalledWith(5, 10);
  });

  it('queue_message_dropped → broadcastQueueMessageDropped', async () => {
    await handler.handleDaemonCommand({ type: 'queue_message_dropped', source: 'p2p', message: 'ask me something' });
    expect(opts.swarm.broadcastQueueMessageDropped).toHaveBeenCalledWith('p2p', 'ask me something');
  });

  it('plugin_error → broadcastPluginError', async () => {
    const payload = {
      code: 'TIMEOUT',
      message: 'Plugin timed out',
      plugin: 'claude-code',
      taskId: 'task-1',
      conversationId: 'cA',
      timestamp: '2026-01-01T00:00:00.000Z',
      detail: { exitCode: 1 },
    };
    await handler.handleDaemonCommand({ type: 'plugin_error', ...payload });
    expect(opts.swarm.broadcastPluginError).toHaveBeenCalledWith(payload);
  });

  it('broadcast_suggestions → broadcastSuggestions with greetings', async () => {
    const suggestions: SuggestionInfo[] = [{ id: 's1', name: 'S1', description: 'Desc', createdAt: 1 }];
    await handler.handleDaemonCommand({ type: 'broadcast_suggestions', suggestions, greetings: ['Hi!'] });
    expect(opts.swarm.broadcastSuggestions).toHaveBeenCalledWith(suggestions, ['Hi!']);
  });

  it('broadcast_suggestions with missing greetings defaults to []', async () => {
    await handler.handleDaemonCommand({ type: 'broadcast_suggestions', suggestions: [] });
    expect(opts.swarm.broadcastSuggestions).toHaveBeenCalledWith([], []);
  });
});

// ── handleDaemonCommand() — pending request resolution ───────────────────

describe('IpcHandler.handleDaemonCommand() — pending requests', () => {
  let opts: ReturnType<typeof makeOpts>;
  let handler: IpcHandler;

  beforeEach(() => {
    opts = makeOpts();
    handler = new IpcHandler(opts);
  });

  // helpers to manually plant a pending request
  function plantRequest<T>(
    map: Map<string, { resolve: (v: T) => void; timer: ReturnType<typeof setTimeout> }>,
    id: string,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      map.set(id, { resolve, timer: setTimeout(() => {}, 60_000) });
    });
  }

  it('plugins_list resolves the matching pending request', async () => {
    const plugins: PluginInfo[] = [
      { name: 'claude-code', enabled: true, isActive: true, available: true },
    ];
    const pending = plantRequest(handler.pendingPluginRequests, 'req-1');
    await handler.handleDaemonCommand({
      type: 'plugins_list',
      requestId: 'req-1',
      plugins,
      activePlugin: 'claude-code',
    });
    const result = await pending;
    expect(result).toEqual({ plugins, activePlugin: 'claude-code' });
    expect(handler.pendingPluginRequests.has('req-1')).toBe(false);
  });

  it('plugins_list ignores unknown requestId', async () => {
    // Should not throw
    await expect(
      handler.handleDaemonCommand({
        type: 'plugins_list',
        requestId: 'no-such-id',
        plugins: [],
        activePlugin: '',
      }),
    ).resolves.toBeUndefined();
  });

  it('scheduler_response resolves the matching pending request', async () => {
    const tasks: ScheduledTaskInfo[] = [
      { id: 'tid', name: 'nightly', cronExpression: '0 3 * * *', task: 'recap', enabled: true, createdAt: 0, runCount: 0 },
    ];
    const pending = plantRequest(handler.pendingSchedulerRequests, 'sched-1');
    await handler.handleDaemonCommand({ type: 'scheduler_response', requestId: 'sched-1', tasks });
    const result = await pending;
    expect(result).toEqual(tasks);
  });

  it('suggestions_list resolves the matching pending request', async () => {
    const suggestions: SuggestionInfo[] = [{ id: 'sg1', name: 'S', description: 'D', createdAt: 1 }];
    const pending = plantRequest(handler.pendingSuggestionsRequests, 'sugg-1');
    await handler.handleDaemonCommand({ type: 'suggestions_list', requestId: 'sugg-1', suggestions });
    const result = await pending;
    expect(result).toEqual(suggestions);
  });

  it('daily_greeting_response resolves the matching pending request', async () => {
    const pending = plantRequest(handler.pendingDailyGreetingRequests, 'greet-1');
    await handler.handleDaemonCommand({ type: 'daily_greeting_response', requestId: 'greet-1', message: 'Good morning!' });
    const result = await pending;
    expect(result).toBe('Good morning!');
  });

  it('plugin_test_result resolves the matching pending request', async () => {
    const pending = plantRequest(handler.pendingTestRequests, 'test-1');
    await handler.handleDaemonCommand({
      type: 'plugin_test_result',
      requestId: 'test-1',
      success: true,
      output: 'All OK',
      elapsed: 250,
      pluginName: 'claude-code',
    });
    const result = await pending;
    expect(result).toMatchObject({ success: true, output: 'All OK', elapsed: 250, pluginName: 'claude-code' });
  });

  it('plugin_test_result includes error field when provided', async () => {
    const pending = plantRequest(handler.pendingTestRequests, 'test-2');
    await handler.handleDaemonCommand({
      type: 'plugin_test_result',
      requestId: 'test-2',
      success: false,
      output: '',
      elapsed: 50,
      pluginName: 'opencode',
      error: 'binary not found',
    });
    const result = await pending;
    expect(result.error).toBe('binary not found');
  });

  it('persona_generate_result resolves with content on success', async () => {
    const p = new Promise<string>((resolve, reject) => {
      handler.pendingPersonaGenerateRequests.set('pg-1', {
        resolve,
        reject,
        timer: setTimeout(() => {}, 60_000),
      });
    });
    await handler.handleDaemonCommand({ type: 'persona_generate_result', requestId: 'pg-1', content: 'Be helpful.' });
    await expect(p).resolves.toBe('Be helpful.');
    expect(handler.pendingPersonaGenerateRequests.has('pg-1')).toBe(false);
  });

  it('persona_generate_result rejects with error when error field is set', async () => {
    const p = new Promise<string>((resolve, reject) => {
      handler.pendingPersonaGenerateRequests.set('pg-2', {
        resolve,
        reject,
        timer: setTimeout(() => {}, 60_000),
      });
    });
    await handler.handleDaemonCommand({
      type: 'persona_generate_result',
      requestId: 'pg-2',
      content: '',
      error: 'LLM error',
    });
    await expect(p).rejects.toThrow('LLM error');
  });

  it('persona_generate_result ignores unknown requestId', async () => {
    await expect(
      handler.handleDaemonCommand({
        type: 'persona_generate_result',
        requestId: 'no-such',
        content: 'x',
      }),
    ).resolves.toBeUndefined();
  });
});

// ── handleDaemonCommand() — get_recent_messages ───────────────────────────

describe('IpcHandler.handleDaemonCommand() — get_recent_messages', () => {
  it('sends recent_messages_response with store results on success', async () => {
    const msgs = [{ id: 'm1', conversationId: 'c1', type: 'token', content: 'hi', timestamp: 1 }];
    const opts = makeOpts({ messageStore: makeMessageStore(msgs) });
    const handler = new IpcHandler(opts);

    await handler.handleDaemonCommand({ type: 'get_recent_messages', requestId: 'rr-1', conversationId: 'c1', limit: 50 });

    expect(opts.write).toHaveBeenCalledOnce();
    const payload = JSON.parse(opts.write.mock.calls[0][0]);
    expect(payload).toMatchObject({ type: 'recent_messages_response', requestId: 'rr-1', messages: msgs });
  });

  it('sends empty messages array on store failure', async () => {
    const failStore: MessageStoreApi = {
      getRecentMessages: vi.fn().mockRejectedValue(new Error('DB locked')),
    };
    const opts = makeOpts({ messageStore: failStore });
    const handler = new IpcHandler(opts);

    await handler.handleDaemonCommand({ type: 'get_recent_messages', requestId: 'rr-2', conversationId: 'c2', limit: 50 });

    expect(opts.write).toHaveBeenCalledOnce();
    const payload = JSON.parse(opts.write.mock.calls[0][0]);
    expect(payload).toMatchObject({ type: 'recent_messages_response', requestId: 'rr-2', messages: [] });
  });

  it('sends empty messages array when withTimeout fires', async () => {
    // Simulate a store that never resolves (hangs indefinitely)
    const hangStore: MessageStoreApi = {
      getRecentMessages: vi.fn().mockReturnValue(new Promise(() => {})),
    };
    const opts = makeOpts({ messageStore: hangStore });
    const handler = new IpcHandler(opts);

    vi.useFakeTimers();
    const cmdPromise = handler.handleDaemonCommand({
      type: 'get_recent_messages',
      requestId: 'rr-3',
      conversationId: 'c3',
      limit: 50,
    });
    // Advance past the 8s withTimeout
    vi.advanceTimersByTime(9_000);
    await cmdPromise;
    vi.useRealTimers();

    expect(opts.write).toHaveBeenCalledOnce();
    const payload = JSON.parse(opts.write.mock.calls[0][0]);
    expect(payload).toMatchObject({ type: 'recent_messages_response', requestId: 'rr-3', messages: [] });
  });
});

// ── handleDaemonCommand() — shutdown ─────────────────────────────────────

describe('IpcHandler.handleDaemonCommand() — shutdown', () => {
  it('calls disconnectP2P and exit(0) on shutdown command', async () => {
    const opts = makeOpts();
    const handler = new IpcHandler(opts);
    vi.spyOn(handler, 'armShutdownWatchdog').mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);

    await handler.handleDaemonCommand({ type: 'shutdown' });

    expect(opts.swarm.disconnectP2P).toHaveBeenCalledOnce();
    expect(opts.exit).toHaveBeenCalledWith(0);
  });

  it('shutdown is idempotent — second call is a no-op', async () => {
    const opts = makeOpts();
    const handler = new IpcHandler(opts);
    vi.spyOn(handler, 'armShutdownWatchdog').mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);

    await handler.handleDaemonCommand({ type: 'shutdown' });
    await handler.handleDaemonCommand({ type: 'shutdown' });

    expect(opts.swarm.disconnectP2P).toHaveBeenCalledOnce();
    expect(opts.exit).toHaveBeenCalledOnce();
  });

  it('sets shutdownInProgress to true after shutdown', async () => {
    const opts = makeOpts();
    const handler = new IpcHandler(opts);
    vi.spyOn(handler, 'armShutdownWatchdog').mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);

    expect(handler.shutdownInProgress).toBe(false);
    await handler.handleDaemonCommand({ type: 'shutdown' });
    expect(handler.shutdownInProgress).toBe(true);
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe('IpcHandler edge cases', () => {
  it('send() serialises complex payloads correctly', () => {
    const opts = makeOpts();
    const handler = new IpcHandler(opts);
    handler.send({
      type: 'recent_messages_response',
      requestId: 'r1',
      messages: [{ id: 'm1', conversationId: 'c1', type: 'token', content: 'hi', timestamp: 1 }],
    });
    const parsed = JSON.parse(opts.write.mock.calls[0][0]);
    expect(parsed.messages[0].content).toBe('hi');
  });

  it('multiple pending maps start empty', () => {
    const handler = new IpcHandler(makeOpts());
    expect(handler.pendingPluginRequests.size).toBe(0);
    expect(handler.pendingSchedulerRequests.size).toBe(0);
    expect(handler.pendingSuggestionsRequests.size).toBe(0);
    expect(handler.pendingDailyGreetingRequests.size).toBe(0);
    expect(handler.pendingTestRequests.size).toBe(0);
    expect(handler.pendingPersonaGenerateRequests.size).toBe(0);
  });

  it('resolving a pending request removes it from the map', async () => {
    const opts = makeOpts();
    const handler = new IpcHandler(opts);
    handler.pendingSchedulerRequests.set('s1', {
      resolve: () => {},
      timer: setTimeout(() => {}, 60_000),
    });
    await handler.handleDaemonCommand({ type: 'scheduler_response', requestId: 's1', tasks: [] });
    expect(handler.pendingSchedulerRequests.has('s1')).toBe(false);
  });
});

// ── dedupRequest() ────────────────────────────────────────────────────────

describe('IpcHandler.dedupRequest()', () => {
  it('inFlightCount starts at zero', () => {
    const handler = new IpcHandler(makeOpts());
    expect(handler.inFlightCount).toBe(0);
  });

  it('calls factory exactly once for concurrent identical keys', async () => {
    const handler = new IpcHandler(makeOpts());
    let factoryCalls = 0;
    let resolveInner!: (v: string) => void;
    const factory = () => {
      factoryCalls++;
      return new Promise<string>((r) => { resolveInner = r; });
    };

    const p1 = handler.dedupRequest('same-key', factory);
    const p2 = handler.dedupRequest('same-key', factory);
    const p3 = handler.dedupRequest('same-key', factory);

    // All three callers get the same in-flight promise
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    expect(factoryCalls).toBe(1);

    resolveInner('result');
    await expect(p1).resolves.toBe('result');
    await expect(p2).resolves.toBe('result');
    await expect(p3).resolves.toBe('result');
  });

  it('removes key from in-flight map after the promise resolves', async () => {
    const handler = new IpcHandler(makeOpts());
    let resolve!: (v: number) => void;
    const p = handler.dedupRequest('k', () => new Promise<number>((r) => { resolve = r; }));

    expect(handler.inFlightCount).toBe(1);
    resolve(42);
    await p;
    expect(handler.inFlightCount).toBe(0);
  });

  it('removes key from in-flight map after the promise rejects', async () => {
    const handler = new IpcHandler(makeOpts());
    let reject!: (e: Error) => void;
    const p = handler.dedupRequest('k', () => new Promise<number>((_, r) => { reject = r; }));

    expect(handler.inFlightCount).toBe(1);
    reject(new Error('boom'));
    await expect(p).rejects.toThrow('boom');
    expect(handler.inFlightCount).toBe(0);
  });

  it('allows a fresh request after the previous one settles', async () => {
    const handler = new IpcHandler(makeOpts());
    let factoryCalls = 0;
    const makeFactory = (v: string) => () => { factoryCalls++; return Promise.resolve(v); };

    const r1 = await handler.dedupRequest('k', makeFactory('first'));
    expect(r1).toBe('first');
    expect(factoryCalls).toBe(1);

    // After settlement the key is gone — next call creates a new request
    const r2 = await handler.dedupRequest('k', makeFactory('second'));
    expect(r2).toBe('second');
    expect(factoryCalls).toBe(2);
  });

  it('tracks distinct keys independently', async () => {
    const handler = new IpcHandler(makeOpts());
    let resolveFoo!: (v: string) => void;
    let resolveBar!: (v: string) => void;

    const pFoo = handler.dedupRequest('foo', () => new Promise<string>((r) => { resolveFoo = r; }));
    const pBar = handler.dedupRequest('bar', () => new Promise<string>((r) => { resolveBar = r; }));

    expect(pFoo).not.toBe(pBar);
    expect(handler.inFlightCount).toBe(2);

    resolveFoo('FOO');
    resolveBar('BAR');

    await expect(pFoo).resolves.toBe('FOO');
    await expect(pBar).resolves.toBe('BAR');
    expect(handler.inFlightCount).toBe(0);
  });

  it('a second caller after settlement gets a new independent promise', async () => {
    const handler = new IpcHandler(makeOpts());
    const p1 = handler.dedupRequest('k', () => Promise.resolve(1));
    await p1;

    // New call after settlement must invoke factory again
    let secondCalled = false;
    const p2 = handler.dedupRequest('k', () => { secondCalled = true; return Promise.resolve(2); });

    expect(p1).not.toBe(p2);
    expect(secondCalled).toBe(true);
    await expect(p2).resolves.toBe(2);
  });
});

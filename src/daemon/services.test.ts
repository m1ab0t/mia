/**
 * Tests for daemon/services.ts — P2P sub-agent spawner.
 *
 * Strategy: mock `child_process.spawn` to return a fake EventEmitter so we
 * can drive all stdout/stderr/error/exit paths without forking a real process.
 *
 * Every `handleAgentMessage` branch (all 15 message types) is exercised by
 * writing NDJSON lines to the fake stdout and observing side-effects on the
 * mocked P2P sender, scheduler, suggestions service, daily-greeting service,
 * queue, and user callbacks.
 *
 * Covered scenarios:
 *   happy-path    — ready, peer_connected, peer_disconnected, user_message,
 *                   control_new_conversation, control_load_conversation,
 *                   control_plugin_switch, control_plugins_request,
 *                   control_restart, control_scheduler (all actions),
 *                   control_abort_generation, control_plugin_test,
 *                   control_suggestions (all actions), control_daily_greeting,
 *                   control_persona_generate
 *   edge-cases    — malformed JSON, process error event, process exit event,
 *                   ready with resumedConversationId, double-ready idempotency,
 *                   multi-line chunked stdout, missing scheduler id/name guard,
 *                   utilityDispatch missing for persona_generate, suggestions
 *                   and daily_greeting timeout fallback paths
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { EventEmitter, Readable, Writable } from 'stream';

// ── child_process mock ────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// ── P2P sender mocks ──────────────────────────────────────────────────────────

vi.mock('../p2p/sender.js', () => ({
  configureP2PSender: vi.fn(),
  clearP2PSender: vi.fn(),
  sendDaemonToAgent: vi.fn(),
  sendP2PResponse: vi.fn(),
  setCurrentConversationId: vi.fn(),
  setResumedConversationId: vi.fn(),
  setPeerCount: vi.fn(),
  setP2PKey: vi.fn(),
  handleRecentMessagesResponse: vi.fn(),
}));

// ── Encoding mock ─────────────────────────────────────────────────────────────

vi.mock('../utils/encoding.js', () => ({
  hexToBase64: vi.fn((hex: string) => Buffer.from(hex, 'hex').toString('base64')),
}));

// ── Error message mock ────────────────────────────────────────────────────────

vi.mock('../utils/error-message.js', () => ({
  getErrorMessage: vi.fn((err: unknown) => String(err)),
}));

// ── Scheduler mock ────────────────────────────────────────────────────────────

const mockScheduler = {
  get: vi.fn(),
  list: vi.fn(() => []),
  schedule: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  enable: vi.fn(async () => {}),
  disable: vi.fn(async () => {}),
  runNow: vi.fn(async () => {}),
};

vi.mock('../scheduler/index.js', () => ({
  getScheduler: vi.fn(() => mockScheduler),
}));

// ── Suggestions service mock ──────────────────────────────────────────────────

const mockSuggestions = {
  getActive: vi.fn(() => []),
  dismiss: vi.fn((id: string) => []),
  complete: vi.fn((id: string) => []),
  restore: vi.fn((id: string) => []),
  generate: vi.fn(async () => {}),
  clearHistory: vi.fn(() => []),
};

vi.mock('../suggestions/index.js', () => ({
  getSuggestionsService: vi.fn(() => mockSuggestions),
}));

// ── Daily greeting service mock ───────────────────────────────────────────────

const mockDailyGreeting = {
  getGreeting: vi.fn(async () => 'Good morning, here are your tasks.'),
};

vi.mock('../daily-greeting/index.js', () => ({
  getDailyGreetingService: vi.fn(() => mockDailyGreeting),
}));

// ── qrcode-terminal mock ──────────────────────────────────────────────────────

vi.mock('qrcode-terminal', () => ({
  default: {
    generate: vi.fn((_data: string, _opts: unknown, cb: (code: string) => void) => cb('[QR]')),
  },
}));

// ── Module under test ─────────────────────────────────────────────────────────

import { spawnP2PSubAgent } from './services.js';
import {
  configureP2PSender,
  clearP2PSender,
  sendDaemonToAgent,
  sendP2PResponse,
  setCurrentConversationId,
  setResumedConversationId,
  setPeerCount,
  setP2PKey,
  handleRecentMessagesResponse,
} from '../p2p/sender.js';
import { spawn } from 'child_process';

// ── Fake child process factory ────────────────────────────────────────────────

/**
 * Returns a fake ChildProcess whose stdin/stdout/stderr are real Node.js
 * streams so the code-under-test can call setEncoding/on without crashing.
 */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
  };

  // stdin: writable side — code calls configureP2PSender(child.stdin)
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });

  // stdout: we push NDJSON lines in tests
  child.stdout = new Readable({ read() {} });

  // stderr: we push text in tests
  child.stderr = new Readable({ read() {} });

  return child;
}

/** Push a single NDJSON message to a fake child's stdout. */
function pushMessage(child: ReturnType<typeof makeFakeChild>, msg: object) {
  child.stdout.push(JSON.stringify(msg) + '\n');
}

/** Push a raw string (for malformed JSON tests). */
function pushRaw(child: ReturnType<typeof makeFakeChild>, raw: string) {
  child.stdout.push(raw + '\n');
}

// ── Default mock handlers ─────────────────────────────────────────────────────

function makeHandlers() {
  return {
    routeMessageFn: vi.fn(async () => {}),
    queue: {
      lock: vi.fn(),
      unlock: vi.fn(),
      abortAndDrain: vi.fn(),
    } as unknown as import('./queue.js').MessageQueue,
    onPluginSwitch: vi.fn(() => ({ success: true })),
    getPluginsInfo: vi.fn(async () => ({
      plugins: [{ name: 'claude-code', enabled: true, isActive: true, available: true }],
      activePlugin: 'claude-code',
    })),
    log: vi.fn() as Mock,
    onRestart: vi.fn(),
    getTaskStatus: vi.fn(() => ({ running: false, count: 0 })),
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockScheduler.list.mockReturnValue([]);
  mockScheduler.get.mockReturnValue(null);
  mockSuggestions.getActive.mockReturnValue([]);
  mockSuggestions.dismiss.mockReturnValue([]);
  mockSuggestions.complete.mockReturnValue([]);
  mockSuggestions.restore.mockReturnValue([]);
  mockSuggestions.generate.mockResolvedValue(undefined);
  mockSuggestions.clearHistory.mockReturnValue([]);
  mockDailyGreeting.getGreeting.mockResolvedValue('Good morning, here are your tasks.');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// spawn failure — no stdio
// ─────────────────────────────────────────────────────────────────────────────

describe('spawnP2PSubAgent — stdio unavailable', () => {
  it('resolves with success:false when spawn returns no stdin', async () => {
    const child = makeFakeChild();
    (child as never as { stdin: null }).stdin = null as never;
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const result = await spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );

    expect(result.success).toBe(false);
    expect(result.key).toBeNull();
    expect(result.error).toMatch(/stdio/i);
  });

  it('resolves with success:false when spawn returns no stdout', async () => {
    const child = makeFakeChild();
    (child as never as { stdout: null }).stdout = null as never;
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const result = await spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );

    expect(result.success).toBe(false);
  });

  it('resolves with success:false when spawn returns no stderr', async () => {
    const child = makeFakeChild();
    (child as never as { stderr: null }).stderr = null as never;
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const result = await spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );

    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// spawn success — P2P sender configured
// ─────────────────────────────────────────────────────────────────────────────

describe('spawnP2PSubAgent — P2P sender setup', () => {
  it('calls configureP2PSender with child stdin after spawning', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    // Kick off spawn (won't resolve until 'ready' message)
    const promise = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );

    pushMessage(child, { type: 'ready', key: 'abc123' });
    await promise;

    expect(vi.mocked(configureP2PSender)).toHaveBeenCalledWith(child.stdin);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'ready' message
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'ready'", () => {
  it('resolves the promise with success:true and the key', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const promise = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );

    pushMessage(child, { type: 'ready', key: 'deadbeef' });
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.key).toBe('deadbeef');
  });

  it('calls setP2PKey with the received key', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'cafe0001' });
    await p;

    expect(vi.mocked(setP2PKey)).toHaveBeenCalledWith('cafe0001');
  });

  it('logs "P2P swarm started" at success level', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'ff00ff' });
    await p;

    expect(h.log).toHaveBeenCalledWith('success', expect.stringContaining('P2P swarm started'));
  });

  it('includes the key in the success log', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'key9999' });
    await p;

    const [, msg] = (h.log as Mock).mock.calls.find(([level]) => level === 'success') ?? [];
    expect(msg).toContain('key9999');
  });

  it('does NOT call setCurrentConversationId when there is no resumedConversationId', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'abc' });
    await p;

    expect(vi.mocked(setResumedConversationId)).not.toHaveBeenCalled();
  });

  it('is idempotent — resolves only once even with two ready messages', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'first' });
    const result = await p;
    pushMessage(child, { type: 'ready', key: 'second' });

    // Promise resolved once — key is from the first message
    expect(result.key).toBe('first');
    // setP2PKey called again with 'second' (message still processed), but
    // resolve was already settled so the second call has no effect on result
    expect(vi.mocked(setP2PKey)).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'ready' with resumedConversationId
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'ready' with resumedConversationId", () => {
  it('calls setCurrentConversationId with the resumed ID', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k', resumedConversationId: 'conv-42' });
    await p;

    expect(vi.mocked(setCurrentConversationId)).toHaveBeenCalledWith('conv-42');
  });

  it('calls setResumedConversationId with the resumed ID', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k', resumedConversationId: 'conv-99' });
    await p;

    expect(vi.mocked(setResumedConversationId)).toHaveBeenCalledWith('conv-99');
  });

  it('does NOT send a static "Back online" message (reconnect gesture handles it)', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k', resumedConversationId: 'conv-1' });
    await p;

    expect(vi.mocked(sendP2PResponse)).not.toHaveBeenCalled();
  });

  it('logs the resumed conversation at info level', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k', resumedConversationId: 'conv-abc' });
    await p;

    expect(h.log).toHaveBeenCalledWith('info', expect.stringContaining('conv-abc'));
  });

  it('exposes onPeerConnected callback on the result', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    const result = await p;

    expect(typeof result.onPeerConnected).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'peer_connected'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'peer_connected'", () => {
  async function setup() {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;
    return { child, h };
  }

  it('calls setPeerCount with the new count', async () => {
    const { child } = await setup();
    pushMessage(child, { type: 'peer_connected', peerCount: 2 });
    await new Promise(r => setImmediate(r));
    expect(vi.mocked(setPeerCount)).toHaveBeenCalledWith(2);
  });

  it('logs peer connection at info level', async () => {
    const { child, h } = await setup();
    pushMessage(child, { type: 'peer_connected', peerCount: 1 });
    await new Promise(r => setImmediate(r));
    expect(h.log).toHaveBeenCalledWith('info', expect.stringContaining('connected'));
  });

  it('fires the onPeerConnected callback registered after ready', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    const result = await p;

    const cb = vi.fn();
    result.onPeerConnected!(cb);

    pushMessage(child, { type: 'peer_connected', peerCount: 1 });
    await new Promise(r => setImmediate(r));

    expect(cb).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'peer_disconnected'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'peer_disconnected'", () => {
  it('calls setPeerCount with the remaining count', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'peer_disconnected', peerCount: 0 });
    await new Promise(r => setImmediate(r));

    expect(vi.mocked(setPeerCount)).toHaveBeenCalledWith(0);
  });

  it('logs peer disconnection at info level', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'peer_disconnected', peerCount: 0 });
    await new Promise(r => setImmediate(r));

    expect(h.log).toHaveBeenCalledWith('info', expect.stringContaining('disconnected'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'user_message'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'user_message'", () => {
  it('calls setCurrentConversationId with the conversation ID', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'user_message', message: 'hello', conversationId: 'conv-5' });
    await new Promise(r => setImmediate(r));

    expect(vi.mocked(setCurrentConversationId)).toHaveBeenCalledWith('conv-5');
  });

  it('calls routeMessageFn with the message and P2P source', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'user_message', message: 'do something', conversationId: 'c1' });
    // wait for userMessageChain to resolve
    await new Promise(r => setTimeout(r, 10));

    expect(h.routeMessageFn).toHaveBeenCalledWith('do something', 'P2P', undefined, 'c1');
  });

  it('passes image attachment to routeMessageFn when present', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    const image = { data: 'base64data', mimeType: 'image/png' };
    pushMessage(child, { type: 'user_message', message: 'look at this', conversationId: 'c2', image });
    await new Promise(r => setTimeout(r, 10));

    expect(h.routeMessageFn).toHaveBeenCalledWith('look at this', 'P2P', image, 'c2');
  });

  it('logs error at error level when routeMessageFn rejects', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    h.routeMessageFn = vi.fn(async () => { throw new Error('dispatch failure'); });

    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'user_message', message: 'hi', conversationId: 'c3' });
    await new Promise(r => setTimeout(r, 20));

    expect(h.log).toHaveBeenCalledWith('error', expect.stringContaining('Route error'));
  });

  it('serialises concurrent messages (second waits for first)', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const order: number[] = [];

    const h = makeHandlers();
    h.routeMessageFn = vi.fn()
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 20));
        order.push(1);
      })
      .mockImplementationOnce(async () => {
        order.push(2);
      });

    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'user_message', message: 'first', conversationId: 'c' });
    pushMessage(child, { type: 'user_message', message: 'second', conversationId: 'c' });
    await new Promise(r => setTimeout(r, 60));

    expect(order).toEqual([1, 2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'control_new_conversation'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'control_new_conversation'", () => {
  it('sets currentConversationId to null', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'control_new_conversation' });
    await new Promise(r => setImmediate(r));

    expect(vi.mocked(setCurrentConversationId)).toHaveBeenCalledWith(null);
  });

  it('logs at info level', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'control_new_conversation' });
    await new Promise(r => setImmediate(r));

    expect(h.log).toHaveBeenCalledWith('info', expect.stringContaining('New conversation'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'control_load_conversation'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'control_load_conversation'", () => {
  it('sets currentConversationId to the loaded ID', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'control_load_conversation', conversationId: 'loaded-99' });
    await new Promise(r => setImmediate(r));

    expect(vi.mocked(setCurrentConversationId)).toHaveBeenCalledWith('loaded-99');
  });

  it('includes conversationId in the log message', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'control_load_conversation', conversationId: 'conv-xyz' });
    await new Promise(r => setImmediate(r));

    expect(h.log).toHaveBeenCalledWith('info', expect.stringContaining('conv-xyz'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'control_plugin_switch'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'control_plugin_switch'", () => {
  it('calls onPluginSwitch with the plugin name', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'control_plugin_switch', name: 'opencode' });
    await new Promise(r => setImmediate(r));

    expect(h.onPluginSwitch).toHaveBeenCalledWith('opencode');
  });

  it('logs success when plugin switch succeeds', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    h.onPluginSwitch = vi.fn(() => ({ success: true }));
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'control_plugin_switch', name: 'codex' });
    await new Promise(r => setImmediate(r));

    expect(h.log).toHaveBeenCalledWith('info', expect.stringContaining('ok'));
  });

  it('logs the error message when plugin switch fails', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    h.onPluginSwitch = vi.fn(() => ({ success: false, error: 'plugin not found' }));
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'control_plugin_switch', name: 'unknown-plugin' });
    await new Promise(r => setImmediate(r));

    expect(h.log).toHaveBeenCalledWith('info', expect.stringContaining('plugin not found'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'control_plugins_request'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'control_plugins_request'", () => {
  it('calls getPluginsInfo and sends plugins_list response', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const plugins = [{ name: 'claude-code', enabled: true, isActive: true, available: true }];
    h.getPluginsInfo = vi.fn(async () => ({ plugins, activePlugin: 'claude-code' }));

    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'control_plugins_request', requestId: 'req-1' });
    await new Promise(r => setTimeout(r, 20));

    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith({
      type: 'plugins_list',
      requestId: 'req-1',
      plugins,
      activePlugin: 'claude-code',
    });
  });

  it('logs a warning when getPluginsInfo rejects', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    h.getPluginsInfo = vi.fn(async () => { throw new Error('info error'); });

    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'control_plugins_request', requestId: 'req-2' });
    await new Promise(r => setTimeout(r, 20));

    expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('Plugins request failed'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'control_restart'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'control_restart'", () => {
  it('calls the onRestart callback', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
      h.onRestart,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'control_restart' });
    await new Promise(r => setImmediate(r));

    expect(h.onRestart).toHaveBeenCalledOnce();
  });

  it('logs restart request at info level', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
      h.onRestart,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'control_restart' });
    await new Promise(r => setImmediate(r));

    expect(h.log).toHaveBeenCalledWith('info', expect.stringContaining('Restart'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'control_scheduler'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'control_scheduler'", () => {
  async function setupReady() {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;
    return { child, h };
  }

  it('list — sends scheduler_response with task list', async () => {
    const { child } = await setupReady();
    const tasks: any = [{ id: 't1', name: 'nightly', cronExpression: '0 3 * * *', task: 'run tests', enabled: true, createdAt: 1, runCount: 5 }];
    mockScheduler.list.mockReturnValue(tasks);

    pushMessage(child, { type: 'control_scheduler', requestId: 'r1', action: 'list' });
    await new Promise(r => setTimeout(r, 20));

    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scheduler_response', requestId: 'r1' }),
    );
  });

  it('toggle — enables a disabled task', async () => {
    const { child } = await setupReady();
    mockScheduler.get.mockReturnValue({ id: 't1', enabled: false });

    pushMessage(child, { type: 'control_scheduler', requestId: 'r2', action: 'toggle', id: 't1' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockScheduler.enable).toHaveBeenCalledWith('t1');
  });

  it('toggle — disables an enabled task', async () => {
    const { child } = await setupReady();
    mockScheduler.get.mockReturnValue({ id: 't1', enabled: true });

    pushMessage(child, { type: 'control_scheduler', requestId: 'r3', action: 'toggle', id: 't1' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockScheduler.disable).toHaveBeenCalledWith('t1');
  });

  it('toggle — does nothing when task id not found', async () => {
    const { child } = await setupReady();
    mockScheduler.get.mockReturnValue(null);

    pushMessage(child, { type: 'control_scheduler', requestId: 'r4', action: 'toggle', id: 'missing' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockScheduler.enable).not.toHaveBeenCalled();
    expect(mockScheduler.disable).not.toHaveBeenCalled();
  });

  it('delete — calls scheduler.remove with the id', async () => {
    const { child } = await setupReady();

    pushMessage(child, { type: 'control_scheduler', requestId: 'r5', action: 'delete', id: 'task-x' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockScheduler.remove).toHaveBeenCalledWith('task-x');
  });

  it('delete — does nothing when id is missing', async () => {
    const { child } = await setupReady();

    pushMessage(child, { type: 'control_scheduler', requestId: 'r6', action: 'delete' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockScheduler.remove).not.toHaveBeenCalled();
  });

  it('run — calls scheduler.runNow with the id', async () => {
    const { child } = await setupReady();

    pushMessage(child, { type: 'control_scheduler', requestId: 'r7', action: 'run', id: 'task-y' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockScheduler.runNow).toHaveBeenCalledWith('task-y');
  });

  it('create — calls scheduler.schedule when all fields are present', async () => {
    const { child } = await setupReady();

    pushMessage(child, {
      type: 'control_scheduler',
      requestId: 'r8',
      action: 'create',
      name: 'my-task',
      cronExpression: '*/5 * * * *',
      taskPrompt: 'run linting',
    });
    await new Promise(r => setTimeout(r, 20));

    expect(mockScheduler.schedule).toHaveBeenCalledWith(
      'my-task', '*/5 * * * *', 'run linting', true, expect.any(Object),
    );
  });

  it('create — skips when required fields are missing', async () => {
    const { child } = await setupReady();

    pushMessage(child, {
      type: 'control_scheduler', requestId: 'r9', action: 'create', name: 'no-cron',
    });
    await new Promise(r => setTimeout(r, 20));

    expect(mockScheduler.schedule).not.toHaveBeenCalled();
  });

  it('update — calls scheduler.update when id and taskPrompt are present', async () => {
    const { child } = await setupReady();

    pushMessage(child, {
      type: 'control_scheduler',
      requestId: 'r10',
      action: 'update',
      id: 'task-z',
      taskPrompt: 'updated prompt',
    });
    await new Promise(r => setTimeout(r, 20));

    expect(mockScheduler.update).toHaveBeenCalledWith('task-z', 'updated prompt', expect.any(Object));
  });

  it('update — skips when taskPrompt is missing', async () => {
    const { child } = await setupReady();

    pushMessage(child, {
      type: 'control_scheduler', requestId: 'r11', action: 'update', id: 'task-z',
    });
    await new Promise(r => setTimeout(r, 20));

    expect(mockScheduler.update).not.toHaveBeenCalled();
  });

  it('always sends a scheduler_response even after an error', async () => {
    const { child } = await setupReady();
    mockScheduler.list.mockImplementation(() => { throw new Error('db error'); });

    pushMessage(child, { type: 'control_scheduler', requestId: 'r12', action: 'list' });
    await new Promise(r => setTimeout(r, 20));

    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scheduler_response', requestId: 'r12', tasks: [] }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling — malformed JSON on stdout
// ─────────────────────────────────────────────────────────────────────────────

describe('spawnP2PSubAgent — malformed stdout JSON', () => {
  it('logs a warn and continues after malformed JSON', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );

    // Malformed line first, then valid ready
    pushRaw(child, '{ this is not json');
    pushMessage(child, { type: 'ready', key: 'afterjunk' });
    const result = await p;

    expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('Malformed agent message'));
    expect(result.success).toBe(true);
    expect(result.key).toBe('afterjunk');
  });

  it('truncates very long malformed messages in the log', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );

    const junk = 'x'.repeat(500);
    pushRaw(child, junk);
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    const warnCall = (h.log as Mock).mock.calls.find(([level]) => level === 'warn');
    expect(warnCall).toBeDefined();
    // The logged snippet should be at most ~130 chars (120 of content + prefix)
    expect((warnCall![1] as string).length).toBeLessThan(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Process 'error' event
// ─────────────────────────────────────────────────────────────────────────────

describe('spawnP2PSubAgent — process error event', () => {
  it('resolves with success:false when the process emits error before ready', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );

    child.emit('error', new Error('ENOENT'));
    const result = await p;

    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('logs the error at error level', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );

    child.emit('error', new Error('ENOENT'));
    await p;

    expect(h.log).toHaveBeenCalledWith('error', expect.stringContaining('ENOENT'));
  });

  it('calls clearP2PSender on process error', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );

    child.emit('error', new Error('EPERM'));
    await p;

    expect(vi.mocked(clearP2PSender)).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Process 'exit' event
// ─────────────────────────────────────────────────────────────────────────────

describe('spawnP2PSubAgent — process exit event', () => {
  it('calls clearP2PSender on process exit', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    child.emit('exit', 0, null);
    await new Promise(r => setImmediate(r));

    expect(vi.mocked(clearP2PSender)).toHaveBeenCalled();
  });

  it('logs exit with code and signal at warn level', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    child.emit('exit', 1, 'SIGTERM');
    await new Promise(r => setImmediate(r));

    expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('exited'));
  });

  it('includes exit code in the log', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    child.emit('exit', 42, null);
    await new Promise(r => setImmediate(r));

    const exitLog = (h.log as Mock).mock.calls.find(([level, msg]) => level === 'warn' && String(msg).includes('42'));
    expect(exitLog).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stderr forwarding
// ─────────────────────────────────────────────────────────────────────────────

describe('spawnP2PSubAgent — stderr forwarding', () => {
  it('logs stderr lines at debug level with [p2p] prefix', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    child.stderr.push('agent debug info\n');
    await new Promise(r => setImmediate(r));

    expect(h.log).toHaveBeenCalledWith('debug', expect.stringContaining('[p2p]'));
    expect(h.log).toHaveBeenCalledWith('debug', expect.stringContaining('agent debug info'));
  });

  it('buffers partial stderr lines until newline', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    // Push partial line, then complete it
    child.stderr.push('partial');
    await new Promise(r => setImmediate(r));
    const beforeCount = (h.log as Mock).mock.calls.filter(([l]) => l === 'debug').length;

    child.stderr.push(' complete line\n');
    await new Promise(r => setImmediate(r));
    const afterCount = (h.log as Mock).mock.calls.filter(([l]) => l === 'debug').length;

    // The debug log for this stderr line should only appear after the newline
    expect(afterCount).toBeGreaterThan(beforeCount);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-line / chunked stdout
// ─────────────────────────────────────────────────────────────────────────────

describe('spawnP2PSubAgent — chunked stdout', () => {
  it('correctly parses a message split across two data events', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );

    const json = JSON.stringify({ type: 'ready', key: 'splitkey' });
    // Push first half, then second half + newline
    child.stdout.push(json.slice(0, 10));
    child.stdout.push(json.slice(10) + '\n');

    const result = await p;
    expect(result.success).toBe(true);
    expect(result.key).toBe('splitkey');
  });

  it('handles multiple messages in a single chunk', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );

    const ready = JSON.stringify({ type: 'ready', key: 'multikey' });
    const peerMsg = JSON.stringify({ type: 'peer_connected', peerCount: 3 });
    child.stdout.push(ready + '\n' + peerMsg + '\n');

    await p;
    await new Promise(r => setImmediate(r));

    expect(vi.mocked(setPeerCount)).toHaveBeenCalledWith(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-conversation parallel dispatch
// ─────────────────────────────────────────────────────────────────────────────
//
// The rate limiter (module-level state) accumulates across ALL tests in the
// same 30-second window. We advance Date.now() by 31 seconds before each test
// to reset the window, so our dispatch tests aren't starved by earlier tests.

describe('per-conversation parallel dispatch', () => {
  // The dispatch rate limiter is module-level state that accumulates across
  // tests. Each test must advance Date.now() by at least 31s past the previous
  // window so the counter resets. We use an incrementing offset.
  let dateNowSpy: ReturnType<typeof vi.spyOn>;
  let timeOffset = 60_000;

  beforeEach(() => {
    timeOffset += 60_000; // 60s increment per test — always resets the 30s window
    const fakeNow = Date.now() + timeOffset;
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  it('dispatches messages to different conversations in parallel (not blocking each other)', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const timeline: string[] = [];
    let resolveConvA: () => void;
    const convABlocked = new Promise<void>(r => { resolveConvA = r; });

    const h = makeHandlers();
    h.routeMessageFn = vi.fn()
      .mockImplementationOnce(async () => {
        timeline.push('convA-start');
        await convABlocked;
        timeline.push('convA-end');
      })
      .mockImplementationOnce(async () => {
        timeline.push('convB-start');
        timeline.push('convB-end');
      });

    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    // Send messages to two different conversations
    pushMessage(child, { type: 'user_message', message: 'task A', conversationId: 'conv-A' });
    // Small delay to ensure convA starts first
    await new Promise(r => setTimeout(r, 10));
    pushMessage(child, { type: 'user_message', message: 'task B', conversationId: 'conv-B' });

    // Wait for convB to dispatch (it should NOT wait for convA)
    await new Promise(r => setTimeout(r, 30));

    // convB should have started and finished even though convA is still blocked
    expect(timeline).toContain('convB-start');
    expect(timeline).toContain('convB-end');
    // convA should have started but NOT ended yet
    expect(timeline).toContain('convA-start');
    expect(timeline).not.toContain('convA-end');

    // Now unblock convA
    resolveConvA!();
    await new Promise(r => setTimeout(r, 10));
    expect(timeline).toContain('convA-end');

    // Both should have been dispatched
    expect(h.routeMessageFn).toHaveBeenCalledTimes(2);
  });

  it('serialises messages within the same conversation', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const order: number[] = [];

    const h = makeHandlers();
    h.routeMessageFn = vi.fn()
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 30));
        order.push(1);
      })
      .mockImplementationOnce(async () => {
        order.push(2);
      });

    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'user_message', message: 'first', conversationId: 'same-conv' });
    pushMessage(child, { type: 'user_message', message: 'second', conversationId: 'same-conv' });
    await new Promise(r => setTimeout(r, 80));

    // Must be in order: first completes before second starts
    expect(order).toEqual([1, 2]);
  });

  it('allows a new conversation to start immediately while previous conversation task is running', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    let convAStarted = false;
    let convBStarted = false;
    let resolveConvA: () => void;
    const convAPromise = new Promise<void>(r => { resolveConvA = r; });

    const h = makeHandlers();
    h.routeMessageFn = vi.fn()
      .mockImplementationOnce(async () => {
        convAStarted = true;
        await convAPromise; // stays blocked until we release
      })
      .mockImplementationOnce(async () => {
        convBStarted = true;
      });

    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'user_message', message: 'suggestion A', conversationId: 'suggestion-1' });
    await new Promise(r => setTimeout(r, 10));

    // Start a new conversation while first is still running
    pushMessage(child, { type: 'user_message', message: 'suggestion B', conversationId: 'suggestion-2' });
    await new Promise(r => setTimeout(r, 20));

    expect(convAStarted).toBe(true);
    expect(convBStarted).toBe(true); // Should NOT be blocked by convA

    // Cleanup
    resolveConvA!();
    await new Promise(r => setTimeout(r, 10));
  });

  it('handles three concurrent conversations independently', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const started: string[] = [];
    const finished: string[] = [];
    const resolvers: Record<string, () => void> = {};

    const h = makeHandlers();
    h.routeMessageFn = vi.fn().mockImplementation(async (msg: string) => {
      started.push(msg);
      await new Promise<void>(r => { resolvers[msg] = r; });
      finished.push(msg);
    });

    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'user_message', message: 'A', conversationId: 'c1' });
    pushMessage(child, { type: 'user_message', message: 'B', conversationId: 'c2' });
    pushMessage(child, { type: 'user_message', message: 'C', conversationId: 'c3' });
    await new Promise(r => setTimeout(r, 30));

    // All three should have started (parallel dispatch)
    expect(started).toEqual(expect.arrayContaining(['A', 'B', 'C']));
    expect(started).toHaveLength(3);
    // None finished yet
    expect(finished).toHaveLength(0);

    // Finish them in reverse order
    resolvers['C']();
    await new Promise(r => setTimeout(r, 10));
    expect(finished).toEqual(['C']);

    resolvers['A']();
    await new Promise(r => setTimeout(r, 10));
    expect(finished).toEqual(['C', 'A']);

    resolvers['B']();
    await new Promise(r => setTimeout(r, 10));
    expect(finished).toEqual(['C', 'A', 'B']);
  });

  it('uses "default" as conversation chain key when conversationId is empty', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const order: number[] = [];

    const h = makeHandlers();
    h.routeMessageFn = vi.fn()
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 20));
        order.push(1);
      })
      .mockImplementationOnce(async () => {
        order.push(2);
      });

    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    // Messages with empty conversationId should share the "default" chain
    pushMessage(child, { type: 'user_message', message: 'first', conversationId: '' });
    pushMessage(child, { type: 'user_message', message: 'second', conversationId: '' });
    await new Promise(r => setTimeout(r, 60));

    // Serialised within same chain — order must be preserved
    expect(order).toEqual([1, 2]);
  });

  it('does not leak conversation chains after they settle (auto-cleanup)', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const calls: string[] = [];

    const h = makeHandlers();
    h.routeMessageFn = vi.fn().mockImplementation(async (msg: string) => {
      calls.push(msg);
    });

    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    // First round
    pushMessage(child, { type: 'user_message', message: 'round1', conversationId: 'ephemeral' });
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toEqual(['round1']);

    // Second round to same conversation — should dispatch immediately, not block
    pushMessage(child, { type: 'user_message', message: 'round2', conversationId: 'ephemeral' });
    await new Promise(r => setTimeout(r, 20));

    expect(calls).toEqual(['round1', 'round2']);
  });

  it('error in one conversation does not affect parallel conversations', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    let convBResult = '';

    const h = makeHandlers();
    h.routeMessageFn = vi.fn()
      .mockImplementationOnce(async () => {
        throw new Error('convA crashed');
      })
      .mockImplementationOnce(async () => {
        convBResult = 'success';
      });

    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'user_message', message: 'fail task', conversationId: 'err-conv' });
    pushMessage(child, { type: 'user_message', message: 'ok task', conversationId: 'ok-conv' });
    await new Promise(r => setTimeout(r, 30));

    // convB should still succeed despite convA throwing
    expect(convBResult).toBe('success');
    expect(h.log).toHaveBeenCalledWith('error', expect.stringContaining('Route error'));
  });

  it('error in one conversation does not block subsequent messages in the same conversation', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const results: string[] = [];

    const h = makeHandlers();
    h.routeMessageFn = vi.fn()
      .mockImplementationOnce(async () => {
        throw new Error('first failed');
      })
      .mockImplementationOnce(async () => {
        results.push('second-ok');
      });

    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'user_message', message: 'bad', conversationId: 'retry-conv' });
    await new Promise(r => setTimeout(r, 10));
    pushMessage(child, { type: 'user_message', message: 'good', conversationId: 'retry-conv' });
    await new Promise(r => setTimeout(r, 30));

    // The chain should recover — second message dispatches despite first throwing
    expect(results).toEqual(['second-ok']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'recent_messages_response' IPC routing
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'recent_messages_response'", () => {
  it('forwards the response to handleRecentMessagesResponse', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    const messages = [
      { id: 'm1', conversationId: 'c1', type: 'user', content: 'hello', timestamp: 1000 },
    ];
    pushMessage(child, { type: 'recent_messages_response', requestId: 'msg_1', messages });
    await new Promise(r => setImmediate(r));

    expect(vi.mocked(handleRecentMessagesResponse)).toHaveBeenCalledWith('msg_1', messages);
  });

  it('handles empty messages array', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    pushMessage(child, { type: 'recent_messages_response', requestId: 'msg_2', messages: [] });
    await new Promise(r => setImmediate(r));

    expect(vi.mocked(handleRecentMessagesResponse)).toHaveBeenCalledWith('msg_2', []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch rate limiter
// ─────────────────────────────────────────────────────────────────────────────

describe('dispatch rate limiter', () => {
  it('drops messages when rate limit is exceeded', async () => {
    // Advance Date.now far past any previous window so the rate counter resets
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);

    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    // Send more than DISPATCH_RATE_MAX (8) messages rapidly
    for (let i = 0; i < 12; i++) {
      pushMessage(child, { type: 'user_message', message: `msg-${i}`, conversationId: `rate-${i}` });
    }
    await new Promise(r => setTimeout(r, 50));

    // Only 8 should have been dispatched (the max per window)
    expect(h.routeMessageFn).toHaveBeenCalledTimes(8);
    // Should log rate limit warnings
    expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('RateLimit'));

    dateNowSpy.mockRestore();
  });

  it('sends plugin_error to mobile when message is rate-limited', async () => {
    // Advance Date.now far past any previous window so the rate counter resets
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_200_000);

    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.mocked(sendDaemonToAgent).mockClear();
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;

    // Exhaust the token bucket (capacity 8), then send one more
    for (let i = 0; i < 9; i++) {
      pushMessage(child, { type: 'user_message', message: `msg-${i}`, conversationId: `rl-conv-${i}` });
    }
    await new Promise(r => setTimeout(r, 50));

    // The 9th message should trigger a plugin_error notification
    const errorCalls = vi.mocked(sendDaemonToAgent).mock.calls.filter(
      ([msg]) => (msg as { type: string }).type === 'plugin_error',
    );
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    const errorMsg = errorCalls[0][0] as {
      type: string;
      code: string;
      message: string;
      conversationId: string;
    };
    expect(errorMsg.code).toBe('RATE_LIMITED');
    expect(errorMsg.message).toContain('rate limit');
    expect(errorMsg.conversationId).toBe('rl-conv-8');

    dateNowSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'control_abort_generation'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'control_abort_generation'", () => {
  async function setupReady(onAbortGeneration?: () => void) {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const abortCb = onAbortGeneration ?? vi.fn();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
      undefined, h.getTaskStatus, abortCb,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;
    return { child, h, abortCb };
  }

  it('calls queue.abortAndDrain()', async () => {
    const { child, h } = await setupReady();
    pushMessage(child, { type: 'control_abort_generation' });
    await new Promise(r => setTimeout(r, 10));
    expect(h.queue.abortAndDrain).toHaveBeenCalledOnce();
  });

  it('calls onAbortGeneration callback', async () => {
    const onAbortGeneration = vi.fn();
    const { child } = await setupReady(onAbortGeneration);
    pushMessage(child, { type: 'control_abort_generation' });
    await new Promise(r => setTimeout(r, 10));
    expect(onAbortGeneration).toHaveBeenCalledOnce();
  });

  it('logs info message', async () => {
    const { child, h } = await setupReady();
    pushMessage(child, { type: 'control_abort_generation' });
    await new Promise(r => setTimeout(r, 10));
    expect(h.log).toHaveBeenCalledWith('info', expect.stringContaining('Abort'));
  });

  it('logs warn when onAbortGeneration throws', async () => {
    const throwing = vi.fn(() => { throw new Error('abort failed'); });
    const { child, h } = await setupReady(throwing);
    pushMessage(child, { type: 'control_abort_generation' });
    await new Promise(r => setTimeout(r, 10));
    expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('Abort generation callback failed'));
  });

  it('still calls queue.abortAndDrain even when onAbortGeneration throws', async () => {
    const throwing = vi.fn(() => { throw new Error('boom'); });
    const { child, h } = await setupReady(throwing);
    pushMessage(child, { type: 'control_abort_generation' });
    await new Promise(r => setTimeout(r, 10));
    expect(h.queue.abortAndDrain).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'control_plugin_test'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'control_plugin_test'", () => {
  const successResult = { success: true, output: 'All checks passed', elapsed: 423, pluginName: 'claude-code' };

  async function setupReady(testPlugin?: () => Promise<typeof successResult>) {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const testPluginFn = testPlugin ?? vi.fn(async () => successResult);
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
      undefined, h.getTaskStatus, vi.fn(), testPluginFn,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;
    return { child, h };
  }

  it('sends plugin_test_result with success=true on pass', async () => {
    const { child } = await setupReady();
    pushMessage(child, { type: 'control_plugin_test', requestId: 'pt1' });
    await new Promise(r => setTimeout(r, 20));
    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plugin_test_result',
        requestId: 'pt1',
        success: true,
        output: 'All checks passed',
        elapsed: 423,
        pluginName: 'claude-code',
      }),
    );
  });

  it('sends plugin_test_result with success=false when testPlugin rejects', async () => {
    const failing = vi.fn(async () => { throw new Error('process crashed'); });
    const { child, h } = await setupReady(failing as any);
    pushMessage(child, { type: 'control_plugin_test', requestId: 'pt2' });
    await new Promise(r => setTimeout(r, 20));
    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plugin_test_result',
        requestId: 'pt2',
        success: false,
        error: expect.stringContaining('process crashed'),
      }),
    );
    expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('Plugin test failed'));
  });

  it('includes optional error field when testPlugin returns one', async () => {
    const withError = vi.fn(async () => ({
      success: false, output: '', elapsed: 0, pluginName: 'codex', error: 'Binary not found',
    }));
    const { child } = await setupReady(withError);
    pushMessage(child, { type: 'control_plugin_test', requestId: 'pt3' });
    await new Promise(r => setTimeout(r, 20));
    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plugin_test_result',
        success: false,
        error: 'Binary not found',
      }),
    );
  });

  it('does not include error field on clean success', async () => {
    const { child } = await setupReady();
    pushMessage(child, { type: 'control_plugin_test', requestId: 'pt4' });
    await new Promise(r => setTimeout(r, 20));
    const call = vi.mocked(sendDaemonToAgent).mock.calls.find(
      ([m]) => (m as { type: string }).type === 'plugin_test_result',
    );
    expect(call).toBeDefined();
    expect(call![0]).not.toHaveProperty('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'control_suggestions'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'control_suggestions'", () => {
  const sampleSuggestions = [{ id: 's1', content: 'Add input validation', status: 'active', createdAt: 1000 }];

  async function setupReady() {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;
    return { child, h };
  }

  it('get — calls getActive() and sends suggestions_list', async () => {
    const { child } = await setupReady();
    mockSuggestions.getActive.mockReturnValue(sampleSuggestions as any);

    pushMessage(child, { type: 'control_suggestions', requestId: 'sg1', action: 'get' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockSuggestions.getActive).toHaveBeenCalled();
    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'suggestions_list', requestId: 'sg1', suggestions: sampleSuggestions }),
    );
  });

  it('dismiss — calls dismiss(id) and sends updated list', async () => {
    const { child } = await setupReady();
    mockSuggestions.dismiss.mockReturnValue([]);

    pushMessage(child, { type: 'control_suggestions', requestId: 'sg2', action: 'dismiss', id: 's1' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockSuggestions.dismiss).toHaveBeenCalledWith('s1');
    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'suggestions_list', requestId: 'sg2' }),
    );
  });

  it('dismiss — falls back to getActive() when id is missing', async () => {
    const { child } = await setupReady();
    mockSuggestions.getActive.mockReturnValue(sampleSuggestions as any);

    pushMessage(child, { type: 'control_suggestions', requestId: 'sg3', action: 'dismiss' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockSuggestions.dismiss).not.toHaveBeenCalled();
    expect(mockSuggestions.getActive).toHaveBeenCalled();
  });

  it('complete — calls complete(id)', async () => {
    const { child } = await setupReady();
    mockSuggestions.complete.mockReturnValue([]);

    pushMessage(child, { type: 'control_suggestions', requestId: 'sg4', action: 'complete', id: 's1' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockSuggestions.complete).toHaveBeenCalledWith('s1');
  });

  it('restore — calls restore(id)', async () => {
    const { child } = await setupReady();
    mockSuggestions.restore.mockReturnValue(sampleSuggestions as any);

    pushMessage(child, { type: 'control_suggestions', requestId: 'sg5', action: 'restore', id: 's1' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockSuggestions.restore).toHaveBeenCalledWith('s1');
  });

  it('generate — fires generate() in background and responds with current active list', async () => {
    const { child } = await setupReady();
    mockSuggestions.getActive.mockReturnValue(sampleSuggestions as any);

    pushMessage(child, { type: 'control_suggestions', requestId: 'sg6', action: 'generate' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockSuggestions.generate).toHaveBeenCalled();
    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'suggestions_list', requestId: 'sg6', suggestions: sampleSuggestions }),
    );
  });

  it('clear_history — calls clearHistory()', async () => {
    const { child } = await setupReady();
    mockSuggestions.clearHistory.mockReturnValue([]);

    pushMessage(child, { type: 'control_suggestions', requestId: 'sg7', action: 'clear_history' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockSuggestions.clearHistory).toHaveBeenCalled();
  });

  it('unknown action — falls back to getActive()', async () => {
    const { child } = await setupReady();
    mockSuggestions.getActive.mockReturnValue(sampleSuggestions as any);

    pushMessage(child, { type: 'control_suggestions', requestId: 'sg8', action: 'unknown_action' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockSuggestions.getActive).toHaveBeenCalled();
    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'suggestions_list', requestId: 'sg8' }),
    );
  });

  it('always sends suggestions_list even when service throws', async () => {
    const { child, h } = await setupReady();
    mockSuggestions.getActive.mockImplementation(() => { throw new Error('db error'); });

    pushMessage(child, { type: 'control_suggestions', requestId: 'sg9', action: 'get' });
    await new Promise(r => setTimeout(r, 20));

    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'suggestions_list', requestId: 'sg9', suggestions: [] }),
    );
    expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('Suggestions action failed'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'control_daily_greeting'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'control_daily_greeting'", () => {
  async function setupReady() {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;
    return { child, h };
  }

  it('calls getGreeting() and sends daily_greeting_response', async () => {
    const { child } = await setupReady();
    mockDailyGreeting.getGreeting.mockResolvedValue('Rise and shine!');

    pushMessage(child, { type: 'control_daily_greeting', requestId: 'dg1' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockDailyGreeting.getGreeting).toHaveBeenCalled();
    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'daily_greeting_response', requestId: 'dg1', message: 'Rise and shine!' }),
    );
  });

  it('sends empty message when getGreeting() rejects', async () => {
    const { child, h } = await setupReady();
    mockDailyGreeting.getGreeting.mockRejectedValue(new Error('network error'));

    pushMessage(child, { type: 'control_daily_greeting', requestId: 'dg2' });
    await new Promise(r => setTimeout(r, 20));

    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'daily_greeting_response', requestId: 'dg2', message: '' }),
    );
    expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('Daily greeting failed'));
  });

  it('requestId is threaded through to the response', async () => {
    const { child } = await setupReady();
    pushMessage(child, { type: 'control_daily_greeting', requestId: 'unique-req-99' });
    await new Promise(r => setTimeout(r, 20));

    const call = vi.mocked(sendDaemonToAgent).mock.calls.find(
      ([m]) => (m as { type: string }).type === 'daily_greeting_response',
    );
    expect(call).toBeDefined();
    expect((call![0] as { requestId: string }).requestId).toBe('unique-req-99');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'control_persona_generate'
// ─────────────────────────────────────────────────────────────────────────────

describe("handleAgentMessage — 'control_persona_generate'", () => {
  async function setupReady(utilityDispatch?: (prompt: string, opts?: unknown) => Promise<string>) {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const h = makeHandlers();
    const p = spawnP2PSubAgent(
      h.routeMessageFn, h.queue, h.onPluginSwitch, h.getPluginsInfo, h.log,
      undefined, h.getTaskStatus, vi.fn(), vi.fn(async () => ({ success: true, output: '', elapsed: 0, pluginName: '' })),
      utilityDispatch,
    );
    pushMessage(child, { type: 'ready', key: 'k' });
    await p;
    return { child, h };
  }

  it('sends persona_generate_result with content when utilityDispatch resolves', async () => {
    const ud = vi.fn(async () => '# My Persona\n\n## Vibe\nDirect and terse');
    const { child } = await setupReady(ud);

    pushMessage(child, { type: 'control_persona_generate', requestId: 'pg1', description: 'terse direct coder' });
    await new Promise(r => setTimeout(r, 20));

    expect(ud).toHaveBeenCalledWith(
      expect.stringContaining('terse direct coder'),
      expect.objectContaining({ skipContext: true }),
    );
    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'persona_generate_result',
        requestId: 'pg1',
        content: '# My Persona\n\n## Vibe\nDirect and terse',
      }),
    );
  });

  it('sends error result when utilityDispatch rejects', async () => {
    const ud = vi.fn(async () => { throw new Error('LLM timeout'); });
    const { child, h } = await setupReady(ud);

    pushMessage(child, { type: 'control_persona_generate', requestId: 'pg2', description: 'helpful' });
    await new Promise(r => setTimeout(r, 20));

    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'persona_generate_result',
        requestId: 'pg2',
        content: '',
        error: expect.stringContaining('LLM timeout'),
      }),
    );
    expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('Persona generation failed'));
  });

  it('sends error result immediately when utilityDispatch is not provided', async () => {
    const { child } = await setupReady(undefined);

    pushMessage(child, { type: 'control_persona_generate', requestId: 'pg3', description: 'anything' });
    await new Promise(r => setTimeout(r, 20));

    expect(vi.mocked(sendDaemonToAgent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'persona_generate_result',
        requestId: 'pg3',
        content: '',
        error: 'Generation not available',
      }),
    );
  });

  it('includes the user description in the generated prompt', async () => {
    const ud = vi.fn(async () => '# Persona');
    const { child } = await setupReady(ud);

    pushMessage(child, { type: 'control_persona_generate', requestId: 'pg4', description: 'zen minimalist' });
    await new Promise(r => setTimeout(r, 20));

    expect(ud).toHaveBeenCalledWith(
      expect.stringContaining('zen minimalist'),
      expect.anything(),
    );
  });
});

/**
 * Tests for p2p/ipc-types.ts
 *
 * Focuses on the `parseMobileInbound` utility — the only runtime-evaluated
 * export.  All other exports in this file are pure TypeScript types that
 * vanish at compile time, so there is nothing else to test here.
 */

import { describe, it, expect } from 'vitest';
import { parseMobileInbound } from './ipc-types.js';

// ── Happy-path: known control message types ───────────────────────────────────

describe('parseMobileInbound — known control types', () => {
  it('parses a ping message', () => {
    const result = parseMobileInbound(JSON.stringify({ type: 'ping' }));
    expect(result).not.toBeNull();
    expect(result!.type).toBe('ping');
  });

  it('parses a pong message', () => {
    const result = parseMobileInbound(JSON.stringify({ type: 'pong' }));
    expect(result).not.toBeNull();
    expect(result!.type).toBe('pong');
  });

  it('parses history_request with required fields', () => {
    const msg = {
      type: 'history_request',
      conversationId: 'conv-1',
      before: 1000,
      limit: 50,
    };
    const result = parseMobileInbound(JSON.stringify(msg));
    expect(result).not.toBeNull();
    expect(result!.type).toBe('history_request');
    if (result!.type === 'history_request') {
      expect(result.conversationId).toBe('conv-1');
      expect(result.before).toBe(1000);
      expect(result.limit).toBe(50);
    }
  });

  it('parses conversations_request', () => {
    const result = parseMobileInbound(
      JSON.stringify({ type: 'conversations_request' }),
    );
    expect(result?.type).toBe('conversations_request');
  });

  it('parses load_conversation with conversationId', () => {
    const msg = { type: 'load_conversation', conversationId: 'abc-123' };
    const result = parseMobileInbound(JSON.stringify(msg));
    expect(result?.type).toBe('load_conversation');
    if (result?.type === 'load_conversation') {
      expect(result.conversationId).toBe('abc-123');
    }
  });

  it('parses new_conversation', () => {
    const result = parseMobileInbound(
      JSON.stringify({ type: 'new_conversation' }),
    );
    expect(result?.type).toBe('new_conversation');
  });

  it('parses rename_conversation with both required fields', () => {
    const msg = {
      type: 'rename_conversation',
      conversationId: 'c1',
      title: 'My Chat',
    };
    const result = parseMobileInbound(JSON.stringify(msg));
    expect(result?.type).toBe('rename_conversation');
    if (result?.type === 'rename_conversation') {
      expect(result.conversationId).toBe('c1');
      expect(result.title).toBe('My Chat');
    }
  });

  it('parses delete_conversation', () => {
    const msg = { type: 'delete_conversation', conversationId: 'del-id' };
    const result = parseMobileInbound(JSON.stringify(msg));
    expect(result?.type).toBe('delete_conversation');
    if (result?.type === 'delete_conversation') {
      expect(result.conversationId).toBe('del-id');
    }
  });

  it('parses delete_all_conversations', () => {
    const result = parseMobileInbound(
      JSON.stringify({ type: 'delete_all_conversations' }),
    );
    expect(result?.type).toBe('delete_all_conversations');
  });

  it('parses delete_multiple_conversations with id array', () => {
    const msg = {
      type: 'delete_multiple_conversations',
      conversationIds: ['a', 'b', 'c'],
    };
    const result = parseMobileInbound(JSON.stringify(msg));
    expect(result?.type).toBe('delete_multiple_conversations');
    if (result?.type === 'delete_multiple_conversations') {
      expect(result.conversationIds).toEqual(['a', 'b', 'c']);
    }
  });

  it('parses plugins_request', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'plugins_request' }))?.type,
    ).toBe('plugins_request');
  });

  it('parses plugin_switch with name', () => {
    const msg = { type: 'plugin_switch', name: 'codex' };
    const result = parseMobileInbound(JSON.stringify(msg));
    expect(result?.type).toBe('plugin_switch');
    if (result?.type === 'plugin_switch') {
      expect(result.name).toBe('codex');
    }
  });

  it('parses scheduler_list_request', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'scheduler_list_request' }))
        ?.type,
    ).toBe('scheduler_list_request');
  });

  it('parses scheduler_toggle with id', () => {
    const result = parseMobileInbound(
      JSON.stringify({ type: 'scheduler_toggle', id: 'task-1' }),
    );
    expect(result?.type).toBe('scheduler_toggle');
    if (result?.type === 'scheduler_toggle') expect(result.id).toBe('task-1');
  });

  it('parses scheduler_delete with id', () => {
    const result = parseMobileInbound(
      JSON.stringify({ type: 'scheduler_delete', id: 'task-2' }),
    );
    expect(result?.type).toBe('scheduler_delete');
    if (result?.type === 'scheduler_delete') expect(result.id).toBe('task-2');
  });

  it('parses scheduler_run with id', () => {
    const result = parseMobileInbound(
      JSON.stringify({ type: 'scheduler_run', id: 'task-3' }),
    );
    expect(result?.type).toBe('scheduler_run');
    if (result?.type === 'scheduler_run') expect(result.id).toBe('task-3');
  });

  it('parses scheduler_create with required fields', () => {
    const msg = {
      type: 'scheduler_create',
      name: 'Daily report',
      cronExpression: '0 9 * * *',
      taskPrompt: 'Generate daily standup report',
    };
    const result = parseMobileInbound(JSON.stringify(msg));
    expect(result?.type).toBe('scheduler_create');
    if (result?.type === 'scheduler_create') {
      expect(result.name).toBe('Daily report');
      expect(result.cronExpression).toBe('0 9 * * *');
      expect(result.taskPrompt).toBe('Generate daily standup report');
    }
  });

  it('parses scheduler_create with optional timeoutMs', () => {
    const msg = {
      type: 'scheduler_create',
      name: 'Check',
      cronExpression: '* * * * *',
      taskPrompt: 'Ping',
      timeoutMs: 60000,
    };
    const result = parseMobileInbound(JSON.stringify(msg));
    expect(result?.type).toBe('scheduler_create');
    if (result?.type === 'scheduler_create') {
      expect(result.timeoutMs).toBe(60000);
    }
  });

  it('parses scheduler_update with required fields', () => {
    const msg = {
      type: 'scheduler_update',
      id: 'task-99',
      taskPrompt: 'Updated prompt',
    };
    const result = parseMobileInbound(JSON.stringify(msg));
    expect(result?.type).toBe('scheduler_update');
    if (result?.type === 'scheduler_update') {
      expect(result.id).toBe('task-99');
      expect(result.taskPrompt).toBe('Updated prompt');
    }
  });

  it('parses scheduler_update with all optional fields', () => {
    const msg = {
      type: 'scheduler_update',
      id: 'task-1',
      taskPrompt: 'p',
      name: 'renamed',
      cronExpression: '0 0 * * *',
      timeoutMs: 5000,
    };
    const result = parseMobileInbound(JSON.stringify(msg));
    if (result?.type === 'scheduler_update') {
      expect(result.name).toBe('renamed');
      expect(result.cronExpression).toBe('0 0 * * *');
      expect(result.timeoutMs).toBe(5000);
    }
  });

  it('parses search_request with query and requestId', () => {
    const msg = {
      type: 'search_request',
      query: 'auth bug',
      requestId: 'req-42',
    };
    const result = parseMobileInbound(JSON.stringify(msg));
    expect(result?.type).toBe('search_request');
    if (result?.type === 'search_request') {
      expect(result.query).toBe('auth bug');
      expect(result.requestId).toBe('req-42');
    }
  });

  it('parses restart_request', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'restart_request' }))?.type,
    ).toBe('restart_request');
  });

  it('parses suggestions_request', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'suggestions_request' }))?.type,
    ).toBe('suggestions_request');
  });

  it('parses suggestions_refresh', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'suggestions_refresh' }))?.type,
    ).toBe('suggestions_refresh');
  });

  it('parses suggestion_dismiss with id', () => {
    const result = parseMobileInbound(
      JSON.stringify({ type: 'suggestion_dismiss', id: 's1' }),
    );
    expect(result?.type).toBe('suggestion_dismiss');
    if (result?.type === 'suggestion_dismiss') expect(result.id).toBe('s1');
  });

  it('parses suggestion_complete with id', () => {
    const result = parseMobileInbound(
      JSON.stringify({ type: 'suggestion_complete', id: 's2' }),
    );
    expect(result?.type).toBe('suggestion_complete');
    if (result?.type === 'suggestion_complete') expect(result.id).toBe('s2');
  });

  it('parses daily_greeting_request', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'daily_greeting_request' }))
        ?.type,
    ).toBe('daily_greeting_request');
  });
});

// ── Edge cases: returns null ──────────────────────────────────────────────────

describe('parseMobileInbound — returns null for invalid input', () => {
  it('returns null for empty string', () => {
    expect(parseMobileInbound('')).toBeNull();
  });

  it('returns null for plain text (not JSON)', () => {
    expect(parseMobileInbound('hello world')).toBeNull();
  });

  it('returns null for a JSON string (not an object)', () => {
    expect(parseMobileInbound('"just a string"')).toBeNull();
  });

  it('returns null for a JSON number', () => {
    expect(parseMobileInbound('42')).toBeNull();
  });

  it('returns null for JSON null', () => {
    expect(parseMobileInbound('null')).toBeNull();
  });

  it('returns null for a JSON array', () => {
    expect(parseMobileInbound('[{"type":"ping"}]')).toBeNull();
  });

  it('returns null for an object without a type field', () => {
    const imgMsg = JSON.stringify({
      image: { data: 'abc', mimeType: 'image/jpeg' },
      text: 'hi',
    });
    expect(parseMobileInbound(imgMsg)).toBeNull();
  });

  it('returns null for an object with a numeric type field', () => {
    expect(parseMobileInbound(JSON.stringify({ type: 42 }))).toBeNull();
  });

  it('returns null for truncated JSON', () => {
    expect(parseMobileInbound('{"type":"pi')).toBeNull();
  });

  it('returns null for completely malformed input', () => {
    expect(parseMobileInbound('{not valid json}')).toBeNull();
  });
});

// ── Unrecognised types are now rejected (strict validation) ───────────────────

describe('parseMobileInbound — rejects unknown types', () => {
  it('returns null for an outbound-style type (not a MobileInbound variant)', () => {
    const result = parseMobileInbound(
      JSON.stringify({ type: 'response', message: 'echo' }),
    );
    expect(result).toBeNull();
  });

  it('returns null for a completely fabricated type', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'totally_bogus' })),
    ).toBeNull();
  });
});

// ── Malformed payloads: correct type, missing / wrong-typed fields ────────────

describe('parseMobileInbound — rejects malformed payloads', () => {
  // ── Missing required fields ──

  it('rejects history_request missing conversationId', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({
          type: 'history_request',
          before: 1000,
          limit: 50,
        }),
      ),
    ).toBeNull();
  });

  it('rejects history_request missing before', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({
          type: 'history_request',
          conversationId: 'c1',
          limit: 50,
        }),
      ),
    ).toBeNull();
  });

  it('rejects history_request missing limit', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({
          type: 'history_request',
          conversationId: 'c1',
          before: 1000,
        }),
      ),
    ).toBeNull();
  });

  it('rejects load_conversation missing conversationId', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'load_conversation' })),
    ).toBeNull();
  });

  it('rejects rename_conversation missing title', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({
          type: 'rename_conversation',
          conversationId: 'c1',
        }),
      ),
    ).toBeNull();
  });

  it('rejects rename_conversation missing conversationId', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({ type: 'rename_conversation', title: 'New title' }),
      ),
    ).toBeNull();
  });

  it('rejects delete_conversation missing conversationId', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'delete_conversation' })),
    ).toBeNull();
  });

  it('rejects delete_multiple_conversations missing conversationIds', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({ type: 'delete_multiple_conversations' }),
      ),
    ).toBeNull();
  });

  it('rejects plugin_switch missing name', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'plugin_switch' })),
    ).toBeNull();
  });

  it('rejects scheduler_toggle missing id', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'scheduler_toggle' })),
    ).toBeNull();
  });

  it('rejects scheduler_delete missing id', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'scheduler_delete' })),
    ).toBeNull();
  });

  it('rejects scheduler_run missing id', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'scheduler_run' })),
    ).toBeNull();
  });

  it('rejects scheduler_create missing name', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({
          type: 'scheduler_create',
          cronExpression: '* * * * *',
          taskPrompt: 'Go',
        }),
      ),
    ).toBeNull();
  });

  it('rejects scheduler_create missing cronExpression', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({
          type: 'scheduler_create',
          name: 'Job',
          taskPrompt: 'Go',
        }),
      ),
    ).toBeNull();
  });

  it('rejects scheduler_create missing taskPrompt', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({
          type: 'scheduler_create',
          name: 'Job',
          cronExpression: '* * * * *',
        }),
      ),
    ).toBeNull();
  });

  it('rejects scheduler_create with zero required fields', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'scheduler_create' })),
    ).toBeNull();
  });

  it('rejects scheduler_update missing id', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({ type: 'scheduler_update', taskPrompt: 'x' }),
      ),
    ).toBeNull();
  });

  it('rejects scheduler_update missing taskPrompt', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({ type: 'scheduler_update', id: 'task-1' }),
      ),
    ).toBeNull();
  });

  it('rejects search_request missing query', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({ type: 'search_request', requestId: 'r1' }),
      ),
    ).toBeNull();
  });

  it('rejects search_request missing requestId', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({ type: 'search_request', query: 'test' }),
      ),
    ).toBeNull();
  });

  it('rejects suggestion_dismiss missing id', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'suggestion_dismiss' })),
    ).toBeNull();
  });

  it('rejects suggestion_complete missing id', () => {
    expect(
      parseMobileInbound(JSON.stringify({ type: 'suggestion_complete' })),
    ).toBeNull();
  });

  // ── Wrong field types ──

  it('rejects history_request with string before', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({
          type: 'history_request',
          conversationId: 'c1',
          before: 'not-a-num',
          limit: 50,
        }),
      ),
    ).toBeNull();
  });

  it('rejects history_request with string limit', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({
          type: 'history_request',
          conversationId: 'c1',
          before: 1000,
          limit: 'fifty',
        }),
      ),
    ).toBeNull();
  });

  it('rejects load_conversation with numeric conversationId', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({ type: 'load_conversation', conversationId: 12345 }),
      ),
    ).toBeNull();
  });

  it('rejects plugin_switch with numeric name', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({ type: 'plugin_switch', name: 42 }),
      ),
    ).toBeNull();
  });

  it('rejects delete_multiple_conversations with non-string array items', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({
          type: 'delete_multiple_conversations',
          conversationIds: [1, 2, 3],
        }),
      ),
    ).toBeNull();
  });

  it('rejects delete_multiple_conversations with non-array conversationIds', () => {
    expect(
      parseMobileInbound(
        JSON.stringify({
          type: 'delete_multiple_conversations',
          conversationIds: 'not-an-array',
        }),
      ),
    ).toBeNull();
  });

  // ── Optional fields with wrong types are silently stripped ──

  it('strips non-numeric timeoutMs from scheduler_create', () => {
    const msg = {
      type: 'scheduler_create',
      name: 'Job',
      cronExpression: '* * * * *',
      taskPrompt: 'Go',
      timeoutMs: 'not-a-number',
    };
    const result = parseMobileInbound(JSON.stringify(msg));
    expect(result).not.toBeNull();
    if (result?.type === 'scheduler_create') {
      expect(result.timeoutMs).toBeUndefined();
    }
  });

  it('strips non-string optional name from scheduler_update', () => {
    const msg = {
      type: 'scheduler_update',
      id: 'task-1',
      taskPrompt: 'Go',
      name: 123,
    };
    const result = parseMobileInbound(JSON.stringify(msg));
    expect(result).not.toBeNull();
    if (result?.type === 'scheduler_update') {
      expect(result.name).toBeUndefined();
    }
  });

  // ── Extra fields are dropped (validators reconstruct clean objects) ──

  it('drops extra fields not in the schema', () => {
    const msg = {
      type: 'ping',
      evil: 'payload',
      __proto__: { admin: true },
    };
    const result = parseMobileInbound(JSON.stringify(msg));
    expect(result).not.toBeNull();
    expect(result).toEqual({ type: 'ping' });
    expect((result as Record<string, unknown>).evil).toBeUndefined();
  });
});

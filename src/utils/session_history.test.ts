import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateSessionId,
  createSession,
  saveSession,
  loadSession,
  listSessions,
  addMessageToSession,
  exportSessionToMarkdown,
  exportSessionToJson,
  type Session
} from './session_history';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HISTORY_DIR = join(homedir(), '.mia', 'history');

describe('session_history', () => {
  beforeEach(() => {
    // Clean history directory before each test
    if (existsSync(HISTORY_DIR)) {
      rmSync(HISTORY_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up after tests
    if (existsSync(HISTORY_DIR)) {
      rmSync(HISTORY_DIR, { recursive: true, force: true });
    }
  });

  describe('generateSessionId', () => {
    it('should generate session ID with date and time', () => {
      const id = generateSessionId();
      // Format: YYYY-MM-DD_HH-MM-SS
      expect(id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    });

    it('should generate unique IDs for different calls', async () => {
      const id1 = generateSessionId();
      // Small delay to ensure different timestamp
      await new Promise(r => setTimeout(r, 1100));
      const id2 = generateSessionId();
      expect(id1).not.toBe(id2);
    });

    it('should use current date', () => {
      const id = generateSessionId();
      const today = new Date().toISOString().split('T')[0];
      expect(id).toContain(today);
    });
  });

  describe('createSession', () => {
    it('should create a new session with default values', () => {
      const session = createSession();

      expect(session.id).toBeDefined();
      expect(session.startedAt).toBeGreaterThan(0);
      expect(session.lastUpdated).toBeGreaterThan(0);
      expect(session.messages).toEqual([]);
      expect(session.tokenCount).toBe(0);
    });

    it('should set startedAt and lastUpdated to same value initially', () => {
      const session = createSession();
      expect(session.startedAt).toBe(session.lastUpdated);
    });

    it('should generate session ID', () => {
      const session = createSession();
      expect(session.id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    });
  });

  describe('saveSession and loadSession', () => {
    it('should save and load a session', async () => {
      const session = createSession();
      session.messages.push({
        role: 'user',
        content: 'Hello',
        timestamp: Date.now()
      });

      await saveSession(session);

      const loaded = await loadSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(session.id);
      expect(loaded?.messages).toHaveLength(1);
      expect(loaded?.messages[0].content).toBe('Hello');
    });

    it('should create history directory if it does not exist', async () => {
      expect(existsSync(HISTORY_DIR)).toBe(false);

      const session = createSession();
      await saveSession(session);

      expect(existsSync(HISTORY_DIR)).toBe(true);
    });

    it('should return null for non-existent session', async () => {
      const loaded = await loadSession('non-existent-session-id');
      expect(loaded).toBeNull();
    });

    it('should preserve all session fields', async () => {
      const session = createSession();
      session.tokenCount = 1234;
      session.messages.push({
        role: 'assistant',
        content: 'Test response',
        timestamp: 1234567890
      });

      await saveSession(session);
      const loaded = await loadSession(session.id);

      expect(loaded?.tokenCount).toBe(1234);
      expect(loaded?.messages[0].timestamp).toBe(1234567890);
    });
  });

  describe('listSessions', () => {
    it('should return empty array when no sessions exist', async () => {
      const sessions = await listSessions();
      expect(sessions).toEqual([]);
    });

    it('should list saved sessions', async () => {
      const session1 = createSession();
      await saveSession(session1);

      await new Promise(r => setTimeout(r, 1100));

      const session2 = createSession();
      await saveSession(session2);

      const sessions = await listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions).toContain(session1.id);
      expect(sessions).toContain(session2.id);
    });

    it('should return sessions in reverse chronological order', async () => {
      const session1 = createSession();
      await saveSession(session1);

      await new Promise(r => setTimeout(r, 1100));

      const session2 = createSession();
      await saveSession(session2);

      const sessions = await listSessions();
      // Most recent first
      expect(sessions[0]).toBe(session2.id);
      expect(sessions[1]).toBe(session1.id);
    });

    it('should filter out non-JSON files', async () => {
      const session = createSession();
      await saveSession(session);

      // Create a non-JSON file in history directory
      const fs = await import('fs/promises');
      await fs.writeFile(join(HISTORY_DIR, 'readme.txt'), 'test', 'utf-8');

      const sessions = await listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toBe(session.id);
    });
  });

  describe('addMessageToSession', () => {
    it('should add message to session', async () => {
      const session = createSession();

      await addMessageToSession(session, 'user', 'Hello');

      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].role).toBe('user');
      expect(session.messages[0].content).toBe('Hello');
      expect(session.messages[0].timestamp).toBeGreaterThan(0);
    });

    it('should update lastUpdated timestamp', async () => {
      const session = createSession();
      const originalLastUpdated = session.lastUpdated;

      await new Promise(r => setTimeout(r, 10));
      await addMessageToSession(session, 'user', 'Test');

      expect(session.lastUpdated).toBeGreaterThan(originalLastUpdated);
    });

    it('should save session after adding message', async () => {
      const session = createSession();
      await addMessageToSession(session, 'user', 'Test message');

      const loaded = await loadSession(session.id);
      expect(loaded?.messages).toHaveLength(1);
      expect(loaded?.messages[0].content).toBe('Test message');
    });

    it('should update token count if provided', async () => {
      const session = createSession();

      await addMessageToSession(session, 'user', 'Hello', 42);

      expect(session.tokenCount).toBe(42);
    });

    it('should not update token count if not provided', async () => {
      const session = createSession();
      session.tokenCount = 100;

      await addMessageToSession(session, 'user', 'Hello');

      expect(session.tokenCount).toBe(100);
    });

    it('should handle multiple messages', async () => {
      const session = createSession();

      await addMessageToSession(session, 'user', 'First');
      await addMessageToSession(session, 'assistant', 'Response');
      await addMessageToSession(session, 'user', 'Second');

      expect(session.messages).toHaveLength(3);
      expect(session.messages[0].role).toBe('user');
      expect(session.messages[1].role).toBe('assistant');
      expect(session.messages[2].role).toBe('user');
    });
  });

  describe('exportSessionToMarkdown', () => {
    it('should export session to markdown format', () => {
      const session = createSession();
      session.messages.push({
        role: 'user',
        content: 'Hello',
        timestamp: Date.now()
      });
      session.messages.push({
        role: 'assistant',
        content: 'Hi there!',
        timestamp: Date.now()
      });
      session.tokenCount = 25;

      const markdown = exportSessionToMarkdown(session);

      expect(markdown).toContain('# MIA Session Export');
      expect(markdown).toContain(`**Session ID:** ${session.id}`);
      expect(markdown).toContain('**Messages:** 2');
      expect(markdown).toContain('**Tokens Used:** 25');
      expect(markdown).toContain('👤 User');
      expect(markdown).toContain('🤖 MIA');
      expect(markdown).toContain('Hello');
      expect(markdown).toContain('Hi there!');
    });

    it('should format timestamps in messages', () => {
      const session = createSession();
      const timestamp = new Date('2025-02-15T10:30:45.123Z').getTime();
      session.messages.push({
        role: 'user',
        content: 'Test',
        timestamp
      });

      const markdown = exportSessionToMarkdown(session);

      // Should include time like 10:30:45
      expect(markdown).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it('should handle sessions with no messages', () => {
      const session = createSession();

      const markdown = exportSessionToMarkdown(session);

      expect(markdown).toContain('# MIA Session Export');
      expect(markdown).toContain('**Messages:** 0');
    });
  });

  describe('exportSessionToJson', () => {
    it('should export session to pretty-printed JSON', () => {
      const session = createSession();
      session.messages.push({
        role: 'user',
        content: 'Test',
        timestamp: 123456
      });

      const json = exportSessionToJson(session);
      const parsed = JSON.parse(json);

      expect(parsed.id).toBe(session.id);
      expect(parsed.messages).toHaveLength(1);
      expect(parsed.messages[0].content).toBe('Test');
    });

    it('should format JSON with indentation', () => {
      const session = createSession();

      const json = exportSessionToJson(session);

      // Pretty-printed JSON should have newlines and indentation
      expect(json).toContain('\n');
      expect(json).toMatch(/\s{2}/); // 2-space indentation
    });

    it('should preserve all session data', () => {
      const session = createSession();
      session.tokenCount = 500;
      session.messages.push({
        role: 'assistant',
        content: 'Response',
        timestamp: 999
      });

      const json = exportSessionToJson(session);
      const parsed = JSON.parse(json) as Session;

      expect(parsed.tokenCount).toBe(500);
      expect(parsed.messages[0].timestamp).toBe(999);
      expect(parsed.startedAt).toBe(session.startedAt);
      expect(parsed.lastUpdated).toBe(session.lastUpdated);
    });
  });
});

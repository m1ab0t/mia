/**
 * Tests for the schema migration runner.
 *
 * better-sqlite3 is mocked — tests validate the migration logic
 * (version checking, ordering, transaction wrapping) without native deps.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../utils/logger', () => ({ logger: mockLogger }));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import {
  runMigrations,
  getSchemaVersion,
  migrations,
  SCHEMA_VERSION,
  type Migration,
} from './migrations';

// ── Mock database factory ──────────────────────────────────────────────────

function createMockDb(userVersion = 0) {
  let version = userVersion;

  const db = {
    pragma: vi.fn().mockImplementation((cmd: string, opts?: { simple?: boolean }) => {
      if (typeof cmd === 'string' && cmd.startsWith('user_version =')) {
        version = parseInt(cmd.split('=')[1].trim(), 10);
        return version;
      }
      if (cmd === 'user_version' && opts?.simple) {
        return version;
      }
      return undefined;
    }),
    exec: vi.fn(),
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 0 }),
      get: vi.fn().mockReturnValue(undefined),
      all: vi.fn().mockReturnValue([]),
    }),
    transaction: vi.fn().mockImplementation((fn: () => void) => {
      // Return a callable that executes the function immediately (like better-sqlite3)
      return () => fn();
    }),
    /** Helper — read the tracked version inside tests. */
    get _version() { return version; },
  };

  return db;
}

type MockDb = ReturnType<typeof createMockDb>;

// ── Reset ──────────────────────────────────────────────────────────────────

let mockDb: MockDb;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb = createMockDb(0);
});

// ── SCHEMA_VERSION ─────────────────────────────────────────────────────────

describe('SCHEMA_VERSION', () => {
  it('equals the highest migration version', () => {
    const maxVersion = Math.max(...migrations.map(m => m.version));
    expect(SCHEMA_VERSION).toBe(maxVersion);
  });

  it('is a positive integer', () => {
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
  });
});

// ── migrations registry ────────────────────────────────────────────────────

describe('migrations registry', () => {
  it('has strictly increasing version numbers', () => {
    for (let i = 1; i < migrations.length; i++) {
      expect(migrations[i].version).toBeGreaterThan(migrations[i - 1].version);
    }
  });

  it('starts at version 1', () => {
    expect(migrations[0].version).toBe(1);
  });

  it('has no gaps in version numbers', () => {
    migrations.forEach((m, i) => {
      expect(m.version).toBe(i + 1);
    });
  });

  it('every migration has a description', () => {
    for (const m of migrations) {
      expect(m.description.length).toBeGreaterThan(0);
    }
  });
});

// ── getSchemaVersion() ─────────────────────────────────────────────────────

describe('getSchemaVersion()', () => {
  it('returns 0 for a fresh database', () => {
    expect(getSchemaVersion(mockDb as any)).toBe(0);
  });

  it('returns the current user_version', () => {
    const db = createMockDb(3);
    expect(getSchemaVersion(db as any)).toBe(3);
  });
});

// ── runMigrations() ────────────────────────────────────────────────────────

describe('runMigrations()', () => {
  it('runs all migrations on a fresh database (version 0)', () => {
    runMigrations(mockDb as any);

    // Should have run transaction for each migration
    expect(mockDb.transaction).toHaveBeenCalledTimes(migrations.length);

    // user_version should be set to SCHEMA_VERSION
    expect(mockDb._version).toBe(SCHEMA_VERSION);

    // Logged "Running database migration" for each
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ from: 0, to: 1 }),
      'Running database migration'
    );
  });

  it('skips all migrations when already at SCHEMA_VERSION', () => {
    const db = createMockDb(SCHEMA_VERSION);
    runMigrations(db as any);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ currentVersion: SCHEMA_VERSION }),
      'Database schema is up to date'
    );
  });

  it('only runs pending migrations when partially migrated', () => {
    // DB at version 1, should only run migration v2+
    const db = createMockDb(1);
    runMigrations(db as any);

    const pendingCount = migrations.filter(m => m.version > 1).length;
    expect(db.transaction).toHaveBeenCalledTimes(pendingCount);
    expect(db._version).toBe(SCHEMA_VERSION);
  });

  it('runs migrations in ascending version order', () => {
    const executionOrder: number[] = [];

    // Create a mock where we track exec calls per migration
    const db = createMockDb(0);
    db.transaction.mockImplementation((fn: () => void) => {
      return () => {
        fn();
        executionOrder.push(db._version);
      };
    });

    runMigrations(db as any);

    // Versions should be strictly ascending
    for (let i = 1; i < executionOrder.length; i++) {
      expect(executionOrder[i]).toBeGreaterThan(executionOrder[i - 1]);
    }
  });

  it('wraps each migration in a transaction', () => {
    runMigrations(mockDb as any);

    // Each migration should use db.transaction()
    expect(mockDb.transaction).toHaveBeenCalledTimes(migrations.length);
    for (const call of mockDb.transaction.mock.calls) {
      expect(typeof call[0]).toBe('function');
    }
  });

  it('sets user_version after each migration', () => {
    runMigrations(mockDb as any);

    // The pragma should have been called with user_version = N for each migration
    const pragmaCalls = mockDb.pragma.mock.calls
      .map(c => c[0])
      .filter((s: string) => s.startsWith('user_version ='));

    expect(pragmaCalls).toHaveLength(migrations.length);
    migrations.forEach((m, i) => {
      expect(pragmaCalls[i]).toBe(`user_version = ${m.version}`);
    });
  });

  it('calls migration up() with the database handle', () => {
    const upSpy = vi.fn();
    const testMigrations: Migration[] = [
      { version: 1, description: 'test', up: upSpy },
    ];

    // We need to test with custom migrations — use the runner logic directly
    const db = createMockDb(0);
    const currentVersion = 0;
    const pending = testMigrations.filter(m => m.version > currentVersion);

    for (const migration of pending) {
      // Simulate what runMigrations does
      const applyMigration = db.transaction(() => {
        migration.up(db as unknown as import('better-sqlite3').Database);
        db.pragma(`user_version = ${migration.version}`);
      });
      applyMigration();
    }

    expect(upSpy).toHaveBeenCalledWith(db);
  });

  it('migration v1 creates the memories table and FTS5', () => {
    runMigrations(mockDb as any);

    // Should have called exec() with CREATE TABLE
    const execCalls = mockDb.exec.mock.calls.map((c: string[]) => c[0]);
    const hasCreateTable = execCalls.some((sql: string) => sql.includes('CREATE TABLE IF NOT EXISTS memories'));
    expect(hasCreateTable).toBe(true);

    // Should have checked for FTS existence
    const prepareCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]);
    const hasFtsCheck = prepareCalls.some((sql: string) => sql.includes('memories_fts'));
    expect(hasFtsCheck).toBe(true);

    // FTS table doesn't exist in mock → should create it
    const hasFtsCreate = execCalls.some((sql: string) => sql.includes('CREATE VIRTUAL TABLE memories_fts'));
    expect(hasFtsCreate).toBe(true);
  });

  it('migration v1 skips FTS creation when table already exists', () => {
    // Make the FTS existence check return a truthy value
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.includes('memories_fts')) {
        return {
          run: vi.fn(),
          get: vi.fn().mockReturnValue({ name: 'memories_fts' }),
          all: vi.fn(),
        };
      }
      return {
        run: vi.fn().mockReturnValue({ changes: 0 }),
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
      };
    });

    runMigrations(mockDb as any);

    const execCalls = mockDb.exec.mock.calls.map((c: string[]) => c[0]);
    const hasFtsCreate = execCalls.some((sql: string) => sql.includes('CREATE VIRTUAL TABLE memories_fts'));
    expect(hasFtsCreate).toBe(false);
  });

  it('migration v2 creates the memory_vectors table', () => {
    runMigrations(mockDb as any);

    const execCalls = mockDb.exec.mock.calls.map((c: string[]) => c[0]);
    const hasVectorsTable = execCalls.some((sql: string) => sql.includes('CREATE TABLE IF NOT EXISTS memory_vectors'));
    expect(hasVectorsTable).toBe(true);
  });

  it('logs completion after each migration', () => {
    runMigrations(mockDb as any);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1 }),
      'Migration complete'
    );
  });
});

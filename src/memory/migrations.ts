/**
 * Schema migration system for the SQLite memory store.
 *
 * Uses `PRAGMA user_version` to track the current schema version.
 * Each migration brings the DB from version N-1 → N and runs inside
 * a transaction for atomicity.  Migrations are idempotent where
 * possible so re-running against an existing DB is safe.
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';

export interface Migration {
  /** Target version this migration upgrades to. */
  version: number;
  /** Human-readable description for log output. */
  description: string;
  /** Forward migration — receives the raw Database handle. */
  up: (db: Database.Database) => void;
}

/**
 * Current schema version.  Bump this when adding a new migration.
 */
export const SCHEMA_VERSION = 2;

/**
 * Migration registry.  Append new migrations here — never reorder or mutate
 * existing entries.  Each `up` function should use `IF NOT EXISTS` guards
 * wherever SQL supports them.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    description: 'Initial schema: memories table, FTS5, indexes, triggers',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('conversation','fact','context','summary')),
          timestamp INTEGER NOT NULL,
          metadata TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
        CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      `);

      // FTS5 virtual table — check before creating since CREATE VIRTUAL TABLE
      // does not support IF NOT EXISTS.
      const ftsExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'`
      ).get();

      if (!ftsExists) {
        db.exec(`
          CREATE VIRTUAL TABLE memories_fts USING fts5(
            content,
            content=memories,
            content_rowid=rowid,
            tokenize='porter unicode61'
          );

          -- Sync triggers
          CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
          END;

          CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
          END;

          CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
            INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
          END;

          -- Populate FTS from any existing rows (handles upgrade from non-FTS schema)
          INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories;
        `);
      }
    },
  },
  {
    version: 2,
    description: 'Add memory_vectors table for hybrid RRF search',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_vectors (
          memory_id TEXT PRIMARY KEY,
          embedding BLOB NOT NULL,
          model TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_vectors_model
          ON memory_vectors(model);
      `);

      db.pragma('foreign_keys = ON');
    },
  },
];

/**
 * Read the current schema version from the database.
 */
export function getSchemaVersion(db: Database.Database): number {
  return (db.pragma('user_version', { simple: true }) as number) ?? 0;
}

/**
 * Run all pending migrations against the database.
 *
 * Reads `PRAGMA user_version` to determine the current schema version,
 * then applies each migration whose version exceeds it — in order,
 * each wrapped in a transaction.
 *
 * Pre-existing databases (user_version = 0) that already have tables
 * are handled safely because migration 1 uses IF NOT EXISTS guards.
 */
export function runMigrations(db: Database.Database): void {
  const currentVersion = getSchemaVersion(db);

  const pending = migrations
    .filter(m => m.version > currentVersion)
    .slice()
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    logger.debug({ currentVersion }, 'Database schema is up to date');
    return;
  }

  for (const migration of pending) {
    logger.info(
      { from: migration.version - 1, to: migration.version, description: migration.description },
      'Running database migration'
    );

    const applyMigration = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });

    applyMigration();

    logger.info({ version: migration.version }, 'Migration complete');
  }
}

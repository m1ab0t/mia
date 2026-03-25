/**
 * Central path constants for MIA directories and files
 */

import { join } from 'path';
import { homedir } from 'os';

/**
 * Root MIA directory: ~/.mia
 */
export const MIA_DIR = join(homedir(), '.mia');

/**
 * MIA environment file: ~/.mia/.env
 */
export const MIA_ENV_FILE = join(MIA_DIR, '.env');

/**
 * Debug logs directory: ~/.mia/debug
 */
export const DEBUG_DIR = join(MIA_DIR, 'debug');

/**
 * Context snapshots directory: ~/.mia/context
 */
export const CONTEXT_DIR = join(MIA_DIR, 'context');

/**
 * Chat history database path: ~/.mia/chat-history
 */
export const DB_PATH = join(MIA_DIR, 'chat-history');

/**
 * Plugin dispatch traces directory: ~/.mia/traces
 *
 * NDJSON files named YYYY-MM-DD.ndjson are written here by TraceLogger and
 * read by the log, recap, usage, and standup commands.
 */
export const TRACES_DIR = join(MIA_DIR, 'traces');

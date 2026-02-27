import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { formatJson } from '../utils/json-format';
import { MIA_DIR } from '../constants/paths';
const PID_FILE = join(MIA_DIR, 'daemon.pid');
const STATUS_FILE = join(MIA_DIR, 'daemon.status.json');
const READY_FILE = join(MIA_DIR, 'daemon.ready');
export const LOG_FILE = join(MIA_DIR, 'daemon.log');

export interface DaemonStatus {
  pid: number;
  startedAt: number;
  version: string;
  commit: string;
  p2pKey: string | null;
  p2pPeers: number;
  schedulerTasks: number;
  pluginTasks?: number;
  pluginCompleted?: number;
  activePlugin?: string;
  memoryCacheHits?: number;
  memoryCacheMisses?: number;
}

function ensureMiaDir(): void {
  if (!existsSync(MIA_DIR)) {
    mkdirSync(MIA_DIR, { recursive: true });
  }
}

export function writePidFile(pid: number): void {
  ensureMiaDir();
  writeFileSync(PID_FILE, String(pid), 'utf-8');
}

export function readPidFile(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const content = readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writeStatusFile(status: DaemonStatus): void {
  ensureMiaDir();
  writeFileSync(STATUS_FILE, formatJson(status), 'utf-8');
}

/**
 * Async version of writeStatusFile — preferred for daemon periodic updates
 * to avoid blocking the event loop.
 */
export async function writeStatusFileAsync(status: DaemonStatus): Promise<void> {
  await mkdir(MIA_DIR, { recursive: true });
  await writeFile(STATUS_FILE, formatJson(status), 'utf-8');
}

export function readStatusFile(): DaemonStatus | null {
  try {
    if (!existsSync(STATUS_FILE)) return null;
    const content = readFileSync(STATUS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function removeStatusFile(): void {
  try {
    if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
  } catch {
    // ignore
  }
}

/**
 * Write the ready file so that a restarting parent daemon can confirm the
 * new process has completed its full startup sequence before tearing itself
 * down. The file contains the PID of the newly-ready daemon.
 */
export function writeReadyFile(pid: number): void {
  ensureMiaDir();
  writeFileSync(READY_FILE, String(pid), 'utf-8');
}

export function readReadyFile(): number | null {
  try {
    if (!existsSync(READY_FILE)) return null;
    const content = readFileSync(READY_FILE, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function removeReadyFile(): void {
  try {
    if (existsSync(READY_FILE)) unlinkSync(READY_FILE);
  } catch {
    // ignore
  }
}

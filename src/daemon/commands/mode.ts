/**
 * CLI command: mia mode
 *
 * Switch the daemon's interaction mode between coding and general.
 *
 * Usage:
 *   mia mode              — show current mode
 *   mia mode coding       — full coding context (git, workspace, codebase, memory)
 *   mia mode general      — lightweight context (personality, memory, conversation only)
 *
 * When the daemon is running, a SIGHUP is sent so it picks up the config
 * change in-memory immediately without requiring a restart.
 */

import { x, dim, cyan, green, red, bold, DASH } from '../../utils/ansi.js';
import { readMiaConfig, writeMiaConfig } from '../../config/mia-config.js';
import { readPidFileAsync } from '../pid.js';
import { isPidAlive } from './lifecycle.js';

/** The two supported interaction modes. */
const VALID_MODES = ['coding', 'general'] as const;
type Mode = typeof VALID_MODES[number];

function isValidMode(value: string): value is Mode {
  return (VALID_MODES as readonly string[]).includes(value);
}

export async function handleModeCommand(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();

  // ── Help ──────────────────────────────────────────────────────────────
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return;
  }

  const config = readMiaConfig();
  const currentMode: Mode = config.activeMode === 'general' ? 'general' : 'coding';

  // ── Show current mode (no args) ───────────────────────────────────────
  if (!sub) {
    const desc = modeDescription(currentMode);
    console.log(`\n  ${bold}mode${x} ${dim}·${x} ${cyan}${currentMode}${x}`);
    console.log(`  ${dim}${desc}${x}\n`);
    console.log(`  ${dim}Switch with${x} ${cyan}mia mode coding${x} ${dim}or${x} ${cyan}mia mode general${x}\n`);
    return;
  }

  // ── Validate target mode ──────────────────────────────────────────────
  if (!isValidMode(sub)) {
    console.error(`\n  ${red}unknown mode${x} ${dim}·${x} ${sub}`);
    console.error(`  ${dim}valid options:${x} ${cyan}coding${x}${dim},${x} ${cyan}general${x}\n`);
    process.exit(1);
  }

  // ── Already in target mode ────────────────────────────────────────────
  if (sub === currentMode) {
    console.log(`\n  ${dim}already in${x} ${cyan}${currentMode}${x} ${dim}mode${x}\n`);
    return;
  }

  // ── Switch mode ───────────────────────────────────────────────────────
  writeMiaConfig({ activeMode: sub });
  console.log(`\n  ${green}✓${x} Switched to ${cyan}${sub}${x} mode`);
  console.log(`  ${dim}${modeDescription(sub)}${x}`);

  // If the daemon is running, signal it via SIGHUP so it picks up the
  // config change in-memory and applies the new mode to all future
  // dispatches without requiring a restart.
  const pid = await readPidFileAsync();
  if (isPidAlive(pid)) {
    try {
      process.kill(pid as number, 'SIGHUP');
      console.log(`  ${dim}daemon notified${x} ${dim}·${x} ${dim}takes effect immediately${x}`);
    } catch {
      console.log(`  ${dim}daemon running${x} ${dim}·${x} ${dim}takes effect on next dispatch${x}`);
    }
  }
  console.log('');
}

// ── Helpers ───────────────────────────────────────────────────────────────

function modeDescription(mode: Mode): string {
  return mode === 'coding'
    ? 'Full context — codebase, git, workspace, memory, project instructions.'
    : 'Lightweight — personality, memory, and conversation only. Token-efficient.';
}

function printHelp(): void {
  console.log(`
  ${bold}mode${x}  ${dim}${DASH} switch interaction mode${x}

  ${cyan}mia mode${x}              ${dim}show current mode${x}
  ${cyan}mia mode coding${x}       ${dim}full coding context${x}
  ${cyan}mia mode general${x}      ${dim}lightweight, token-efficient${x}

  ${dim}coding  — codebase, git, workspace, memory, project instructions${x}
  ${dim}general — personality, memory, and conversation only${x}
`);
}

/**
 * P2P sub-commands: status, qr, refresh.
 */

import { readPidFileAsync } from '../pid.js';
import { x, bold, dim, red, green, cyan, gray } from '../../utils/ansi.js';
import { hexToBase64 } from '../../utils/encoding.js';
// @ts-ignore - no type declarations
import qrcode from 'qrcode-terminal';
import { isPidAlive, requireDaemonRunning, handleStop, handleStart } from './lifecycle.js';

export async function handleP2PCommand(sub: string): Promise<void> {
  switch (sub) {
    case 'status': {
      const daemonStatus = await requireDaemonRunning();
      if (!daemonStatus) return;

      const { status } = daemonStatus;

      if (!status) {
        console.log(`\n  ${dim}starting up...${x}\n`);
        return;
      }

      console.log('');
      console.log(`  ${bold}p2p${x}${' '.repeat(29)}${status.p2pKey ? `${green}online${x}` : `${red}offline${x}`}`);
      console.log(`  ${dim}${'─ '.repeat(19)}${x}`);
      if (status.p2pKey) {
        console.log(`  ${gray}key${x}   ${dim}${status.p2pKey}${x}`);
        console.log(`  ${gray}peers${x} ${status.p2pPeers} connected`);
      }
      console.log('');
      return;
    }

    case 'qr': {
      const daemonStatus = await requireDaemonRunning();
      if (!daemonStatus) return;

      const { status } = daemonStatus;

      if (!status?.p2pKey) {
        console.log(`\n  ${dim}p2p is not connected${x}\n`);
        return;
      }

      console.log('');
      console.log(`  ${bold}qr${x} ${dim}· ${status.p2pKey}${x}`);
      console.log(`  ${dim}${'─ '.repeat(19)}${x}`);
      const b64Key = hexToBase64(status.p2pKey);
      qrcode.generate(b64Key, { small: true }, (code: string) => {
        console.log(code);
      });
      return;
    }

    case 'refresh': {
      const { refreshP2PSeed } = await import('../../config/mia-config.js');
      const newSeed = refreshP2PSeed();
      console.log(`  ${green}seed generated${x} ${dim}· ${newSeed.substring(0, 16)}...${x}`);

      // Restart daemon if running so it picks up the new seed
      const pid = await readPidFileAsync();
      if (isPidAlive(pid)) {
        console.log(`  ${dim}restarting daemon...${x}`);
        await handleStop();
        await handleStart();
      } else {
        console.log(`  ${dim}run${x} ${cyan}mia start${x} ${dim}to use the new seed${x}`);
      }
      return;
    }

    default:
      console.error(`  ${red}unknown command${x} ${dim}· ${sub}${x}`);
      console.log(`  ${dim}usage${x} ${cyan}mia p2p${x} ${dim}[status|qr|refresh]${x}`);
      process.exit(1);
  }
}

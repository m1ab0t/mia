/**
 * Plugin sub-commands: list, switch, info, test.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readPidFile } from '../pid.js';
import { x, bold, dim, red, green, cyan, gray } from '../../utils/ansi.js';
import { isPidAlive } from './lifecycle.js';
import { DEFAULT_PLUGIN } from '../../constants.js';

const ALL_PLUGIN_NAMES = ['claude-code', 'opencode', 'codex', 'gemini'] as const;

export async function handlePluginCommand(sub: string): Promise<void> {
  switch (sub) {
    case 'list': {
      const { readMiaConfig } = await import('../../config/mia-config.js');
      const { createPluginByName } = await import('../../plugins/index.js');

      const miaConfig = readMiaConfig();
      const activePluginName = miaConfig.activePlugin || DEFAULT_PLUGIN;
      const dash = `${dim}${'─ '.repeat(19)}${x}`;
      console.log('');
      console.log(`  ${bold}plugins${x}`);
      console.log(`  ${dash}`);

      for (const name of ALL_PLUGIN_NAMES) {
        const isActive = name === activePluginName;
        const pluginConfig = miaConfig.plugins?.[name];

        const plugin = createPluginByName(name);
        await plugin.initialize({ name, enabled: true, ...pluginConfig });

        let available = false;
        try { available = await plugin.isAvailable(); } catch { /* treat as unavailable */ }

        const indicator = isActive ? `${green}●${x}` : `${dim}○${x}`;
        const availStr = available ? `${green}ok${x}` : `${red}not installed${x}`;
        const modelStr = pluginConfig?.model ? `  ${dim}${pluginConfig.model}${x}` : '';
        const activeTag = isActive ? `  ${cyan}active${x}` : '';
        console.log(`  ${indicator} ${isActive ? bold : ''}${name}${isActive ? x : ''}${modelStr}${activeTag}  ${availStr}`);
      }
      console.log('');
      console.log(`  ${dim}switch with${x} ${cyan}mia plugin switch <name>${x}`);
      console.log('');
      break;
    }

    case 'switch': {
      const targetName = process.argv[4];
      const { readMiaConfig, writeMiaConfig: writeMiaCfg } = await import('../../config/mia-config.js');

      if (!targetName) {
        console.log(`\n  ${dim}usage${x} ${cyan}mia plugin switch${x} ${dim}<name>${x}`);
        console.log(`  ${dim}available${x} ${dim}·${x} ${ALL_PLUGIN_NAMES.join(', ')}\n`);
        process.exit(1);
      }

      if (!ALL_PLUGIN_NAMES.includes(targetName as typeof ALL_PLUGIN_NAMES[number])) {
        console.log(`\n  ${red}unknown plugin${x} ${dim}· ${targetName}${x}`);
        console.log(`  ${dim}available${x} ${dim}·${x} ${ALL_PLUGIN_NAMES.join(', ')}\n`);
        process.exit(1);
      }

      const miaConfig = readMiaConfig();
      const currentPlugin = miaConfig.activePlugin || DEFAULT_PLUGIN;

      if (currentPlugin === targetName) {
        console.log(`\n  ${dim}already active${x} ${dim}·${x} ${cyan}${targetName}${x}\n`);
        break;
      }

      writeMiaCfg({ activePlugin: targetName });
      console.log(`\n  ${green}switched${x} ${dim}·${x} ${dim}${currentPlugin}${x} ${dim}→${x} ${cyan}${targetName}${x}`);

      // If daemon is running, signal it via SIGUSR2 so it hot-swaps the plugin
      // in-memory and broadcasts plugin_switched to all connected mobile peers.
      const pid = readPidFile();
      if (isPidAlive(pid)) {
        try {
          process.kill(pid as number, 'SIGUSR2');
          console.log(`  ${dim}daemon notified${x} ${dim}·${x} ${dim}change propagated in realtime${x}`);
        } catch {
          console.log(`  ${dim}daemon running${x} ${dim}·${x} ${dim}takes effect on next dispatch${x}`);
        }
      }
      console.log('');
      break;
    }

    case 'info': {
      const { readMiaConfig } = await import('../../config/mia-config.js');
      const targetName = process.argv[4] || (readMiaConfig().activePlugin || DEFAULT_PLUGIN);
      const miaConfig = readMiaConfig();
      const name = targetName;
      const pluginConfig = miaConfig.plugins?.[name];

      const dash = `${dim}${'─ '.repeat(19)}${x}`;
      console.log('');
      console.log(`  ${bold}plugin info${x}${' '.repeat(14)}${cyan}${name}${x}`);
      console.log(`  ${dash}`);

      if (pluginConfig?.binary)  console.log(`  ${gray}binary${x} ${dim}··${x} ${pluginConfig.binary}`);
      if (pluginConfig?.model)   console.log(`  ${gray}model${x}  ${dim}··${x} ${pluginConfig.model}`);
      if (pluginConfig?.apiUrl)  console.log(`  ${gray}apiUrl${x} ${dim}··${x} ${pluginConfig.apiUrl}`);

      const docsPath = join(homedir(), '.mia', 'plugins', `${name}.md`);
      if (existsSync(docsPath)) {
        console.log('');
        const docs = readFileSync(docsPath, 'utf-8').trim();
        // Print each line with 2-space indent
        for (const line of docs.split('\n')) {
          console.log(`  ${line}`);
        }
      } else {
        console.log('');
        const hints: Record<string, string> = {
          'claude-code': 'npm install -g @anthropic-ai/claude-code',
          'opencode':    'npm install -g opencode-ai',
          'codex':       'npm install -g @openai/codex',
          'gemini':      'npm install -g @google/gemini-cli',
        };
        if (hints[name]) {
          console.log(`  ${gray}install${x} ${dim}··${x} ${hints[name]}`);
        }
        console.log(`  ${dim}add detailed docs at${x} ${dim}~/.mia/plugins/${name}.md${x}`);
      }
      console.log('');
      break;
    }

    case 'test': {
      const { readMiaConfig } = await import('../../config/mia-config.js');
      const { createPluginByName } = await import('../../plugins/index.js');

      const miaConfig = readMiaConfig();
      const targetArg = process.argv[4];
      const activePluginName = targetArg || miaConfig.activePlugin || DEFAULT_PLUGIN;
      const pluginConfig = miaConfig.plugins?.[activePluginName];

      const dash = `${dim}${'─ '.repeat(19)}${x}`;
      console.log('');
      console.log(`  ${bold}plugin test${x}${' '.repeat(15)}${cyan}${activePluginName}${x}`);
      console.log(`  ${dash}`);

      if (pluginConfig?.model) {
        console.log(`  ${gray}model${x}  ${dim}${pluginConfig.model}${x}`);
      }

      // Instantiate the active plugin directly — no daemon needed
      const plugin = createPluginByName(activePluginName);

      await plugin.initialize({
        name: activePluginName,
        enabled: true,
        ...pluginConfig,
      });

      // Check the binary/server is available before dispatching
      const available = await plugin.isAvailable();
      if (!available) {
        console.log(`  ${gray}binary${x} ${red}not found${x}`);
        console.log(`  ${dim}install hint: check mia p2p status or plugin docs${x}`);
        console.log('');
        process.exit(1);
      }
      console.log(`  ${gray}binary${x} ${green}ok${x}`);
      console.log('');

      const testPrompt = 'Reply with exactly: ok';
      console.log(`  ${dim}prompt${x}  ${testPrompt}`);
      console.log(`  ${dim}${'─ '.repeat(19)}${x}`);

      const started = Date.now();
      let output = '';
      let failed = false;

      try {
        process.stdout.write('  ');
        const result = await plugin.dispatch(
          testPrompt,
          {
            memoryFacts: [],
            codebaseContext: '',
            gitContext: '',
            workspaceSnapshot: '',
            projectInstructions: '',
          },
          {
            conversationId: `test-${Date.now()}`,
            workingDirectory: process.cwd(),
          },
          {
            onToken: (token: string) => {
              process.stdout.write(token);
              output += token;
            },
            onToolCall: (toolName: string) => {
              console.log(`\n  ${dim}· ${toolName}${x}`);
              process.stdout.write('  ');
            },
            onToolResult: () => { /* no-op for test */ },
            onDone: (finalOutput: string) => {
              output = finalOutput || output;
            },
            onError: (err: Error) => {
              failed = true;
              console.log(`\n  ${red}error${x} ${err.message}`);
            },
          },
        );
        if (!output && result.output) output = result.output;
      } catch (err: unknown) {
        failed = true;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`\n  ${red}dispatch error${x} ${msg}`);
      }

      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log('');
      console.log(`  ${dash}`);

      if (failed) {
        console.log(`  ${red}FAIL${x} ${dim}${elapsed}s${x}`);
      } else {
        console.log(`  ${green}PASS${x} ${dim}${elapsed}s${x}`);
      }
      console.log('');

      try { await plugin.shutdown(); } catch { /* ignore */ }
      process.exit(failed ? 1 : 0);
    }

    default:
      console.error(`  ${red}unknown command${x} ${dim}· ${sub}${x}`);
      console.log(`  ${dim}usage${x} ${cyan}mia plugin${x} ${dim}[list|switch|test|info]${x}`);
      process.exit(1);
  }
}

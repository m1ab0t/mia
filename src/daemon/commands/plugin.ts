/**
 * Plugin sub-commands: list, switch, info, test.
 *
 * Each sub-command is implemented as a dedicated handler function, keeping the
 * top-level dispatch thin and each handler independently testable.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readPidFileAsync } from '../pid.js';
import { x, bold, dim, red, green, cyan, gray } from '../../utils/ansi.js';
import { getErrorMessage } from '../../utils/error-message.js';
import { isPidAlive } from './lifecycle.js';
import { parseSubcommandArgs } from './parse-utils.js';
import { DEFAULT_PLUGIN } from '../constants.js';

const ALL_PLUGIN_NAMES = ['claude-code', 'opencode', 'codex', 'gemini'] as const;
type PluginName = typeof ALL_PLUGIN_NAMES[number];

// ── Shared formatting helpers ────────────────────────────────────────────────

const DASH = () => `${dim}${'─ '.repeat(19)}${x}`;

const INSTALL_HINTS: Record<string, string> = {
  'claude-code': 'npm install -g @anthropic-ai/claude-code',
  'opencode':    'npm install -g opencode-ai',
  'codex':       'npm install -g @openai/codex',
  'gemini':      'npm install -g @google/gemini-cli',
};

// ── Sub-command: list ────────────────────────────────────────────────────────

async function handlePluginList(): Promise<void> {
  const { readMiaConfig } = await import('../../config/mia-config.js');
  const { createPluginByName } = await import('../../plugins/index.js');

  const miaConfig = readMiaConfig();
  const activePluginName = miaConfig.activePlugin || DEFAULT_PLUGIN;

  console.log('');
  console.log(`  ${bold}plugins${x}`);
  console.log(`  ${DASH()}`);

  for (const name of ALL_PLUGIN_NAMES) {
    const isActive = name === activePluginName;
    const pluginConfig = miaConfig.plugins?.[name];

    const plugin = createPluginByName(name);
    try {
      await plugin.initialize({ name, enabled: true, ...pluginConfig });

      let available = false;
      try { available = await plugin.isAvailable(); } catch { /* treat as unavailable */ }

      const indicator = isActive ? `${green}●${x}` : `${dim}○${x}`;
      const availStr = available ? `${green}ok${x}` : `${red}not installed${x}`;
      const modelStr = pluginConfig?.model ? `  ${dim}${pluginConfig.model}${x}` : '';
      const activeTag = isActive ? `  ${cyan}active${x}` : '';
      console.log(`  ${indicator} ${isActive ? bold : ''}${name}${isActive ? x : ''}${modelStr}${activeTag}  ${availStr}`);
    } finally {
      try { await plugin.shutdown(); } catch { /* ignore cleanup errors */ }
    }
  }

  console.log('');
  console.log(`  ${dim}switch with${x} ${cyan}mia plugin switch <name>${x}`);
  console.log('');
}

// ── Sub-command: switch ──────────────────────────────────────────────────────

async function handlePluginSwitch(targetName: string | undefined): Promise<void> {
  const { readMiaConfig, writeMiaConfig: writeMiaCfg } = await import('../../config/mia-config.js');

  if (!targetName) {
    console.log(`\n  ${dim}usage${x} ${cyan}mia plugin switch${x} ${dim}<name>${x}`);
    console.log(`  ${dim}available${x} ${dim}·${x} ${ALL_PLUGIN_NAMES.join(', ')}\n`);
    process.exit(1);
  }

  if (!ALL_PLUGIN_NAMES.includes(targetName as PluginName)) {
    console.log(`\n  ${red}unknown plugin${x} ${dim}· ${targetName}${x}`);
    console.log(`  ${dim}available${x} ${dim}·${x} ${ALL_PLUGIN_NAMES.join(', ')}\n`);
    process.exit(1);
  }

  const miaConfig = readMiaConfig();
  const currentPlugin = miaConfig.activePlugin || DEFAULT_PLUGIN;

  if (currentPlugin === targetName) {
    console.log(`\n  ${dim}already active${x} ${dim}·${x} ${cyan}${targetName}${x}\n`);
    return;
  }

  writeMiaCfg({ activePlugin: targetName });
  console.log(`\n  ${green}switched${x} ${dim}·${x} ${dim}${currentPlugin}${x} ${dim}→${x} ${cyan}${targetName}${x}`);

  // If daemon is running, signal it via SIGUSR2 so it hot-swaps the plugin
  // in-memory and broadcasts plugin_switched to all connected mobile peers.
  const pid = await readPidFileAsync();
  if (isPidAlive(pid)) {
    try {
      process.kill(pid as number, 'SIGUSR2');
      console.log(`  ${dim}daemon notified${x} ${dim}·${x} ${dim}change propagated in realtime${x}`);
    } catch {
      console.log(`  ${dim}daemon running${x} ${dim}·${x} ${dim}takes effect on next dispatch${x}`);
    }
  }
  console.log('');
}

// ── Sub-command: info ────────────────────────────────────────────────────────

async function handlePluginInfo(targetArg: string | undefined): Promise<void> {
  const { readMiaConfig } = await import('../../config/mia-config.js');

  const miaConfig = readMiaConfig();
  const name = targetArg || miaConfig.activePlugin || DEFAULT_PLUGIN;
  const pluginConfig = miaConfig.plugins?.[name];

  console.log('');
  console.log(`  ${bold}plugin info${x}${' '.repeat(14)}${cyan}${name}${x}`);
  console.log(`  ${DASH()}`);

  if (pluginConfig?.binary)  console.log(`  ${gray}binary${x} ${dim}··${x} ${pluginConfig.binary}`);
  if (pluginConfig?.model)   console.log(`  ${gray}model${x}  ${dim}··${x} ${pluginConfig.model}`);
  if (pluginConfig?.apiUrl)  console.log(`  ${gray}apiUrl${x} ${dim}··${x} ${pluginConfig.apiUrl}`);

  const docsPath = join(homedir(), '.mia', 'plugins', `${name}.md`);
  if (existsSync(docsPath)) {
    console.log('');
    const docs = readFileSync(docsPath, 'utf-8').trim();
    for (const line of docs.split('\n')) {
      console.log(`  ${line}`);
    }
  } else {
    console.log('');
    if (INSTALL_HINTS[name]) {
      console.log(`  ${gray}install${x} ${dim}··${x} ${INSTALL_HINTS[name]}`);
    }
    console.log(`  ${dim}add detailed docs at${x} ${dim}~/.mia/plugins/${name}.md${x}`);
  }
  console.log('');
}

// ── Sub-command: test ────────────────────────────────────────────────────────

async function handlePluginTest(targetArg: string | undefined): Promise<void> {
  const { readMiaConfig } = await import('../../config/mia-config.js');
  const { createPluginByName } = await import('../../plugins/index.js');

  const miaConfig = readMiaConfig();
  const activePluginName = targetArg || miaConfig.activePlugin || DEFAULT_PLUGIN;
  const pluginConfig = miaConfig.plugins?.[activePluginName];

  console.log('');
  console.log(`  ${bold}plugin test${x}${' '.repeat(15)}${cyan}${activePluginName}${x}`);
  console.log(`  ${DASH()}`);

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
    const msg = getErrorMessage(err);
    console.log(`\n  ${red}dispatch error${x} ${msg}`);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log('');
  console.log(`  ${DASH()}`);

  if (failed) {
    console.log(`  ${red}FAIL${x} ${dim}${elapsed}s${x}`);
  } else {
    console.log(`  ${green}PASS${x} ${dim}${elapsed}s${x}`);
  }
  console.log('');

  try { await plugin.shutdown(); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
}

// ── Top-level dispatch ───────────────────────────────────────────────────────

export async function handlePluginCommand(sub: string, argv: string[] = []): Promise<void> {
  const args = parseSubcommandArgs(argv);

  switch (sub) {
    case 'list':   return handlePluginList();
    case 'switch': return handlePluginSwitch(args.arg(0));
    case 'info':   return handlePluginInfo(args.arg(0));
    case 'test':   return handlePluginTest(args.arg(0));
    default:
      console.error(`  ${red}unknown command${x} ${dim}· ${sub}${x}`);
      console.log(`  ${dim}usage${x} ${cyan}mia plugin${x} ${dim}[list|switch|test|info]${x}`);
      process.exit(1);
  }
}

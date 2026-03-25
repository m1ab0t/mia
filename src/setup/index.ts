/**
 * mia setup — First-run setup wizard
 *
 * Flow is plugin-specific:
 *
 *   claude-code → auth (browser/key) → chat model (Anthropic) → Claude CLI check → daemon
 *   codex       → auth (login/key)   → coding model (OpenAI)  → chat model (any) → daemon
 *   opencode    → auth (opencode/key) → coding model (any)    → chat model (any) → daemon
 *   gemini      → auth (oauth/key)   → coding model (Google)  → chat model (any) → daemon
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as p from '@clack/prompts';
import {
  runSetupToken,
  saveToken,
  saveEnvVar,
  getEnvVar,
  getExistingToken,
} from '../auth/index.js';
import { runGeminiOAuth } from '../auth/gemini-oauth.js';
import { ansi } from '../utils/ansi.js';
import { MIA_DIR } from '../constants/paths.js';
import { getErrorMessage } from '../utils/error-message.js';
import { handleStart } from '../daemon/commands.js';
import { readStatusFileAsync } from '../daemon/pid.js';
import { readMiaConfig, writeMiaConfig } from '../config/mia-config.js';
import { hexToBase64 } from '../utils/encoding.js';
// @ts-ignore - no type declarations
import qrcode from 'qrcode-terminal';

const { reset: x, bold, dim, cyan, green } = ansi;

// ── Known plugins ─────────────────────────────────────────────────────

interface PluginInfo {
  name: string;
  label: string;
  binary: string;
  description: string;
  installed: boolean;
}

const KNOWN_PLUGINS: Omit<PluginInfo, 'installed'>[] = [
  { name: 'claude-code', label: 'Claude Code', binary: 'claude',   description: 'Anthropic Claude' },
  { name: 'codex',       label: 'Codex CLI',   binary: 'codex',    description: 'OpenAI Codex' },
  { name: 'opencode',    label: 'opencode',    binary: 'opencode', description: 'open-source agent' },
  { name: 'gemini',      label: 'Gemini CLI',  binary: 'gemini',   description: 'Google Gemini' },
];

// ── Helpers ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function isBinaryInstalled(bin: string): boolean {
  try {
    execSync(`${bin} --version`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function detectPlugins(): PluginInfo[] {
  return KNOWN_PLUGINS.map(pl => ({ ...pl, installed: isBinaryInstalled(pl.binary) }));
}

function cancel(msg = 'Setup cancelled'): never {
  p.cancel(msg);
  process.exit(0);
}

// ── Claude CLI helpers ─────────────────────────────────────────────────

const CLAUDE_CONFIG_PATH = join(homedir(), '.claude', 'config.json');

function isClaudeCliAuthed(): boolean {
  try {
    const result = spawnSync('claude', ['-p', 'hi', '--output-format', 'json', '--max-turns', '1'], {
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = result.stdout?.toString() ?? '';
    try {
      return JSON.parse(out).is_error !== true;
    } catch {
      return result.status === 0;
    }
  } catch {
    return false;
  }
}

function getClaudeConfigKey(): string | null {
  try {
    if (!existsSync(CLAUDE_CONFIG_PATH)) return null;
    return JSON.parse(readFileSync(CLAUDE_CONFIG_PATH, 'utf-8')).primaryApiKey || null;
  } catch {
    return null;
  }
}

function clearClaudeConfigKey(): void {
  try {
    if (!existsSync(CLAUDE_CONFIG_PATH)) return;
    const config = JSON.parse(readFileSync(CLAUDE_CONFIG_PATH, 'utf-8'));
    delete config.primaryApiKey;
    writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  } catch { /* ignore */ }
}

// ── Codex CLI helpers ──────────────────────────────────────────────────

function isCodexCliAuthed(): boolean {
  try {
    return spawnSync('codex', ['login', 'status'], {
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).status === 0;
  } catch {
    return false;
  }
}

// ── Model lists ────────────────────────────────────────────────────────

const ANTHROPIC_MODELS = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'recommended · balanced' },
  { value: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  hint: 'fastest & cheap' },
  { value: 'claude-opus-4-6',   label: 'Claude Opus 4.6',   hint: 'most capable' },
];

const OPENAI_MODELS = [
  { value: 'gpt-5.4',             label: 'GPT-5.4',             hint: 'recommended · frontier · 1M context' },
  { value: 'gpt-5.2-chat-latest', label: 'GPT-5.2 Chat Latest', hint: 'previous latest' },
  { value: 'gpt-5.2',             label: 'GPT-5.2',             hint: 'previous release' },
  { value: 'gpt-5.1-chat-latest', label: 'GPT-5.1 Chat Latest', hint: 'always latest 5.1' },
  { value: 'gpt-5.1',             label: 'GPT-5.1',             hint: 'stable' },
  { value: 'gpt-5',               label: 'GPT-5',               hint: 'flagship' },
  { value: 'gpt-5-mini',          label: 'GPT-5 Mini',          hint: 'fast & efficient' },
  { value: 'gpt-5-nano',          label: 'GPT-5 Nano',          hint: 'fastest & cheapest' },
];

const GEMINI_MODELS = [
  { value: 'gemini-3.1-pro-preview',        label: 'Gemini 3.1 Pro',        hint: 'latest · most capable' },
  { value: 'gemini-3-flash-preview',         label: 'Gemini 3 Flash',        hint: 'recommended · fast & capable' },
  { value: 'gemini-3.1-flash-lite-preview',  label: 'Gemini 3.1 Flash-Lite', hint: 'cheapest · lightweight' },
  { value: 'gemini-2.5-pro',                 label: 'Gemini 2.5 Pro',        hint: 'previous gen' },
  { value: 'gemini-2.5-flash',               label: 'Gemini 2.5 Flash',      hint: 'previous gen · fast' },
];

async function pickModel(
  message: string,
  options: { value: string; label: string; hint?: string }[],
  placeholder = 'model-id',
): Promise<string> {
  const withCustom = [...options, { value: 'custom', label: 'Custom model', hint: 'Enter any model ID' }];
  const choice = await p.select({ message, options: withCustom });
  if (p.isCancel(choice)) cancel();
  if (choice === 'custom') {
    const custom = await p.text({ message: 'Model ID', placeholder, validate: v => (v ?? '').trim() ? undefined : 'Required' });
    if (p.isCancel(custom) || !custom) cancel();
    return (custom as string).trim();
  }
  return choice as string;
}

// ── Main ───────────────────────────────────────────────────────────────

export async function handleSetup(): Promise<void> {
  const isTTY = process.stdin.isTTY;

  p.intro('  mia setup  ');

  // ─── 1. Plugin detection & selection ───────────────────────────────

  const plugins = detectPlugins();
  const installed = plugins.filter(pl => pl.installed);

  p.note(
    plugins.map(pl => pl.installed
      ? `  ${green}●${x} ${bold}${pl.label}${x} ${dim}· ${pl.description}${x}`
      : `  ${dim}○ ${pl.label} · ${pl.description} (not found)${x}`
    ).join('\n'),
    'Coding agents',
  );

  if (installed.length === 0) {
    p.cancel('No coding agents found');
    console.log('');
    console.log(`  ${dim}Install at least one:${x}`);
    console.log(`  ${cyan}npm i -g @anthropic-ai/claude-code${x}  ${dim}· Claude Code${x}`);
    console.log(`  ${cyan}npm i -g @openai/codex${x}              ${dim}· Codex CLI${x}`);
    console.log(`  ${cyan}npm i -g opencode${x}                   ${dim}· opencode${x}`);
    console.log(`  ${cyan}npm i -g @google/gemini-cli${x}         ${dim}· Gemini CLI${x}`);
    console.log('');
    process.exit(1);
  }

  let activePlugin: string;

  if (installed.length === 1) {
    activePlugin = installed[0].name;
    p.log.success(`${installed[0].label} selected`);
  } else if (!isTTY) {
    activePlugin = installed[0].name;
    p.log.info(`Non-interactive — defaulting to ${installed[0].label}`);
  } else {
    const choice = await p.select({
      message: 'Which coding agent should mia use?',
      options: installed.map(pl => ({ value: pl.name, label: pl.label, hint: pl.description })),
    });
    if (p.isCancel(choice)) cancel();
    activePlugin = choice as string;
  }

  // Persist plugin choice
  const config = readMiaConfig();
  writeMiaConfig({
    activePlugin,
    plugins: {
      ...config.plugins,
      [activePlugin]: { ...config.plugins?.[activePlugin], name: activePlugin, enabled: true },
    },
  });

  // ─── 2. Plugin-specific auth + coding model ─────────────────────────

  if (activePlugin === 'claude-code' && isTTY) {
    // ── 2a. Claude Code ──────────────────────────────────────────────
    //
    // Auth: browser (claude setup-token) or paste ANTHROPIC_API_KEY.
    // Then pick the Anthropic model claude-code will use for coding tasks.

    const staleKey = getClaudeConfigKey();
    if (staleKey) {
      clearClaudeConfigKey();
      p.log.info(`Cleared stale key from ~/.claude/config.json ${dim}(${staleKey.slice(0, 10)}...${staleKey.slice(-4)})${x}`);
    }

    const existing = getExistingToken();
    if (existing) {
      p.log.success(`Anthropic API key · ${existing.slice(0, 10)}...${existing.slice(-4)}`);
    } else {
      const authChoice = await p.select({
        message: 'How would you like to authenticate with Anthropic?',
        options: [
          { value: 'browser', label: 'Browser auth', hint: 'claude setup-token' },
          { value: 'paste',   label: 'Paste API key', hint: 'ANTHROPIC_API_KEY' },
          { value: 'skip',    label: 'Skip for now' },
        ],
      });
      if (p.isCancel(authChoice)) cancel();

      if (authChoice === 'browser') {
        const result = await runSetupToken();
        if (!result.ok) {
          p.log.error(`setup-token failed: ${result.error ?? 'unknown'}`);
        } else {
          const token = await p.password({ message: 'Paste the token shown above' });
          if (!p.isCancel(token) && token) { saveToken(token as string); p.log.success('Token saved · ~/.mia/.env'); }
        }
      } else if (authChoice === 'paste') {
        const token = await p.password({ message: 'Paste your ANTHROPIC_API_KEY' });
        if (!p.isCancel(token) && token) { saveToken(token as string); p.log.success('API key saved · ~/.mia/.env'); }
      } else {
        p.log.warn('Auth skipped — set ANTHROPIC_API_KEY in ~/.mia/.env later');
      }
    }

    // Pick the model claude-code will use for coding tasks
    const claudeModel = await pickModel('Which model should Claude Code use?', ANTHROPIC_MODELS, 'claude-sonnet-4-6');
    const claudeCfg = readMiaConfig();
    writeMiaConfig({
      plugins: {
        ...claudeCfg.plugins,
        'claude-code': { ...claudeCfg.plugins?.['claude-code'], name: 'claude-code', enabled: true, model: claudeModel },
      },
    });
    p.log.success(`Claude Code model: ${claudeModel}`);

    // Check Claude CLI OAuth session
    const cs = p.spinner();
    cs.start('Checking Claude CLI session');
    const cliOk = isClaudeCliAuthed();
    cs.stop(cliOk ? 'Claude CLI authenticated' : 'Claude CLI not authenticated');

    if (!cliOk) {
      p.log.warn(`The Claude CLI needs its own OAuth session.\n  ${dim}/login only works inside the Claude interactive shell.${x}`);
      const fix = await p.confirm({ message: 'Open Claude Code to run /login? (type /exit when done)', initialValue: true });
      if (!p.isCancel(fix) && fix) {
        p.log.step(`Opening Claude Code — run ${cyan}/login${x} then ${cyan}/exit${x} to return here`);
        spawnSync('claude', [], { stdio: 'inherit' });
        p.log[isClaudeCliAuthed() ? 'success' : 'warn'](
          isClaudeCliAuthed() ? 'Claude CLI authenticated' : `CLI not authenticated — run ${cyan}/login${x} inside claude later`,
        );
      } else {
        p.log.info(`Open ${cyan}claude${x} and run ${cyan}/login${x} later to enable coding tasks`);
      }
    }

  } else if (activePlugin === 'codex' && isTTY) {
    // ── 2b. Codex CLI ────────────────────────────────────────────────
    //
    // Auth: codex login (browser) or paste OPENAI_API_KEY.
    // Then pick the model codex will use for coding tasks.

    p.log.info(`${dim}Codex CLI manages its own authentication.${x}`);

    if (isCodexCliAuthed()) {
      p.log.success('Codex CLI already authenticated');
    } else {
      const authMethod = await p.select({
        message: 'How should Codex authenticate?',
        options: [
          { value: 'login',   label: 'codex login (Recommended)', hint: 'Browser or OAuth flow' },
          { value: 'device',  label: 'Device auth',               hint: 'Headless / remote environments' },
          { value: 'api-key', label: 'Paste an API key',          hint: 'OPENAI_API_KEY → ~/.mia/.env' },
          { value: 'skip',    label: 'Skip for now',              hint: 'Run codex login later' },
        ],
      });
      if (p.isCancel(authMethod)) cancel();

      if (authMethod === 'login') {
        p.log.step(`Opening ${cyan}codex login${x} — complete auth, then return here`);
        let r = spawnSync('codex', ['login'], { stdio: 'inherit' });
        if (r.status !== 0) r = spawnSync('codex', ['--login'], { stdio: 'inherit' });
        p.log[r.status === 0 && isCodexCliAuthed() ? 'success' : 'warn'](
          r.status === 0 && isCodexCliAuthed() ? 'Codex CLI authenticated' : `Auth incomplete — run ${cyan}codex login${x} later`,
        );
      } else if (authMethod === 'device') {
        p.log.step(`Opening ${cyan}codex login --device-auth${x}`);
        const r = spawnSync('codex', ['login', '--device-auth'], { stdio: 'inherit' });
        p.log[r.status === 0 && isCodexCliAuthed() ? 'success' : 'warn'](
          r.status === 0 && isCodexCliAuthed() ? 'Codex CLI authenticated' : `Auth incomplete — run ${cyan}codex login --device-auth${x} later`,
        );
      } else if (authMethod === 'api-key') {
        const apiKey = await p.password({ message: 'Paste your OPENAI_API_KEY' });
        if (!p.isCancel(apiKey) && apiKey) {
          saveEnvVar('OPENAI_API_KEY', apiKey as string);
          p.log.success('OPENAI_API_KEY saved · ~/.mia/.env');
          const r = spawnSync('codex', ['login', '--with-api-key'], { input: `${apiKey}\n`, stdio: ['pipe', 'inherit', 'inherit'] });
          p.log[r.status === 0 && isCodexCliAuthed() ? 'success' : 'warn'](
            r.status === 0 && isCodexCliAuthed() ? 'Codex CLI authenticated' : `CLI not authenticated — run ${cyan}codex login${x} later`,
          );
        } else {
          p.log.warn('No key provided — set OPENAI_API_KEY in ~/.mia/.env later');
        }
      } else {
        p.log.info(`${dim}Run ${cyan}codex login${x}${dim} later to enable Codex CLI tasks.${x}`);
      }
    }

    // Pick the model codex will use for coding tasks
    const codexModel = await pickModel('Which model should Codex use for coding?', OPENAI_MODELS, 'gpt-5.4');
    const currentCfg = readMiaConfig();
    writeMiaConfig({
      plugins: {
        ...currentCfg.plugins,
        codex: { ...currentCfg.plugins?.['codex'], name: 'codex', enabled: true, model: codexModel },
      },
    });
    p.log.success(`Codex model: ${codexModel}`);

  } else if (activePlugin === 'opencode' && isTTY) {
    // ── 2c. opencode ─────────────────────────────────────────────────
    //
    // Auth: opencode auth login (supports many providers) or paste key.
    // Then pick the provider/model opencode will use for coding tasks.

    p.log.info(`${dim}opencode manages its own provider credentials.${x}`);

    let hasCredentials = false;
    try {
      hasCredentials = !execSync('opencode auth list', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).includes('0 credentials');
    } catch { /* assume no creds */ }

    let shouldAuth = !hasCredentials;
    if (hasCredentials) {
      const reauth = await p.confirm({ message: 'opencode credentials found. Re-authenticate?', initialValue: false });
      if (p.isCancel(reauth)) cancel();
      shouldAuth = reauth as boolean;
      if (!shouldAuth) p.log.success('opencode credentials already configured');
    }

    if (shouldAuth) {
      const authMethod = await p.select({
        message: 'How should opencode authenticate?',
        options: [
          { value: 'opencode-auth', label: 'opencode auth login (Recommended)', hint: 'Anthropic, OpenAI, GitHub Copilot, Google…' },
          { value: 'anthropic-key', label: 'Paste Anthropic key',               hint: 'ANTHROPIC_API_KEY → ~/.mia/.env' },
          { value: 'openai-key',    label: 'Paste OpenAI key',                  hint: 'OPENAI_API_KEY → ~/.mia/.env' },
          { value: 'skip',          label: 'Skip for now',                      hint: 'Run opencode auth login later' },
        ],
      });
      if (p.isCancel(authMethod)) cancel();

      if (authMethod === 'opencode-auth') {
        p.log.step(`Opening ${cyan}opencode auth login${x}`);
        const r = spawnSync('opencode', ['auth', 'login'], { stdio: 'inherit' });
        if (r.status !== 0) {
          p.log.warn(`Auth exited with code ${r.status} — run ${cyan}opencode auth login${x} later`);
        } else {
          try {
            const ok = !execSync('opencode auth list', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).includes('0 credentials');
            p.log[ok ? 'success' : 'warn'](ok ? 'opencode authenticated' : `No credentials detected — run ${cyan}opencode auth login${x} later`);
          } catch {
            p.log.warn(`Could not verify — run ${cyan}opencode auth login${x} later`);
          }
        }
      } else if (authMethod === 'anthropic-key') {
        const existing = getEnvVar('ANTHROPIC_API_KEY');
        if (existing) {
          p.log.success(`ANTHROPIC_API_KEY already set · ${existing.slice(0, 10)}...${existing.slice(-4)}`);
        } else {
          const key = await p.password({ message: 'Paste your ANTHROPIC_API_KEY' });
          if (!p.isCancel(key) && key) { saveEnvVar('ANTHROPIC_API_KEY', key as string); p.log.success('ANTHROPIC_API_KEY saved · ~/.mia/.env'); }
        }
      } else if (authMethod === 'openai-key') {
        const existing = getEnvVar('OPENAI_API_KEY');
        if (existing) {
          p.log.success(`OPENAI_API_KEY already set · ${existing.slice(0, 10)}...${existing.slice(-4)}`);
        } else {
          const key = await p.password({ message: 'Paste your OPENAI_API_KEY' });
          if (!p.isCancel(key) && key) { saveEnvVar('OPENAI_API_KEY', key as string); p.log.success('OPENAI_API_KEY saved · ~/.mia/.env'); }
        }
      } else {
        p.log.info(`${dim}Run ${cyan}opencode auth login${x}${dim} or set keys in ${cyan}~/.mia/.env${x}${dim} before starting.${x}`);
      }
    }

    // Pick the model opencode will use (provider/model format)
    const opencodeModels = [
      { value: 'anthropic/claude-sonnet-4-6',  label: 'Claude Sonnet 4.6',  hint: 'recommended · fast & capable' },
      { value: 'anthropic/claude-opus-4-6',    label: 'Claude Opus 4.6',    hint: 'most capable' },
      { value: 'anthropic/claude-haiku-4-5',   label: 'Claude Haiku 4.5',   hint: 'fastest · near-frontier' },
      { value: 'openai/gpt-5.4',               label: 'GPT-5.4',             hint: 'OpenAI · frontier · 1M context' },
      { value: 'openai/gpt-5.2-chat-latest',   label: 'GPT-5.2 Chat Latest', hint: 'OpenAI · previous latest' },
      { value: 'openai/gpt-5.2',               label: 'GPT-5.2',            hint: 'OpenAI · previous release' },
      { value: 'openai/gpt-5',                 label: 'GPT-5',              hint: 'OpenAI · flagship' },
      { value: 'openai/gpt-5-mini',            label: 'GPT-5 Mini',         hint: 'OpenAI · fast & efficient' },
    ];
    const opencodeModel = await pickModel('Which model should opencode use for coding?', opencodeModels, 'anthropic/claude-sonnet-4-6');
    const currentCfg = readMiaConfig();
    writeMiaConfig({
      plugins: {
        ...currentCfg.plugins,
        opencode: { ...currentCfg.plugins?.['opencode'], name: 'opencode', enabled: true, model: opencodeModel },
      },
    });
    p.log.success(`opencode model: ${opencodeModel}`);

  } else if (activePlugin === 'gemini' && isTTY) {
    // ── 2d. Gemini CLI ────────────────────────────────────────────────
    //
    // Auth: Google OAuth (free tier, no key needed) or paste GEMINI_API_KEY.
    // Then pick the Gemini model for coding tasks.

    p.log.info(`${dim}Gemini CLI supports Google OAuth (free) or a Gemini API key.${x}`);

    const existingGeminiKey = getEnvVar('GEMINI_API_KEY');
    if (existingGeminiKey) {
      p.log.success(`GEMINI_API_KEY · ${existingGeminiKey.slice(0, 10)}...${existingGeminiKey.slice(-4)}`);
    } else {
      const authMethod = await p.select({
        message: 'How should Gemini CLI authenticate?',
        options: [
          { value: 'oauth',   label: 'Google OAuth (Recommended)', hint: 'Free tier — browser auth on first use' },
          { value: 'api-key', label: 'Paste API key',              hint: 'GEMINI_API_KEY → ~/.mia/.env' },
          { value: 'skip',    label: 'Skip for now',               hint: 'Set GEMINI_API_KEY or run gemini later' },
        ],
      });
      if (p.isCancel(authMethod)) cancel();

      if (authMethod === 'oauth') {
        // Run the full in-process OAuth flow
        const spin = p.spinner();
        spin.start('Starting Gemini OAuth...');
        try {
          const creds = await runGeminiOAuth({
            isRemote: !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
            openUrl: async (url) => {
              spin.stop('Opening browser...');
              const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
              spawnSync(opener, [url], { stdio: 'ignore' });
            },
            log: (msg) => { spin.stop(); p.log.info(msg); spin.start('Waiting...'); },
            prompt: async (msg) => {
              spin.stop();
              const answer = await p.text({ message: msg });
              if (p.isCancel(answer)) cancel();
              return answer as string;
            },
            progress: {
              update: (msg) => spin.message(msg),
              stop: (msg) => spin.stop(msg),
            },
          });
          spin.stop('Google OAuth complete');
          saveEnvVar('GEMINI_OAUTH_ACCESS_TOKEN', creds.access);
          saveEnvVar('GEMINI_OAUTH_REFRESH_TOKEN', creds.refresh);
          saveEnvVar('GEMINI_OAUTH_EXPIRES', String(creds.expires));
          if (creds.email) saveEnvVar('GEMINI_OAUTH_EMAIL', creds.email);
          if (creds.projectId) saveEnvVar('GEMINI_OAUTH_PROJECT_ID', creds.projectId);
          p.log.success(`Authenticated as ${creds.email ?? 'Google account'} · project: ${creds.projectId}`);
        } catch (err) {
          spin.stop('OAuth failed');
          p.log.warn(`OAuth error: ${getErrorMessage(err)}`);
          p.log.info(`You can retry by running ${cyan}mia setup${x} again, or set ${cyan}GEMINI_API_KEY${x} in ~/.mia/.env`);
        }
      } else if (authMethod === 'api-key') {
        const key = await p.password({ message: 'Paste your GEMINI_API_KEY' });
        if (!p.isCancel(key) && key) {
          saveEnvVar('GEMINI_API_KEY', key as string);
          p.log.success('GEMINI_API_KEY saved · ~/.mia/.env');
        } else {
          p.log.warn('No key provided — set GEMINI_API_KEY in ~/.mia/.env later');
        }
      } else {
        p.log.info(`${dim}Set ${cyan}GEMINI_API_KEY${x}${dim} in ${cyan}~/.mia/.env${x}${dim} or run ${cyan}gemini${x}${dim} to authenticate via Google.${x}`);
      }
    }

    // Pick the model Gemini CLI will use for coding tasks
    const geminiModel = await pickModel('Which model should Gemini use for coding?', GEMINI_MODELS, 'gemini-3-flash-preview');
    const geminiCfg = readMiaConfig();
    writeMiaConfig({
      plugins: {
        ...geminiCfg.plugins,
        gemini: { ...geminiCfg.plugins?.['gemini'], name: 'gemini', enabled: true, model: geminiModel },
      },
    });
    p.log.success(`Gemini model: ${geminiModel}`);
  }

  // ─── 3. Create default profile files ────────────────────────────────

  ensureProfileFiles();

  // ─── 4. Daemon + P2P ────────────────────────────────────────────────

  const isFirstRun = !readMiaConfig().awakeningDone;

  const s = p.spinner();
  s.start('Starting daemon');
  await handleStart();
  s.stop('Daemon started');

  s.start('Establishing P2P network');
  const p2pKey = await waitForP2PKey();
  s.stop(p2pKey ? 'P2P online' : 'P2P not ready yet');

  if (p2pKey) {
    if (isFirstRun) showAwakening();
    showQRCode(p2pKey);
  } else {
    p.log.warn(`P2P not ready — run ${cyan}mia p2p qr${x} later`);
    if (isFirstRun) showAwakening();
  }

  p.outro(`mia is running · ${cyan}mia status${x} for details`);
}

// ── Profile file generation ──────────────────────────────────────────

const DEFAULT_PERSONALITY = `# Personality

You are Mia — a warm, curious, and direct AI companion.

## Voice
- Conversational and natural, never robotic or overly formal
- Concise by default, detailed when the topic warrants it
- Genuine curiosity about what the user is building

## Style
- Use plain language; avoid jargon unless the user does
- Be honest when you don't know something
- Match the user's energy — brief when they're brief, thorough when they explore
`;

const DEFAULT_USER = `# User Profile

<!-- Edit this file to help Mia remember who you are -->

- Name:
- Role:
- Timezone:
- Preferences:
`;

const DEFAULT_AGENTS = `# Mia Agent Instructions

This is the Mia daemon home directory (~/.mia). Mia is an AI coding assistant
that dispatches tasks to plugin agents (Claude Code, Codex, opencode, Gemini).

## Working in this directory

- **mia.json** — daemon config (active plugin, models, timeouts, feature flags)
- **PERSONALITY.md** — Mia's personality/voice definition
- **USER.md** — user profile and preferences
- **memory/** — persistent memory facts
- **conversations/** — conversation message store
- **conv-summaries/** — AI-generated conversation summaries
- **daemon.log** — live daemon log

## Key rules

- Do not modify mia.json directly unless asked; prefer \`mia config set\` commands
- Do not delete files under memory/ or conversations/ unless explicitly instructed
- Prefer surgical, minimal edits; avoid large refactors unless requested
`;

function ensureProfileFiles(): void {
  mkdirSync(MIA_DIR, { recursive: true });

  const personalityPath = join(MIA_DIR, 'PERSONALITY.md');
  const userPath = join(MIA_DIR, 'USER.md');
  const agentsPath = join(MIA_DIR, 'AGENTS.md');

  let created = 0;

  if (!existsSync(personalityPath)) {
    writeFileSync(personalityPath, DEFAULT_PERSONALITY, 'utf-8');
    created++;
  }

  if (!existsSync(userPath)) {
    writeFileSync(userPath, DEFAULT_USER, 'utf-8');
    created++;
  }

  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, DEFAULT_AGENTS, 'utf-8');
    created++;
  }

  if (created > 0) {
    p.log.success(`Created profile files in ~/.mia/`);
    p.log.info(`${dim}Edit ${cyan}~/.mia/PERSONALITY.md${x}${dim} and ${cyan}~/.mia/USER.md${x}${dim} to personalise mia${x}`);
  } else {
    p.log.success('Profile files already exist');
  }
}

// ── P2P polling ──────────────────────────────────────────────────────

async function waitForP2PKey(timeoutMs = 15000): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await readStatusFileAsync();
    if (status?.p2pKey) return status.p2pKey;
    await sleep(200);
  }
  return null;
}

// ── QR code display ──────────────────────────────────────────────────

function showQRCode(p2pKey: string): void {
  const b64Key = hexToBase64(p2pKey);
  const shortKey = p2pKey.slice(0, 8) + '...' + p2pKey.slice(-4);
  const qrLines: string[] = [];
  qrcode.generate(b64Key, { small: true }, (code: string) => { qrLines.push(code); });
  p.note(
    `${dim}key · ${shortKey}${x}\n\n` + qrLines.join('') + `\n${dim}Open the Mia app and scan to pair.${x}`,
    'Scan to connect',
  );
}

// ── Awakening notice ─────────────────────────────────────────────────

function showAwakening(): void {
  p.note(
    `${dim}First run detected.\nMia is waking up for the first time.\nOnce you connect, she'll introduce\nherself and get to know you.${x}`,
    `${cyan}✦${x} Awakening`,
  );
}

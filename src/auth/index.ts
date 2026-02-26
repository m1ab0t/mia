/**
 * Mia Auth - Claude Max subscription authentication
 *
 * Uses `claude setup-token` to generate a long-lived API token
 * from your Claude Max/Pro subscription.
 */

import { spawn, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getErrorMessage } from '../utils/error-message';
import { MIA_DIR } from '../constants/paths';

const ENV_FILE = join(MIA_DIR, '.env');

// ── Low-level .env file helpers ─────────────────────────────────────────────

/**
 * Read the contents of ~/.mia/.env, returning an empty string if the file
 * doesn't exist or cannot be read.
 */
export function readEnvContent(): string {
  try {
    return existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf-8') : '';
  } catch {
    return '';
  }
}

/**
 * Write content to ~/.mia/.env, creating the directory if needed.
 * File is created with 0o600 permissions (owner read/write only).
 */
export function writeEnvContent(content: string): void {
  if (!existsSync(MIA_DIR)) {
    mkdirSync(MIA_DIR, { recursive: true });
  }
  writeFileSync(ENV_FILE, content, { mode: 0o600 });
}

/**
 * Return a copy of `content` with all lines matching `key=…` removed.
 * Uses a plain string prefix check to avoid regex injection from keys
 * that contain regex metacharacters.
 */
function filterEnvKey(content: string, key: string): string {
  return content
    .split('\n')
    .filter(line => !line.startsWith(`${key}=`))
    .join('\n');
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Save (or update) an arbitrary key=value pair in ~/.mia/.env.
 * Existing lines with the same key are replaced.
 */
export function saveEnvVar(key: string, value: string): void {
  let content = filterEnvKey(readEnvContent(), key).trim();
  if (content) content += '\n';
  content += `${key}=${value}\n`;
  writeEnvContent(content);
}

/**
 * Remove a key from ~/.mia/.env.
 * No-op if the file doesn't exist or the key is not present.
 */
export function removeEnvVar(key: string): void {
  const existing = readEnvContent();
  if (!existing) return;
  const updated = filterEnvKey(existing, key).trimEnd();
  writeEnvContent(updated ? updated + '\n' : '');
}

/**
 * Save token to ~/.mia/.env as ANTHROPIC_API_KEY.
 */
export function saveToken(token: string): void {
  saveEnvVar('ANTHROPIC_API_KEY', token);
  console.log(`✅ Token saved to ${ENV_FILE}`);
}

/**
 * Read a specific env var from ~/.mia/.env (falling back to process.env).
 * Returns null if not found in either location.
 *
 * Key lookup uses a plain string comparison to avoid regex injection.
 */
export function getEnvVar(key: string): string | null {
  if (process.env[key]) return process.env[key]!;
  const content = readEnvContent();
  if (!content) return null;
  for (const line of content.split('\n')) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1).trim() || null;
    }
  }
  return null;
}

/**
 * Check if an Anthropic API token is already configured.
 * Checks process.env first, then ~/.mia/.env.
 */
export function getExistingToken(): string | null {
  return getEnvVar('ANTHROPIC_API_KEY');
}

// ── CLI utilities ────────────────────────────────────────────────────────────

/**
 * Check if Claude CLI is installed.
 */
export function checkClaudeCli(): { ok: boolean; error?: string } {
  try {
    execSync('claude --version', { stdio: 'pipe' });
    return { ok: true };
  } catch {
    return { ok: false, error: 'Claude CLI not installed. Run: npm install -g @anthropic-ai/claude-code' };
  }
}

/**
 * Run `claude setup-token` interactively.
 */
export function runSetupToken(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    console.log('\n🔐 Running claude setup-token...\n');
    console.log('This will open a browser to authenticate with your Claude Max subscription.\n');

    const proc = spawn('claude', ['setup-token'], {
      stdio: 'inherit',
      env: process.env
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `claude setup-token exited with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ ok: false, error: getErrorMessage(err) });
    });
  });
}

/**
 * Prompt user to paste their token (input is hidden).
 */
export async function promptForToken(): Promise<string | null> {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    console.log('\n📋 Paste your Anthropic API token (from claude setup-token or console.anthropic.com):');
    console.log('   (input is hidden)\n');

    process.stdout.write('Token: ');

    let token = '';
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (char: string) => {
      if (char === '\n' || char === '\r') {
        stdin.removeListener('data', onData);
        if (stdin.isTTY) {
          stdin.setRawMode(wasRaw ?? false);
        }
        console.log('\n');
        rl.close();
        resolve(token.trim() || null);
      } else if (char === '\u0003') {
        // Ctrl+C
        process.exit(0);
      } else if (char === '\u007F' || char === '\b') {
        // Backspace
        token = token.slice(0, -1);
      } else {
        token += char;
      }
    };

    stdin.on('data', onData);
  });
}

// ── Main auth command handler ────────────────────────────────────────────────

/**
 * Main auth command handler.
 */
export async function handleAuth(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'status') {
    const token = getExistingToken();
    if (token) {
      const masked = token.slice(0, 10) + '...' + token.slice(-4);
      console.log(`✅ Authenticated: ${masked}`);
      console.log(`   Source: ${process.env.ANTHROPIC_API_KEY ? 'environment' : ENV_FILE}`);
    } else {
      console.log('❌ Not authenticated');
      console.log('   Run: mia auth');
    }
    return;
  }

  if (subcommand === 'logout') {
    if (existsSync(ENV_FILE)) {
      removeEnvVar('ANTHROPIC_API_KEY');
      console.log('✅ Logged out (token removed from ~/.mia/.env)');
    } else {
      console.log('Already logged out');
    }
    return;
  }

  // Default: run auth flow
  console.log('🦞 Mia Authentication\n');

  const existing = getExistingToken();
  if (existing) {
    const masked = existing.slice(0, 10) + '...' + existing.slice(-4);
    console.log(`Already authenticated: ${masked}`);
    console.log('Run "mia auth logout" to clear, or continue to replace.\n');
  }

  const cliCheck = checkClaudeCli();

  if (cliCheck.ok) {
    console.log('Options:');
    console.log('  1. Claude Max/Pro subscription (uses claude setup-token)');
    console.log('  2. Paste API key manually\n');

    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const choice = await new Promise<string>((resolve) => {
      rl.question('Choose [1/2]: ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });

    if (choice === '1') {
      const result = await runSetupToken();
      if (!result.ok) {
        console.error('❌', result.error);
        process.exit(1);
      }

      console.log('\n📋 Now paste the token that was displayed above:');
      const token = await promptForToken();
      if (!token) {
        console.log('❌ No token provided');
        process.exit(1);
      }

      saveToken(token);
      console.log('\n✅ Authentication complete!');
      console.log('   Your Claude Max subscription is now linked.');
      return;
    }
  } else {
    console.log('Claude CLI not found - using manual token entry.\n');
    console.log('To use Claude Max subscription, first install Claude CLI:');
    console.log('  npm install -g @anthropic-ai/claude-code\n');
  }

  // Manual token entry
  const token = await promptForToken();
  if (!token) {
    console.log('❌ No token provided');
    process.exit(1);
  }

  if (!token.startsWith('sk-ant-')) {
    console.log('⚠️  Token doesn\'t look like an Anthropic API key (should start with sk-ant-)');
    console.log('   Saving anyway...\n');
  }

  saveToken(token);
  console.log('\n✅ Authentication complete!');
}

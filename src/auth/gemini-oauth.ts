/**
 * Gemini OAuth 2.0 + PKCE authentication for Mia.
 *
 * Ported from openclaw-src/extensions/google-gemini-cli-auth/oauth.ts.
 * Delegates credential extraction to the installed Gemini CLI binary.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { delimiter, dirname, join } from 'node:path';

const CLIENT_ID_KEYS = ['OPENCLAW_GEMINI_OAUTH_CLIENT_ID', 'GEMINI_CLI_OAUTH_CLIENT_ID'];
const CLIENT_SECRET_KEYS = ['OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET', 'GEMINI_CLI_OAUTH_CLIENT_SECRET'];

const REDIRECT_URI = 'http://localhost:8085/oauth2callback';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const TIER_FREE = 'free-tier';
const TIER_LEGACY = 'legacy-tier';
const TIER_STANDARD = 'standard-tier';

export type GeminiOAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  projectId: string;
};

// ── Credential extraction from Gemini CLI binary ──────────────────────

const CREDS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let cachedCliCreds: { clientId: string; clientSecret: string; cachedAt: number } | null = null;

function resolveEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function findInPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.cmd', '.bat', '.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function findFile(dir: string, name: string, depth: number): string | null {
  if (depth <= 0) return null;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory() && !e.name.startsWith('.')) {
        const found = findFile(p, name, depth - 1);
        if (found) return found;
      }
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES') throw err;
  }
  return null;
}

export function extractGeminiCliCredentials(): { clientId: string; clientSecret: string } | null {
  if (cachedCliCreds && Date.now() - cachedCliCreds.cachedAt < CREDS_CACHE_TTL_MS) {
    return { clientId: cachedCliCreds.clientId, clientSecret: cachedCliCreds.clientSecret };
  }
  cachedCliCreds = null;

  try {
    const geminiPath = findInPath('gemini');
    if (!geminiPath) return null;

    const resolvedPath = realpathSync(geminiPath);
    const geminiCliDir = dirname(dirname(resolvedPath));

    const searchPaths = [
      join(geminiCliDir, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js'),
      join(geminiCliDir, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'code_assist', 'oauth2.js'),
    ];

    let content: string | null = null;
    for (const p of searchPaths) {
      if (existsSync(p)) { content = readFileSync(p, 'utf8'); break; }
    }
    if (!content) {
      const found = findFile(geminiCliDir, 'oauth2.js', 10);
      if (found) content = readFileSync(found, 'utf8');
    }
    if (!content) return null;

    const idMatch = content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    const secretMatch = content.match(/(GOCSPX-[A-Za-z0-9_-]+)/);
    if (idMatch && secretMatch) {
      cachedCliCreds = { clientId: idMatch[1], clientSecret: secretMatch[1], cachedAt: Date.now() };
      return { clientId: idMatch[1], clientSecret: secretMatch[1] };
    }
  } catch {}
  return null;
}

function resolveOAuthClientConfig(): { clientId: string; clientSecret?: string } {
  const envClientId = resolveEnv(CLIENT_ID_KEYS);
  const envClientSecret = resolveEnv(CLIENT_SECRET_KEYS);
  if (envClientId) return { clientId: envClientId, clientSecret: envClientSecret };

  const extracted = extractGeminiCliCredentials();
  if (extracted) return extracted;

  throw new Error(
    'Gemini CLI not found. Install it first (npm install -g @google/gemini-cli), or set GEMINI_CLI_OAUTH_CLIENT_ID.',
  );
}

// ── PKCE + OAuth flow ─────────────────────────────────────────────────

function isWSL2(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const v = readFileSync('/proc/version', 'utf8').toLowerCase();
    return v.includes('wsl2') || v.includes('microsoft-standard');
  } catch { return false; }
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function buildAuthUrl(challenge: string, verifier: string): string {
  const { clientId } = resolveOAuthClientConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

function parseCallbackInput(input: string, expectedState: string): { code: string; state: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: 'No input provided' };
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') ?? expectedState;
    if (!code) return { error: "Missing 'code' parameter in URL" };
    return { code, state };
  } catch {
    return { code: trimmed, state: expectedState };
  }
}

async function waitForLocalCallback(expectedState: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const done = (err?: Error, code?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { server.close(); } catch {}
      if (err) reject(err);
      else if (code) resolve(code);
      else reject(new Error('OAuth callback completed without an authorization code'));
    };

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://localhost:8085`);
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404).end('Not found');
          return;
        }
        const error = url.searchParams.get('error');
        if (error) { res.writeHead(400).end(`OAuth error: ${error}`); done(new Error(`OAuth error: ${error}`)); return; }

        const code = url.searchParams.get('code')?.trim();
        const state = url.searchParams.get('state')?.trim();
        if (!code || !state) { res.writeHead(400).end('Missing code or state'); done(new Error('Missing OAuth code or state')); return; }
        if (state !== expectedState) { res.writeHead(400).end('Invalid state'); done(new Error('OAuth state mismatch')); return; }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
          '<!doctype html><html><body><h2>Mia — Gemini OAuth complete</h2><p>You can close this window.</p></body></html>',
        );
        done(undefined, code);
      } catch (err) { done(err instanceof Error ? err : new Error('OAuth callback failed')); }
    });

    server.once('error', (err) => done(err instanceof Error ? err : new Error('Server error')));
    server.listen(8085, 'localhost', () => {
      timer = setTimeout(() => done(new Error('OAuth callback timeout')), timeoutMs);
    });
  });
}

async function exchangeCodeForTokens(code: string, verifier: string): Promise<GeminiOAuthCredentials> {
  const { clientId, clientSecret } = resolveOAuthClientConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error(`Token exchange returned invalid response: missing access_token${data.error ? ` (error: ${data.error})` : ''}`);
  }
  if (!data.refresh_token) throw new Error('No refresh token received. Please try again.');
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;

  const accessToken = data.access_token as string;
  const refreshToken = data.refresh_token as string;
  const email = await getUserEmail(accessToken);
  const projectId = await discoverProject(accessToken);
  const expires = Date.now() + expiresIn * 1000 - 5 * 60 * 1000;

  return { access: accessToken, refresh: refreshToken, expires, email, projectId };
}

async function getUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.ok) return ((await res.json()) as { email?: string }).email;
  } catch {}
  return undefined;
}

function isVpcScAffected(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const details = ((payload as any).error?.details as unknown[]) ?? [];
  return (
    Array.isArray(details) &&
    details.some(
      (d: unknown) =>
        typeof d === 'object' && d !== null && (d as Record<string, unknown>)['reason'] === 'SECURITY_POLICY_VIOLATED',
    )
  );
}

function getDefaultTier(allowedTiers?: Array<{ id?: string; isDefault?: boolean }>): { id?: string } | undefined {
  if (!allowedTiers?.length) return { id: TIER_LEGACY };
  return allowedTiers.find((t) => t.isDefault) ?? { id: TIER_LEGACY };
}

async function pollOperation(
  name: string,
  headers: Record<string, string>,
): Promise<{ done?: boolean; response?: { cloudaicompanionProject?: { id?: string } } }> {
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${name}`, { headers });
    if (!res.ok) continue;
    const data = (await res.json()) as { done?: boolean; response?: { cloudaicompanionProject?: { id?: string } } };
    if (data.done) return data;
  }
  throw new Error('Operation polling timeout');
}

async function discoverProject(accessToken: string): Promise<string> {
  const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'google-api-nodejs-client/9.15.1',
    'X-Goog-Api-Client': 'gl-node/mia',
  };

  let data: { currentTier?: { id?: string }; cloudaicompanionProject?: string | { id?: string }; allowedTiers?: Array<{ id?: string; isDefault?: boolean }> } = {};

  try {
    const res = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cloudaicompanionProject: envProject, metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI', duetProject: envProject } }),
    });
    if (!res.ok) {
      const errPayload = await res.json().catch(() => null);
      if (isVpcScAffected(errPayload)) data = { currentTier: { id: TIER_STANDARD } };
      else throw new Error(`loadCodeAssist failed: ${res.status} ${res.statusText}`);
    } else {
      data = await res.json() as typeof data;
    }
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error('loadCodeAssist failed', { cause: err });
  }

  if (data.currentTier) {
    const proj = data.cloudaicompanionProject;
    if (typeof proj === 'string' && proj) return proj;
    if (typeof proj === 'object' && proj?.id) return proj.id;
    if (envProject) return envProject;
    throw new Error('This account requires GOOGLE_CLOUD_PROJECT to be set.');
  }

  const tier = getDefaultTier(data.allowedTiers);
  const tierId = tier?.id || TIER_FREE;
  if (tierId !== TIER_FREE && !envProject) throw new Error('This account requires GOOGLE_CLOUD_PROJECT to be set.');

  const onboardBody: Record<string, unknown> = { tierId, metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } };
  if (tierId !== TIER_FREE && envProject) { onboardBody.cloudaicompanionProject = envProject; (onboardBody.metadata as any).duetProject = envProject; }

  const onboardRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, { method: 'POST', headers, body: JSON.stringify(onboardBody) });
  if (!onboardRes.ok) throw new Error(`onboardUser failed: ${onboardRes.status}`);

  let lro = (await onboardRes.json()) as { done?: boolean; name?: string; response?: { cloudaicompanionProject?: { id?: string } } };
  if (!lro.done && lro.name) lro = await pollOperation(lro.name, headers);

  const projectId = lro.response?.cloudaicompanionProject?.id;
  if (projectId) return projectId;
  if (envProject) return envProject;
  throw new Error('Could not discover or provision a Google Cloud project. Set GOOGLE_CLOUD_PROJECT.');
}

// ── Public API ────────────────────────────────────────────────────────

export type GeminiOAuthContext = {
  /** Is this a remote / headless environment where we can't open a browser? */
  isRemote: boolean;
  /** Open a URL in the default browser */
  openUrl: (url: string) => Promise<void>;
  /** Log a line to the user */
  log: (msg: string) => void;
  /** Prompt the user for a string */
  prompt: (msg: string) => Promise<string>;
  /** Progress spinner helpers */
  progress: { update: (msg: string) => void; stop: (msg?: string) => void };
};

/**
 * Run the full Gemini OAuth flow.
 *
 * - Local environments: opens the browser and listens on localhost:8085 for the callback.
 * - Remote/WSL2 environments: prints the URL and asks the user to paste the redirect URL.
 */
export async function runGeminiOAuth(ctx: GeminiOAuthContext): Promise<GeminiOAuthCredentials> {
  const needsManual = ctx.isRemote || isWSL2();

  const { verifier, challenge } = generatePkce();
  const authUrl = buildAuthUrl(challenge, verifier);

  if (needsManual) {
    ctx.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);
    const callbackInput = await ctx.prompt('Paste the redirect URL here: ');
    const parsed = parseCallbackInput(callbackInput, verifier);
    if ('error' in parsed) throw new Error(parsed.error);
    if (parsed.state !== verifier) throw new Error('OAuth state mismatch — please try again');
    ctx.progress.update('Exchanging authorization code for tokens...');
    return exchangeCodeForTokens(parsed.code, verifier);
  }

  ctx.progress.update('Complete sign-in in the browser window...');
  try { await ctx.openUrl(authUrl); } catch { ctx.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`); }

  try {
    ctx.progress.update('Waiting for OAuth callback on localhost:8085...');
    const code = await waitForLocalCallback(verifier, 5 * 60 * 1000);
    ctx.progress.update('Exchanging authorization code for tokens...');
    return await exchangeCodeForTokens(code, verifier);
  } catch (err) {
    // Port busy — fall back to manual paste flow
    if (err instanceof Error && (err.message.includes('EADDRINUSE') || err.message.includes('listen'))) {
      ctx.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);
      const callbackInput = await ctx.prompt('Paste the redirect URL here: ');
      const parsed = parseCallbackInput(callbackInput, verifier);
      if ('error' in parsed) throw new Error(parsed.error);
      ctx.progress.update('Exchanging authorization code for tokens...');
      return exchangeCodeForTokens(parsed.code, verifier);
    }
    throw err;
  }
}

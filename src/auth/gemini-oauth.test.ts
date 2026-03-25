/**
 * Tests for auth/gemini-oauth.ts
 *
 * Covers the exported public surface:
 *   - extractGeminiCliCredentials(): credential discovery + TTL cache
 *   - runGeminiOAuth(ctx): OAuth flow for remote/manual environments
 *
 * Network calls (fetch) are mocked globally so no real HTTP is made.
 * Filesystem state is isolated via tmp directories.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GeminiOAuthContext } from './gemini-oauth';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mia-gemini-test-'));
  const binDir = join(dir, 'bin');
  const oauth2Dir = join(
    dir,
    'node_modules',
    '@google',
    'gemini-cli-core',
    'dist',
    'src',
    'code_assist',
  );
  return { dir, binDir, oauth2Dir };
}

/** Writes a minimal executable shell script to act as the `gemini` binary. */
function writeGeminiBin(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const p = join(binDir, 'gemini');
  writeFileSync(p, '#!/bin/sh\necho gemini\n', { mode: 0o755 });
  return p;
}

/** Writes a fake oauth2.js containing clientId and clientSecret patterns. */
function writeOauth2Js(
  oauth2Dir: string,
  clientId: string,
  clientSecret: string,
): void {
  mkdirSync(oauth2Dir, { recursive: true });
  writeFileSync(
    join(oauth2Dir, 'oauth2.js'),
    `const CLIENT_ID = "${clientId}"; const SECRET = "${clientSecret}";`,
  );
}

/** Builds a minimal GeminiOAuthContext mock for the remote/manual flow. */
function makeCtx(overrides: Partial<GeminiOAuthContext> = {}): GeminiOAuthContext & {
  logs: string[];
  prompts: string[];
  progressUpdates: string[];
} {
  const logs: string[] = [];
  const prompts: string[] = [];
  const progressUpdates: string[] = [];
  return {
    isRemote: true,
    openUrl: vi.fn().mockResolvedValue(undefined),
    log: (msg: string) => { logs.push(msg); },
    prompt: vi.fn().mockResolvedValue(''),
    progress: {
      update: (msg: string) => { progressUpdates.push(msg); },
      stop: vi.fn(),
    },
    logs,
    prompts,
    progressUpdates,
    ...overrides,
  };
}

// ── extractGeminiCliCredentials ────────────────────────────────────────────

describe('extractGeminiCliCredentials', () => {
  let tmpDir = '';
  let origPath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    origPath = process.env.PATH;
    const t = makeTmpDir();
    tmpDir = t.dir;
  });

  afterEach(() => {
    process.env.PATH = origPath;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when gemini binary is not found in PATH', async () => {
    process.env.PATH = '/nonexistent-abc-xyz-123';
    const { extractGeminiCliCredentials } = await import('./gemini-oauth');
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it('returns null when gemini is found but oauth2.js is absent', async () => {
    const { binDir } = makeTmpDir();
    writeGeminiBin(binDir);
    // No oauth2.js written
    process.env.PATH = `${binDir}:${origPath ?? ''}`;
    const { extractGeminiCliCredentials } = await import('./gemini-oauth');
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it('extracts clientId and clientSecret from oauth2.js when present', async () => {
    const { dir, binDir, oauth2Dir } = makeTmpDir();
    writeGeminiBin(binDir);
    const clientId = '123456789000-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com';
    const clientSecret = 'GOCSPX-abc123_XYZ-ValidSecret';
    writeOauth2Js(oauth2Dir, clientId, clientSecret);
    process.env.PATH = `${binDir}:${origPath ?? ''}`;
    const { extractGeminiCliCredentials } = await import('./gemini-oauth');
    const result = extractGeminiCliCredentials();
    expect(result).not.toBeNull();
    expect(result?.clientId).toBe(clientId);
    expect(result?.clientSecret).toBe(clientSecret);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns cached credentials on repeated calls within TTL', async () => {
    const { dir, binDir, oauth2Dir } = makeTmpDir();
    writeGeminiBin(binDir);
    const clientId = '999888777-cached.apps.googleusercontent.com';
    const clientSecret = 'GOCSPX-CachedSecret123';
    writeOauth2Js(oauth2Dir, clientId, clientSecret);
    process.env.PATH = `${binDir}:${origPath ?? ''}`;

    const { extractGeminiCliCredentials } = await import('./gemini-oauth');

    const first = extractGeminiCliCredentials();
    expect(first).not.toBeNull();

    // Remove oauth2.js — second call must still return cached result
    rmSync(join(oauth2Dir, 'oauth2.js'));

    const second = extractGeminiCliCredentials();
    expect(second).not.toBeNull();
    expect(second?.clientId).toBe(clientId);
    expect(second?.clientSecret).toBe(clientSecret);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null on cache miss after TTL expires', async () => {
    const { dir, binDir, oauth2Dir } = makeTmpDir();
    writeGeminiBin(binDir);
    const clientId = '111222333-ttl.apps.googleusercontent.com';
    const clientSecret = 'GOCSPX-TTLSecret456';
    writeOauth2Js(oauth2Dir, clientId, clientSecret);
    process.env.PATH = `${binDir}:${origPath ?? ''}`;

    const { extractGeminiCliCredentials } = await import('./gemini-oauth');

    // Warm the cache
    expect(extractGeminiCliCredentials()).not.toBeNull();

    // Remove oauth2.js so the next non-cache read returns null
    rmSync(join(oauth2Dir, 'oauth2.js'));

    // Simulate TTL expiry by rewinding Date.now by 11 minutes
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    try {
      expect(extractGeminiCliCredentials()).toBeNull();
    } finally {
      Date.now = realNow;
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── runGeminiOAuth — remote / manual flow ─────────────────────────────────

describe('runGeminiOAuth (remote = true)', () => {
  const CLIENT_ID_ENV = 'OPENCLAW_GEMINI_OAUTH_CLIENT_ID';
  const fakeClientId = 'fake-client-id-for-tests.apps.googleusercontent.com';

  let origClientId: string | undefined;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    origClientId = process.env[CLIENT_ID_ENV];
    process.env[CLIENT_ID_ENV] = fakeClientId;

    // Suppress unhandled fetch — individual tests override this
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch not mocked'));
  });

  afterEach(() => {
    if (origClientId === undefined) {
      delete process.env[CLIENT_ID_ENV];
    } else {
      process.env[CLIENT_ID_ENV] = origClientId;
    }
    fetchSpy.mockRestore();
  });

  /** Shared mock: successful token exchange + no-op userinfo + no-op project discovery */
  function mockSuccessfulTokenExchange(
    accessToken = 'acc-token',
    refreshToken = 'ref-token',
  ) {
    fetchSpy.mockImplementation(async (url: RequestInfo | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 3600,
          }),
          text: async () => '',
        } as Response;
      }
      if (u.includes('googleapis.com/oauth2/v1/userinfo')) {
        return {
          ok: true,
          json: async () => ({ email: 'user@example.com' }),
        } as Response;
      }
      if (u.includes('cloudcode-pa.googleapis.com')) {
        return {
          ok: true,
          json: async () => ({
            currentTier: { id: 'standard-tier' },
            cloudaicompanionProject: 'my-project-123',
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });
  }

  it('logs the auth URL and prompts for callback input', async () => {
    mockSuccessfulTokenExchange();
    const { runGeminiOAuth } = await import('./gemini-oauth');

    const ctx = makeCtx();
    // Dynamically capture the PKCE state from the logged auth URL so we can
    // return a correctly-matching redirect URL from the prompt mock.
    (ctx.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const urlLog = ctx.logs.find((l) => l.includes('accounts.google.com'));
      const stateMatch = urlLog?.match(/state=([^&\s]+)/);
      const state = stateMatch?.[1] ?? '';
      return `http://localhost:8085/oauth2callback?code=my-auth-code&state=${state}`;
    });

    await runGeminiOAuth(ctx);

    // Auth URL must have been logged before the prompt was shown
    expect(ctx.logs.some((l) => l.includes('accounts.google.com'))).toBe(true);
    expect(ctx.prompt).toHaveBeenCalledWith('Paste the redirect URL here: ');
  });

  it('accepts a full redirect URL as callback input', async () => {
    mockSuccessfulTokenExchange();
    const { runGeminiOAuth } = await import('./gemini-oauth');

    const ctx = makeCtx();
    (ctx.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // Capture the verifier from the auth URL logged in ctx.logs
      const urlLog = ctx.logs.find((l) => l.includes('accounts.google.com'));
      const stateMatch = urlLog?.match(/state=([^&\s]+)/);
      const state = stateMatch?.[1] ?? 'unknown-state';
      return `http://localhost:8085/oauth2callback?code=authcode123&state=${state}`;
    });

    const creds = await runGeminiOAuth(ctx);
    expect(creds.access).toBe('acc-token');
    expect(creds.refresh).toBe('ref-token');
    expect(creds.email).toBe('user@example.com');
    expect(creds.projectId).toBe('my-project-123');
  });

  it('accepts a raw authorization code (no URL) as callback input', async () => {
    mockSuccessfulTokenExchange('raw-acc', 'raw-ref');
    const { runGeminiOAuth } = await import('./gemini-oauth');

    const ctx = makeCtx();
    // When input is not a URL, parseCallbackInput treats it as a raw code
    // and substitutes the expected state — no state mismatch check fires
    (ctx.prompt as ReturnType<typeof vi.fn>).mockResolvedValue('raw-code-string');

    const creds = await runGeminiOAuth(ctx);
    expect(creds.access).toBe('raw-acc');
  });

  it('throws when callback input is empty', async () => {
    const { runGeminiOAuth } = await import('./gemini-oauth');

    const ctx = makeCtx();
    (ctx.prompt as ReturnType<typeof vi.fn>).mockResolvedValue('   ');

    await expect(runGeminiOAuth(ctx)).rejects.toThrow('No input provided');
  });

  it('throws when redirect URL is missing the code parameter', async () => {
    // In the remote/manual flow, parseCallbackInput handles the pasted URL.
    // It does not propagate the OAuth `error` query param — it simply reports
    // that `code` is missing when the URL contains no authorization code.
    const { runGeminiOAuth } = await import('./gemini-oauth');

    const ctx = makeCtx();
    (ctx.prompt as ReturnType<typeof vi.fn>).mockResolvedValue(
      'http://localhost:8085/oauth2callback?error=access_denied',
    );

    await expect(runGeminiOAuth(ctx)).rejects.toThrow("Missing 'code' parameter in URL");
  });

  it('throws when token exchange fails with a non-OK response', async () => {
    fetchSpy.mockImplementation(async (url: RequestInfo | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('oauth2.googleapis.com/token')) {
        return {
          ok: false,
          text: async () => 'invalid_grant',
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });

    const { runGeminiOAuth } = await import('./gemini-oauth');
    const ctx = makeCtx();
    (ctx.prompt as ReturnType<typeof vi.fn>).mockResolvedValue('some-raw-code');

    await expect(runGeminiOAuth(ctx)).rejects.toThrow('Token exchange failed');
  });

  it('throws when token exchange response is missing access_token', async () => {
    fetchSpy.mockImplementation(async (url: RequestInfo | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({ refresh_token: 'ref' }), // no access_token
          text: async () => '',
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });

    const { runGeminiOAuth } = await import('./gemini-oauth');
    const ctx = makeCtx();
    (ctx.prompt as ReturnType<typeof vi.fn>).mockResolvedValue('raw-code');

    await expect(runGeminiOAuth(ctx)).rejects.toThrow(/missing access_token/);
  });

  it('throws when token exchange response is missing refresh_token', async () => {
    fetchSpy.mockImplementation(async (url: RequestInfo | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'acc' }), // no refresh_token
          text: async () => '',
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });

    const { runGeminiOAuth } = await import('./gemini-oauth');
    const ctx = makeCtx();
    (ctx.prompt as ReturnType<typeof vi.fn>).mockResolvedValue('raw-code');

    await expect(runGeminiOAuth(ctx)).rejects.toThrow('No refresh token received');
  });
});

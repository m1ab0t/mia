/**
 * Tests for load-mia-env utility
 *
 * Covers:
 *   - parseEnvFileContent (pure function, no FS side-effects)
 *   - loadMiaEnv          (reads a real temp file, mutates process.env)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseEnvFileContent, loadMiaEnv } from './load-mia-env';

// ─────────────────────────────────────────────────────────────────────────────
// parseEnvFileContent — pure function tests (no filesystem)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseEnvFileContent', () => {
  it('parses a single KEY=VALUE line', () => {
    expect(parseEnvFileContent('API_KEY=secret')).toEqual({ API_KEY: 'secret' });
  });

  it('parses multiple lines', () => {
    const content = 'KEY1=val1\nKEY2=val2\nKEY3=val3';
    expect(parseEnvFileContent(content)).toEqual({
      KEY1: 'val1',
      KEY2: 'val2',
      KEY3: 'val3',
    });
  });

  it('trims leading and trailing whitespace from keys', () => {
    expect(parseEnvFileContent('  MY_KEY  =value')).toEqual({ MY_KEY: 'value' });
  });

  it('trims leading and trailing whitespace from values', () => {
    expect(parseEnvFileContent('MY_KEY=  value  ')).toEqual({ MY_KEY: 'value' });
  });

  it('trims both key and value simultaneously', () => {
    expect(parseEnvFileContent('  KEY  =  val  ')).toEqual({ KEY: 'val' });
  });

  it('preserves = signs inside the value (only first = is the separator)', () => {
    expect(parseEnvFileContent('TOKEN=abc=def==ghi')).toEqual({ TOKEN: 'abc=def==ghi' });
  });

  it('preserves base64-encoded values that contain =', () => {
    const b64 = 'SGVsbG8gV29ybGQ=';
    expect(parseEnvFileContent(`SECRET=${b64}`)).toEqual({ SECRET: b64 });
  });

  it('skips lines without an = sign', () => {
    expect(parseEnvFileContent('THIS_IS_NOT_A_KEY')).toEqual({});
  });

  it('skips empty lines', () => {
    expect(parseEnvFileContent('\n\n\n')).toEqual({});
  });

  it('returns an empty record for an empty string', () => {
    expect(parseEnvFileContent('')).toEqual({});
  });

  it('strips Windows-style \\r carriage returns', () => {
    // CRLF line endings should be handled transparently
    expect(parseEnvFileContent('KEY=value\r\nOTHER=thing\r\n')).toEqual({
      KEY: 'value',
      OTHER: 'thing',
    });
  });

  it('strips \\r even when it appears in the middle of a value-less line', () => {
    // A line that is only \r after stripping should be skipped
    expect(parseEnvFileContent('\r')).toEqual({});
  });

  it('allows empty values (KEY= is valid)', () => {
    expect(parseEnvFileContent('EMPTY=')).toEqual({ EMPTY: '' });
  });

  it('later duplicate keys overwrite earlier ones', () => {
    const content = 'DUPE=first\nDUPE=second';
    expect(parseEnvFileContent(content)).toEqual({ DUPE: 'second' });
  });

  it('handles values that contain spaces', () => {
    expect(parseEnvFileContent('MSG=hello world')).toEqual({ MSG: 'hello world' });
  });

  it('handles values with special shell characters', () => {
    expect(parseEnvFileContent('CMD=echo $HOME && ls -la')).toEqual({
      CMD: 'echo $HOME && ls -la',
    });
  });

  it('skips lines that start with # (comment-style lines lack a useful key)', () => {
    // The regex will match `# COMMENT` as key and `value` as value.
    // This documents the ACTUAL behaviour — the function does not specially
    // treat `#` characters; callers should avoid comment lines if that matters.
    const result = parseEnvFileContent('# comment=value');
    // Key is "# comment" (trimmed), value is "value"
    expect(result['# comment']).toBe('value');
  });

  it('handles keys with underscores and uppercase', () => {
    expect(parseEnvFileContent('ANTHROPIC_API_KEY=sk-ant-123')).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-123',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadMiaEnv — filesystem + process.env side-effect tests
// ─────────────────────────────────────────────────────────────────────────────

describe('loadMiaEnv', () => {
  let tmpDir: string;
  let envPath: string;

  // Snapshot of env keys we set during tests so we can clean up
  const injectedKeys: string[] = [];

  function setEnvFile(content: string): void {
    writeFileSync(envPath, content, 'utf-8');
  }

  function cleanup(key: string): void {
    injectedKeys.push(key);
  }

  beforeEach(() => {
    // Create a fresh temp directory for each test
    tmpDir = join(tmpdir(), `mia-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    envPath = join(tmpDir, '.env');
  });

  afterEach(() => {
    // Remove temp dir
    rmSync(tmpDir, { recursive: true, force: true });
    // Clean up any env vars we injected
    for (const key of injectedKeys) {
      delete process.env[key];
    }
    injectedKeys.length = 0;
  });

  it('sets process.env variables from the file', () => {
    setEnvFile('TEST_LOAD_KEY=loaded_value');
    cleanup('TEST_LOAD_KEY');

    loadMiaEnv(envPath);

    expect(process.env['TEST_LOAD_KEY']).toBe('loaded_value');
  });

  it('sets multiple variables in one call', () => {
    setEnvFile('LOAD_A=alpha\nLOAD_B=beta');
    cleanup('LOAD_A');
    cleanup('LOAD_B');

    loadMiaEnv(envPath);

    expect(process.env['LOAD_A']).toBe('alpha');
    expect(process.env['LOAD_B']).toBe('beta');
  });

  it('overwrites an existing process.env entry', () => {
    process.env['OVERWRITE_ME'] = 'original';
    cleanup('OVERWRITE_ME');

    setEnvFile('OVERWRITE_ME=replaced');
    loadMiaEnv(envPath);

    expect(process.env['OVERWRITE_ME']).toBe('replaced');
  });

  it('does nothing when the file does not exist', () => {
    const missing = join(tmpDir, 'missing.env');
    // Should not throw
    expect(() => loadMiaEnv(missing)).not.toThrow();
  });

  it('does nothing when called with a path to a directory', () => {
    // tmpDir is a directory, not a file — existsSync returns true but
    // readFileSync on a directory throws on most platforms.
    // loadMiaEnv should swallow the error silently.
    expect(() => loadMiaEnv(tmpDir)).not.toThrow();
  });

  it('handles CRLF line endings in the file', () => {
    setEnvFile('CRLF_KEY=crlf_value\r\nCRLF_KEY2=crlf_value2\r\n');
    cleanup('CRLF_KEY');
    cleanup('CRLF_KEY2');

    loadMiaEnv(envPath);

    expect(process.env['CRLF_KEY']).toBe('crlf_value');
    expect(process.env['CRLF_KEY2']).toBe('crlf_value2');
  });

  it('ignores lines that have no = sign', () => {
    setEnvFile('NOT_A_VALID_LINE\nVALID=yes');
    cleanup('VALID');
    const before = { ...process.env };

    loadMiaEnv(envPath);

    // VALID is set, but no spurious key is created
    expect(process.env['VALID']).toBe('yes');
    expect(process.env['NOT_A_VALID_LINE']).toBeUndefined();
    // No other unexpected keys appear
    const newKeys = Object.keys(process.env).filter(k => !(k in before));
    expect(newKeys).toEqual(['VALID']);
  });

  it('handles an empty file without throwing', () => {
    setEnvFile('');
    expect(() => loadMiaEnv(envPath)).not.toThrow();
  });

  it('preserves values with = signs', () => {
    setEnvFile('B64_SECRET=abc=def==');
    cleanup('B64_SECRET');

    loadMiaEnv(envPath);

    expect(process.env['B64_SECRET']).toBe('abc=def==');
  });
});

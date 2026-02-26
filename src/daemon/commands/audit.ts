/**
 * audit — `mia audit [options]`
 *
 * Security-focused project audit that combines three data sources into a
 * single AI-synthesized report:
 *
 *   1. Package vulnerabilities  — npm/pnpm/yarn/pip audit output
 *   2. Secret / credential scan — pattern matching for hardcoded secrets
 *   3. Outdated dependencies    — packages with known-insecure old versions
 *
 * The raw data is fed to the active plugin which produces a prioritised,
 * actionable security report with severity ratings and concrete fix commands.
 *
 * Usage:
 *   mia audit                          # full audit of current directory
 *   mia audit --dir ~/project          # audit a specific project
 *   mia audit --no-secrets             # skip secret scanning
 *   mia audit --no-deps                # skip package vulnerability scan
 *   mia audit --dry-run                # show assembled prompt without dispatching
 *   mia audit --raw                    # plain text output for piping/logging
 *   mia audit --no-context             # skip workspace context (faster)
 *   mia audit --json                   # output machine-readable JSON
 *
 * Exit codes:
 *   0  — no critical/high vulnerabilities found (or --dry-run)
 *   1  — critical or high severity issues found
 *   2  — audit could not be run (no package manager found, etc.)
 */

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { randomBytes } from 'crypto';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';
import { loadActivePlugin, buildCommandContext } from './plugin-loader.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'pip' | 'pip3' | 'none';

export interface AuditArgs {
  cwd: string;
  noSecrets: boolean;
  noDeps: boolean;
  dryRun: boolean;
  raw: boolean;
  noContext: boolean;
  json: boolean;
}

export interface VulnSummary {
  total: number;
  critical: number;
  high: number;
  moderate: number;
  low: number;
  info: number;
}

export interface SecretMatch {
  file: string;
  line: number;
  pattern: string;
  preview: string;
}

export interface AuditData {
  packageManager: PackageManager;
  vulnOutput: string;
  vulnSummary: VulnSummary;
  secretMatches: SecretMatch[];
  outdatedOutput: string;
  projectName: string | null;
  projectVersion: string | null;
  hasLockfile: boolean;
}

export interface AuditResult {
  data: AuditData;
  aiReport: string;
  hasHighSeverity: boolean;
}

// ── Secret patterns ───────────────────────────────────────────────────────────

/**
 * Regex patterns for common credential/secret leaks.
 *
 * Each entry has a human-readable name and a pattern that matches the secret
 * assignment (not just the word "password" in prose).
 *
 * Deliberately conservative — we prefer false negatives over false positives.
 * All patterns require a direct assignment context (=, :, ", ') to avoid
 * flagging comments and documentation.
 */
export const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'AWS Access Key',
    pattern: /(?:AKIA|ASIA|AROA)[0-9A-Z]{16}/,
  },
  {
    name: 'AWS Secret Key',
    pattern: /(?:aws[_\-.]?secret[_\-.]?(?:access[_\-.]?)?key)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/i,
  },
  {
    name: 'Generic API key assignment',
    pattern: /(?:api[_\-.]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9\-_]{20,}['"]/i,
  },
  {
    name: 'Generic secret assignment',
    pattern: /(?:secret[_\-.]?key|jwt[_\-.]?secret|app[_\-.]?secret)\s*[:=]\s*['"][A-Za-z0-9\-_/+=]{16,}['"]/i,
  },
  {
    name: 'Hardcoded password',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{6,}['"]/i,
  },
  {
    name: 'Private key block',
    pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
  },
  {
    name: 'GitHub personal access token',
    pattern: /ghp_[A-Za-z0-9]{36}|github[_\-.]?(?:token|pat)\s*[:=]\s*['"][A-Za-z0-9]{20,}['"]/i,
  },
  {
    name: 'Slack token',
    pattern: /xox[baprs]-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{20,}/,
  },
  {
    name: 'Stripe key',
    pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{24,}/,
  },
  {
    name: 'Hardcoded database URL with credentials',
    pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:@/\s]+:[^@/\s]{6,}@/i,
  },
];

/** File extensions eligible for secret scanning. */
const SCANNABLE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.cs',
  '.env', '.env.local', '.env.development', '.env.production',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bash', '.zsh',
  '.pem', '.key', '.cert', '.crt',  // certificate / key files
]);

/** Directories always excluded from secret scanning. */
const SCAN_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next',
  '.cache', '.turbo', '__pycache__', '.mia', 'vendor',
]);

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "audit") into structured AuditArgs.
 * Exported for testing.
 */
export function parseAuditArgs(argv: string[], cwd = process.cwd()): AuditArgs {
  let workingDir = cwd;
  let noSecrets = false;
  let noDeps = false;
  let dryRun = false;
  let raw = false;
  let noContext = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--dir' || arg === '--cwd') && argv[i + 1]) {
      workingDir = argv[++i];
    } else if (arg === '--no-secrets') {
      noSecrets = true;
    } else if (arg === '--no-deps') {
      noDeps = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--raw') {
      raw = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (arg === '--json') {
      json = true;
    }
  }

  return { cwd: workingDir, noSecrets, noDeps, dryRun, raw, noContext, json };
}

// ── Package manager detection ─────────────────────────────────────────────────

/**
 * Detect the package manager for the project at `cwd`.
 *
 * Checks for lockfiles and config files in order of specificity.
 * Returns `'none'` when no recognised package manager is found.
 *
 * Exported for testing.
 */
export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'package-lock.json')) || existsSync(join(cwd, 'package.json'))) return 'npm';
  if (existsSync(join(cwd, 'requirements.txt')) || existsSync(join(cwd, 'Pipfile')) || existsSync(join(cwd, 'pyproject.toml'))) {
    // Prefer pip3 if available, otherwise pip
    try {
      execFileSync('pip3', ['--version'], { stdio: 'pipe', timeout: 3_000 });
      return 'pip3';
    } catch {
      return 'pip';
    }
  }
  return 'none';
}

// ── Package vulnerability scanning ───────────────────────────────────────────

/**
 * Run the package manager's audit command and return its output.
 *
 * Returns an empty string if the command fails or is unavailable.
 * Never throws — audit failures are treated as "no data" not fatal errors.
 *
 * Exported for testing.
 */
export function runPackageAudit(pm: PackageManager, cwd: string): string {
  if (pm === 'none') return '';

  const cmds: Record<PackageManager, string[]> = {
    npm:  ['npm', ['audit', '--json']],
    pnpm: ['pnpm', ['audit', '--json']],
    yarn: ['yarn', ['audit', '--json']],
    pip:  ['pip',  ['check']],
    pip3: ['pip3', ['check']],
    none: [],
  } as unknown as Record<PackageManager, string[]>;

  const [cmd, args] = cmds[pm] as [string, string[]];
  if (!cmd) return '';

  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    // npm/pnpm audit exits with code 1 when vulnerabilities are found —
    // that is not an error, the output is still valid JSON on stdout.
    if (err && typeof err === 'object' && 'stdout' in err) {
      const stdout = (err as { stdout: string }).stdout;
      if (typeof stdout === 'string' && stdout.trim()) return stdout;
    }
    return '';
  }
}

/**
 * Run `npm outdated --json` (or equivalent) to get outdated dependency info.
 *
 * Returns empty string if unavailable or no outdated packages.
 * Exported for testing.
 */
export function runOutdatedCheck(pm: PackageManager, cwd: string): string {
  if (pm !== 'npm' && pm !== 'pnpm') return '';

  const args = pm === 'npm'
    ? ['npm', 'outdated', '--json']
    : ['pnpm', 'outdated', '--format', 'json'];

  try {
    return execFileSync(args[0], args.slice(1), {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    // npm outdated exits with 1 when outdated packages exist — stdout is valid
    if (err && typeof err === 'object' && 'stdout' in err) {
      const stdout = (err as { stdout: string }).stdout;
      if (typeof stdout === 'string' && stdout.trim()) return stdout;
    }
    return '';
  }
}

// ── Vulnerability summary parsing ─────────────────────────────────────────────

/**
 * Parse the npm/pnpm JSON audit output into a `VulnSummary`.
 *
 * Handles both npm v6 format (vulnerabilities object) and npm v7+ format
 * (metadata.vulnerabilities object).  Returns all-zero summary on any parse
 * error.
 *
 * Exported for testing.
 */
export function parseVulnSummary(auditOutput: string): VulnSummary {
  const empty: VulnSummary = { total: 0, critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  if (!auditOutput.trim()) return empty;

  try {
    const parsed = JSON.parse(auditOutput) as Record<string, unknown>;

    // npm v7+ format: { metadata: { vulnerabilities: { critical, high, ... } } }
    const meta = parsed.metadata as Record<string, unknown> | undefined;
    if (meta?.vulnerabilities && typeof meta.vulnerabilities === 'object') {
      const v = meta.vulnerabilities as Record<string, number>;
      const summary: VulnSummary = {
        critical: v.critical ?? 0,
        high: v.high ?? 0,
        moderate: v.moderate ?? 0,
        low: v.low ?? 0,
        info: v.info ?? 0,
        total: 0,
      };
      summary.total = summary.critical + summary.high + summary.moderate + summary.low + summary.info;
      return summary;
    }

    // npm v6 format: { vulnerabilities: { <pkg>: { severity: "...", ... } } }
    if (parsed.vulnerabilities && typeof parsed.vulnerabilities === 'object') {
      const vulns = Object.values(parsed.vulnerabilities as Record<string, { severity?: string }>);
      const summary: VulnSummary = { ...empty };
      for (const v of vulns) {
        const sev = (v.severity ?? '').toLowerCase();
        if (sev === 'critical') summary.critical++;
        else if (sev === 'high') summary.high++;
        else if (sev === 'moderate') summary.moderate++;
        else if (sev === 'low') summary.low++;
        else summary.info++;
      }
      summary.total = summary.critical + summary.high + summary.moderate + summary.low + summary.info;
      return summary;
    }

    // pnpm format: { vulnerabilities: { critical: n, high: n, ... } }
    if (parsed.vulnerabilities && typeof parsed.vulnerabilities === 'object') {
      const v = parsed.vulnerabilities as Record<string, number>;
      if (typeof v.critical === 'number') {
        const summary: VulnSummary = {
          critical: v.critical ?? 0,
          high: v.high ?? 0,
          moderate: v.moderate ?? 0,
          low: v.low ?? 0,
          info: v.info ?? 0,
          total: 0,
        };
        summary.total = summary.critical + summary.high + summary.moderate + summary.low + summary.info;
        return summary;
      }
    }
  } catch {
    // Non-JSON output (pip check, yarn, errors) — fall through to empty
  }

  return empty;
}

// ── Secret scanning ───────────────────────────────────────────────────────────

/**
 * Scan source files under `dir` for hardcoded secrets using `SECRET_PATTERNS`.
 *
 * Walks the directory tree up to `maxDepth`, skipping `SCAN_EXCLUDE_DIRS`.
 * Returns at most `maxMatches` findings to avoid overwhelming the AI prompt.
 *
 * Exported for testing.
 */
export function scanForSecrets(
  dir: string,
  maxDepth = 4,
  maxMatches = 20,
): SecretMatch[] {
  const matches: SecretMatch[] = [];

  function walk(current: string, depth: number): void {
    if (depth > maxDepth || matches.length >= maxMatches) return;

    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= maxMatches) return;
      if (entry.startsWith('.') && !entry.startsWith('.env')) continue;

      const fullPath = join(current, entry);

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (SCAN_EXCLUDE_DIRS.has(entry)) continue;
        walk(fullPath, depth + 1);
        continue;
      }

      const ext = extname(entry);
      // Also allow dotfiles that start with .env
      const isEnvFile = entry.startsWith('.env');
      if (!SCANNABLE_EXTS.has(ext) && !isEnvFile) continue;

      let content: string;
      try {
        content = readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      for (let lineIdx = 0; lineIdx < lines.length && matches.length < maxMatches; lineIdx++) {
        const line = lines[lineIdx];
        // Skip comments
        const trimmed = line.trim();
        if (
          trimmed.startsWith('#') ||
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*')
        ) {
          continue;
        }

        for (const { name, pattern } of SECRET_PATTERNS) {
          if (pattern.test(line)) {
            const preview = line.trim().slice(0, 120);
            matches.push({
              file: relative(dir, fullPath),
              line: lineIdx + 1,
              pattern: name,
              preview,
            });
            break; // one match per line
          }
        }
      }
    }
  }

  walk(dir, 0);
  return matches;
}

// ── Project metadata ──────────────────────────────────────────────────────────

/**
 * Read `name` and `version` from `package.json` if present.
 * Returns nulls when unavailable.
 */
export function readProjectMeta(cwd: string): { name: string | null; version: string | null } {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return { name: null, version: null };
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string };
    return {
      name: pkg.name ?? null,
      version: pkg.version ?? null,
    };
  } catch {
    return { name: null, version: null };
  }
}

// ── Data collection ───────────────────────────────────────────────────────────

/**
 * Collect all audit data for the project at `cwd`.
 *
 * This is the single entrypoint that orchestrates all three data sources.
 * It never throws — partial data is always better than no data.
 *
 * Exported for testing.
 */
export async function collectAuditData(args: AuditArgs): Promise<AuditData> {
  const { cwd, noSecrets, noDeps } = args;

  const pm = detectPackageManager(cwd);
  const { name: projectName, version: projectVersion } = readProjectMeta(cwd);
  const hasLockfile =
    existsSync(join(cwd, 'package-lock.json')) ||
    existsSync(join(cwd, 'pnpm-lock.yaml')) ||
    existsSync(join(cwd, 'yarn.lock'));

  let vulnOutput = '';
  let outdatedOutput = '';

  if (!noDeps && pm !== 'none') {
    vulnOutput = runPackageAudit(pm, cwd);
    outdatedOutput = runOutdatedCheck(pm, cwd);
  }

  const vulnSummary = parseVulnSummary(vulnOutput);
  const secretMatches = noSecrets ? [] : scanForSecrets(cwd);

  return {
    packageManager: pm,
    vulnOutput,
    vulnSummary,
    secretMatches,
    outdatedOutput,
    projectName,
    projectVersion,
    hasLockfile,
  };
}

// ── Prompt construction ───────────────────────────────────────────────────────

/**
 * Build the AI dispatch prompt from collected audit data.
 *
 * Exported for testing.
 */
export function buildAuditPrompt(data: AuditData): string {
  const sections: string[] = [];

  const projectLabel = data.projectName
    ? `${data.projectName}${data.projectVersion ? ` v${data.projectVersion}` : ''}`
    : 'this project';

  sections.push(
    `You are a security engineer reviewing the audit results for ${projectLabel}.`,
    `Your task is to produce a clear, prioritised security report with actionable remediation steps.`,
    ``,
    `OUTPUT FORMAT (STRICT):`,
    `1. Start with a one-line executive summary: "Security status: [CRITICAL|HIGH|MEDIUM|LOW|CLEAN] — brief description"`,
    `2. List all critical and high severity findings first, each as:`,
    `   [SEVERITY] Finding title`,
    `   Details: ...`,
    `   Fix: exact command or code change to remediate`,
    `3. Then medium/low findings in the same format (condensed is fine).`,
    `4. End with "RECOMMENDED ACTIONS" — 3-5 bullet points in priority order.`,
    ``,
    `CONSTRAINTS:`,
    `- Be specific: include exact package names, versions, and CVE IDs where present in the data.`,
    `- For secret leaks: clearly state the file and line, and explain why it is dangerous.`,
    `- For outdated packages: only flag ones where an update resolves a known vulnerability.`,
    `- Do NOT invent CVEs or vulnerabilities not present in the provided data.`,
    `- If no issues are found, output: "Security status: CLEAN — no vulnerabilities detected"`,
    ``,
  );

  // ── Package vulnerability data ───────────────────────────────────────────
  if (data.vulnOutput) {
    const { vulnSummary: s } = data;
    if (s.total > 0) {
      sections.push(
        `=== PACKAGE VULNERABILITY SCAN (${data.packageManager}) ===`,
        `Summary: ${s.total} total — ${s.critical} critical, ${s.high} high, ${s.moderate} moderate, ${s.low} low, ${s.info} info`,
        ``,
        `Raw audit output (JSON):`,
        // Truncate to keep prompt manageable
        data.vulnOutput.slice(0, 8_000),
        ``,
      );
    } else {
      sections.push(
        `=== PACKAGE VULNERABILITY SCAN (${data.packageManager}) ===`,
        `Result: No known vulnerabilities found in installed packages.`,
        ``,
      );
    }
  } else if (data.packageManager === 'none') {
    sections.push(
      `=== PACKAGE VULNERABILITY SCAN ===`,
      `No recognised package manager found (not npm/pnpm/yarn/pip).`,
      ``,
    );
  } else {
    sections.push(
      `=== PACKAGE VULNERABILITY SCAN (${data.packageManager}) ===`,
      `Audit command did not produce output (may indicate network unavailability or no lockfile).`,
      data.hasLockfile ? '' : 'Note: no lockfile found — package versions are not pinned.',
      ``,
    );
  }

  // ── Outdated packages ────────────────────────────────────────────────────
  if (data.outdatedOutput && data.outdatedOutput.trim()) {
    sections.push(
      `=== OUTDATED PACKAGES ===`,
      data.outdatedOutput.slice(0, 4_000),
      ``,
    );
  }

  // ── Secret matches ───────────────────────────────────────────────────────
  if (data.secretMatches.length > 0) {
    sections.push(`=== POTENTIAL SECRET / CREDENTIAL LEAKS ===`);
    sections.push(`Found ${data.secretMatches.length} potential secret(s) in source files:`);
    sections.push('');
    for (const m of data.secretMatches) {
      sections.push(`  File: ${m.file}:${m.line}`);
      sections.push(`  Pattern: ${m.pattern}`);
      sections.push(`  Preview: ${m.preview}`);
      sections.push('');
    }
  } else {
    sections.push(
      `=== SECRET / CREDENTIAL SCAN ===`,
      `No hardcoded secrets or credentials detected.`,
      ``,
    );
  }

  sections.push(`Produce the security report now.`);

  return sections.join('\n');
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** Render the pre-dispatch audit header. */
export function renderAuditHeader(data: AuditData, args: AuditArgs): void {
  const { cwd, noSecrets, noDeps } = args;
  const relDir = relative(process.cwd(), cwd) || cwd;

  console.log('');
  console.log(`  ${bold}audit${x}  ${dim}${relDir || '.'}${x}`);
  console.log(`  ${DASH}`);

  if (data.projectName) {
    const nameStr = data.projectVersion
      ? `${cyan}${data.projectName}${x} ${dim}v${data.projectVersion}${x}`
      : `${cyan}${data.projectName}${x}`;
    console.log(`  ${gray}project${x}   ${nameStr}`);
  }

  console.log(`  ${gray}manager${x}   ${dim}${data.packageManager}${x}`);

  if (!noDeps) {
    const { vulnSummary: s } = data;
    if (s.total > 0) {
      const parts: string[] = [];
      if (s.critical > 0) parts.push(`${red}${s.critical} critical${x}`);
      if (s.high > 0) parts.push(`${red}${s.high} high${x}`);
      if (s.moderate > 0) parts.push(`${yellow}${s.moderate} moderate${x}`);
      if (s.low > 0) parts.push(`${dim}${s.low} low${x}`);
      console.log(`  ${gray}vulns${x}     ${parts.join(`  ${dim}·${x}  `)}`);
    } else {
      console.log(`  ${gray}vulns${x}     ${green}none found${x}`);
    }
  }

  if (!noSecrets) {
    const n = data.secretMatches.length;
    if (n > 0) {
      console.log(`  ${gray}secrets${x}   ${red}${n} potential leak${n !== 1 ? 's' : ''} detected${x}`);
    } else {
      console.log(`  ${gray}secrets${x}   ${green}none found${x}`);
    }
  }

  console.log(`  ${DASH}`);
  console.log('');
}

/** Render a compact JSON result for --json mode. */
export function renderAuditJson(data: AuditData, aiReport: string): void {
  console.log(JSON.stringify({
    projectName: data.projectName,
    projectVersion: data.projectVersion,
    packageManager: data.packageManager,
    vulnerabilities: data.vulnSummary,
    secretMatches: data.secretMatches,
    hasLockfile: data.hasLockfile,
    aiReport,
  }, null, 2));
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function handleAuditCommand(argv: string[]): Promise<void> {
  const args = parseAuditArgs(argv);
  const { cwd, dryRun, raw, noContext, json } = args;

  // ── Validate working directory ─────────────────────────────────────────────
  if (!existsSync(cwd)) {
    if (!raw) {
      console.error(`  ${red}error${x}  directory not found: ${dim}${cwd}${x}`);
    } else {
      process.stderr.write(`mia audit: error: directory not found: ${cwd}\n`);
    }
    process.exit(2);
  }

  // ── Collect audit data ─────────────────────────────────────────────────────
  if (!raw && !json) {
    process.stdout.write(`  ${dim}collecting audit data…${x}\r`);
  }

  const data = await collectAuditData(args);

  if (!raw && !json) {
    process.stdout.write('  \r');
  }

  // ── Build prompt ───────────────────────────────────────────────────────────
  const prompt = buildAuditPrompt(data);

  // ── Dry-run mode ───────────────────────────────────────────────────────────
  if (dryRun) {
    if (!raw) {
      renderAuditHeader(data, args);
      console.log(`  ${dim}── prompt preview ──${x}`);
      const lines = prompt.split('\n');
      const preview = lines.slice(0, 15).map(l => `  ${dim}${l}${x}`).join('\n');
      console.log(preview);
      if (lines.length > 15) {
        console.log(`  ${dim}… (${lines.length - 15} more lines)${x}`);
      }
      console.log('');
    } else {
      console.log(prompt);
    }
    return;
  }

  // ── Header (non-raw, non-json) ─────────────────────────────────────────────
  if (!raw && !json) {
    renderAuditHeader(data, args);
  }

  // ── AI dispatch ────────────────────────────────────────────────────────────
  const { plugin } = await loadActivePlugin();
  const conversationId = `audit-${randomBytes(4).toString('hex')}`;
  const context = await buildCommandContext(prompt, conversationId, cwd, noContext);

  let fullOutput = '';
  let failed = false;

  try {
    const result = await plugin.dispatch(
      prompt,
      context,
      {
        conversationId,
        workingDirectory: cwd,
      },
      {
        onToken: (token: string) => {
          fullOutput += token;
          if (!json) {
            process.stdout.write(token);
          }
        },
        onToolCall: (_toolName: string) => { /* audit is read-only */ },
        onToolResult: (_name: string, _result: string) => { /* no-op */ },
        onDone: (_finalOutput: string) => { /* collected via onToken */ },
        onError: (err: Error) => {
          failed = true;
          if (!raw && !json) {
            console.error(`\n  ${red}error${x}  ${err.message}`);
          } else {
            process.stderr.write(`mia audit: error: ${err.message}\n`);
          }
        },
      },
    );

    if (!fullOutput && result.output) {
      fullOutput = result.output;
      if (!json) {
        process.stdout.write(result.output);
      }
    }

    if (fullOutput && !fullOutput.endsWith('\n') && !json) {
      process.stdout.write('\n');
    }
  } catch (err: unknown) {
    failed = true;
    const msg = err instanceof Error ? err.message : String(err);
    if (!raw && !json) {
      console.error(`\n  ${red}dispatch error${x}  ${msg}`);
    } else {
      process.stderr.write(`mia audit: dispatch error: ${msg}\n`);
    }
  }

  try { await plugin.shutdown(); } catch { /* ignore */ }

  if (failed) process.exit(1);

  // ── JSON output mode ───────────────────────────────────────────────────────
  if (json) {
    renderAuditJson(data, fullOutput);
  }

  // ── Exit code based on severity ────────────────────────────────────────────
  const hasCriticalOrHigh =
    data.vulnSummary.critical > 0 ||
    data.vulnSummary.high > 0 ||
    data.secretMatches.length > 0;

  if (hasCriticalOrHigh) {
    process.exit(1);
  }
}

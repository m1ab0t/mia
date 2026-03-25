/**
 * PostDispatchVerifier — Lightweight post-dispatch quality checks.
 *
 * Runs heuristic checks after a plugin dispatch completes.
 * No LLM calls by default — semantic check is opt-in.
 */

import type { PluginContext, PluginDispatchResult } from './types';
import { getErrorMessage } from '../utils/error-message';
import { logger } from '../utils/logger';

export interface VerificationCheck {
  name: string;
  passed: boolean;
  details?: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
  summary: string;
}

export interface VerifierOptions {
  enabled?: boolean;
  semanticCheck?: boolean;   // Opt-in: requires an LLM call
  retryOnFailure?: boolean;  // Retry the dispatch once if checks fail
}

/**
 * Patterns indicating the plugin output contains a genuine runtime error.
 *
 * Deliberately specific to avoid false-positives on code that mentions error
 * concepts (e.g. tutorial text saying "handle Error: try-catch").
 * Patterns match process-level / OS-level errors only.
 */
const ERROR_PATTERNS = [
  /\bEACCES\b/,              // Permission denied (OS)
  /\bENOENT\b/,              // No such file or directory (OS)
  /\bpanic:/i,               // Go / Rust panics
  /\bSegmentation fault\b/i, // Segfault
  /\bCommand failed with exit code\b/i, // Shell command failures
  /\bfatal error:/i,         // Compiler fatal errors
];

export class PostDispatchVerifier {
  private opts: VerifierOptions;

  constructor(opts: VerifierOptions = {}) {
    this.opts = {
      enabled: true,
      semanticCheck: false,
      retryOnFailure: false,
      ...opts,
    };
  }

  /**
   * Verify the quality of a plugin dispatch result.
   *
   * @param originalPrompt - The user prompt that produced this result
   * @param result         - The dispatch result to verify
   * @param context        - The plugin context used for the dispatch
   * @param plugin         - Optional: the plugin instance, used for retryOnFailure
   * @param retryDispatch  - Optional: callback to re-dispatch the prompt, used for retryOnFailure
   */
  async verify(
    originalPrompt: string,
    result: PluginDispatchResult,
    _context: PluginContext,
    retryDispatch?: () => Promise<PluginDispatchResult>,
  ): Promise<VerificationResult> {
    if (!this.opts.enabled) {
      return {
        passed: true,
        checks: [],
        summary: 'Verification disabled',
      };
    }

    const verificationResult = await this._runChecks(originalPrompt, result);

    // Retry once if enabled, checks failed, and a retry callback was provided
    if (!verificationResult.passed && this.opts.retryOnFailure && retryDispatch) {
      logger.warn(`[Verifier] Checks failed (${verificationResult.summary}), retrying dispatch once…`);
      try {
        const retryResult = await retryDispatch();
        const retryVerification = await this._runChecks(originalPrompt, retryResult);
        return {
          ...retryVerification,
          summary: `(retry) ${retryVerification.summary}`,
        };
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        logger.warn(`[Verifier] Retry dispatch failed: ${msg}`);
      }
    }

    return verificationResult;
  }

  private async _runChecks(
    originalPrompt: string,
    result: PluginDispatchResult,
  ): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];

    // Check 1: Non-empty output
    const nonEmpty = result.output.trim().length > 0;
    checks.push({
      name: 'non-empty-output',
      passed: nonEmpty,
      details: nonEmpty ? undefined : 'Plugin produced no output',
    });

    // Check 2: No OS/runtime error signals in output
    const hasErrorSignal = ERROR_PATTERNS.some(pattern => pattern.test(result.output));
    checks.push({
      name: 'no-error-signals',
      passed: !hasErrorSignal,
      details: hasErrorSignal
        ? 'Output contains OS/runtime error patterns that may indicate failure'
        : undefined,
    });

    // Check 3: Reasonable output length (not suspiciously short for a coding task)
    const promptLength = originalPrompt.length;
    const outputLength = result.output.length;
    const reasonableLength = outputLength >= 10 || promptLength < 20;
    checks.push({
      name: 'reasonable-output-length',
      passed: reasonableLength,
      details: reasonableLength
        ? undefined
        : `Output is very short (${outputLength} chars) for a ${promptLength}-char prompt`,
    });

    // Check 4: Semantic check (opt-in, placeholder for future LLM-based check)
    if (this.opts.semanticCheck) {
      checks.push({
        name: 'semantic-relevance',
        passed: true,
        details: 'Semantic check not yet implemented',
      });
    }

    const allPassed = checks.every(c => c.passed);
    const failedChecks = checks.filter(c => !c.passed);

    const summary = allPassed
      ? 'All verification checks passed'
      : `${failedChecks.length} check(s) failed: ${failedChecks.map(c => c.name).join(', ')}`;

    return { passed: allPassed, checks, summary };
  }
}

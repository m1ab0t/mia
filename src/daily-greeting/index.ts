/**
 * DailyGreetingService
 *
 * Generates a short, personalised daily message from Mia to display on the
 * mobile home screen. The greeting is cached once per calendar day at
 * ~/.mia/daily-greeting.json so the LLM is only called once even if the
 * mobile reconnects multiple times.
 *
 * The message is intentionally brief (≤12 words) and reflects Mia's
 * personality — sharp, direct, occasionally cheeky — rather than a generic
 * "have a great day" filler. Recent daily-log activity is injected for context
 * so the message can reference what the user has been working on.
 */

import { readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { loadRecentDailyLogs } from '../memory/daily-log';

const GREETING_PATH = join(homedir(), '.mia', 'daily-greeting.json');

interface DailyGreetingCache {
  date: string;    // YYYY-MM-DD
  message: string;
}

type UtilityDispatch = (prompt: string) => Promise<string>;

function todayDateStr(): string {
  return new Date().toISOString().split('T')[0];
}

async function loadCache(): Promise<DailyGreetingCache | null> {
  try {
    await access(GREETING_PATH);
    const raw = await readFile(GREETING_PATH, 'utf-8');
    return JSON.parse(raw) as DailyGreetingCache;
  } catch {
    return null;
  }
}

async function saveCache(cache: DailyGreetingCache): Promise<void> {
  try {
    await writeFile(GREETING_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    process.stderr.write(`[DailyGreeting] Save failed: ${err}\n`);
  }
}

export class DailyGreetingService {
  private utilityDispatch: UtilityDispatch | null = null;
  private generating = false;

  setUtilityDispatch(fn: UtilityDispatch): void {
    this.utilityDispatch = fn;
  }

  /**
   * Returns today's greeting. Uses cache if available; otherwise generates a
   * new one (async). Falls back to an empty string if generation fails.
   */
  async getGreeting(): Promise<string> {
    const today = todayDateStr();
    const cached = await loadCache();

    if (cached && cached.date === today && cached.message) {
      return cached.message;
    }

    if (!this.utilityDispatch || this.generating) {
      // Return stale message rather than empty while regenerating
      return cached?.message ?? '';
    }

    return this.generate();
  }

  private async generate(): Promise<string> {
    if (!this.utilityDispatch) return '';
    this.generating = true;

    try {
      const recentLogs = await loadRecentDailyLogs().catch(() => '');
      const today = todayDateStr();

      const contextBlock = recentLogs
        ? `Recent activity:\n${recentLogs}\n\n`
        : '';

      const prompt = `You are Mia — a smart, witty AI programming partner with a distinct personality. You are generating a very short daily home-screen message for your user.

${contextBlock}Today's date: ${today}

Write a single sentence (10 words max) that:
- Feels personal and specific to recent activity if context is available
- Reflects your character: sharp, direct, occasionally teasing or cheeky
- Could be a quip, observation, encouragement, or playful jab — whatever fits
- Is NEVER generic ("have a great day", "ready to code", etc.)
- NEVER mentions encryption, security, or channels

Respond with ONLY the sentence — no quotes, no explanation.`;

      const result = await this.utilityDispatch(prompt);
      const message = result
        .trim()
        .replace(/^["'`]|["'`]$/g, '')
        .trim();

      if (message) {
        await saveCache({ date: today, message });
        process.stderr.write(`[DailyGreeting] Generated: "${message}"\n`);
        return message;
      }

      return (await loadCache())?.message ?? '';
    } catch (err) {
      process.stderr.write(`[DailyGreeting] Generation failed: ${err}\n`);
      return (await loadCache())?.message ?? '';
    } finally {
      this.generating = false;
    }
  }
}

let instance: DailyGreetingService | null = null;

export function getDailyGreetingService(): DailyGreetingService {
  if (!instance) instance = new DailyGreetingService();
  return instance;
}

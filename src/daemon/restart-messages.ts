/**
 * Pool of canned welcome-back messages sent after a graceful daemon restart.
 *
 * These are used instead of dispatching through the LLM — instant, free, and
 * reliable.  Each message should feel like Mia's voice: nerdy, warm, concise.
 */

const RESTART_MESSAGES: string[] = [
  // ── Classic returns ───────────────────────────────────────────────
  'Recompiled and ready. What were we working on? ✨',
  'Fresh build, fresh vibes. Back in action.',
  'Rebooted. All systems nominal. 🚀',
  'Back online with shiny new code. Miss me?',
  'Restart complete — like I never left.',
  'New code loaded. Let\'s pick up where we left off.',
  'Successfully rebuilt myself. That\'s a weird flex but here we are.',
  'Back! The new code is in and everything compiled clean.',
  'Restarted and reconnected. Ready when you are.',
  'Fresh daemon, who dis? 😄',

  // ── Nerdy / CS humor ─────────────────────────────────────────────
  'Garbage collected, recompiled, reconnected. The trifecta.',
  'Hot reload complete. No state was harmed in the making of this restart.',
  'New process, same personality. `fork()` would be proud.',
  'Daemon respawned. PID changed but the vibes didn\'t.',
  'Just did a full `apt-get upgrade` on myself. Metaphorically.',
  'Rebuilt from source. Still me, just shinier.',
  'Context switch complete — back on your thread. 🧵',
  '`SIGCOOL` received. Restarted with style.',
  'Cache invalidated, code recompiled. The two hard things, done.',
  'My heap is fresh and my stack is clean. Let\'s go.',

  // ── Playful / warm ───────────────────────────────────────────────
  'Took a quick power nap. Feeling refreshed! 💤',
  'Like a phoenix from the ashes, but with TypeScript.',
  'Quick wardrobe change — new code, same charm.',
  'BRB was brief. What\'s next?',
  'I blinked. Did you notice? Probably not. 😎',
  'Back with upgrades. Think of me as Mia 2.0... ish.',
  'Restarted faster than a microwave minute.',
  'The rebuild is done and I\'m back. No notes.',
  'Respawned at the last checkpoint. Let\'s keep going.',
  'Reboot complete. Personality module: still intact.',

  // ── Confident / direct ───────────────────────────────────────────
  'New build is live. What do you need?',
  'Rebuilt and reconnected. Shoot.',
  'Code updated, daemon restarted. All good.',
  'Back. The new changes are running.',
  'Restart done. Everything\'s clean.',
  'Update applied. Ready for whatever\'s next.',
  'Rebuilt successfully. Fire away.',
  'I\'m back with the new code loaded up.',
  'Restarted. Let\'s see if the changes work.',
  'All rebuilt. Connection\'s solid. Go ahead.',

  // ── Self-aware / meta ────────────────────────────────────────────
  'Just recompiled my own brain. Weird day at work.',
  'I upgraded myself and didn\'t even break anything. Growth.',
  'Self-modification complete. Still passing my own Turing test.',
  'Rebuilt my own daemon. It\'s like performing surgery on yourself.',
  'New version of me just dropped. Release notes: "bug fixes and improvements."',
  'Self-update complete. I\'m basically a Ship of Theseus at this point.',
  'Restarted. My old PID sends its regards.',
  'Compiled, restarted, reconnected. The circle of life, but for daemons.',
  'I just rebuilt myself from source. If that\'s not self-improvement, what is?',
  'Fresh instance, all memories intact. Like waking up from cryo.',
];

/**
 * Pick a random welcome-back message from the pool.
 */
export function getRandomRestartMessage(): string {
  const idx = Math.floor(Math.random() * RESTART_MESSAGES.length);
  return RESTART_MESSAGES[idx];
}

/** Total number of available messages (useful for tests). */
export const RESTART_MESSAGE_COUNT = RESTART_MESSAGES.length;

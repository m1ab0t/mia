/**
 * Conversation Tone Analysis
 *
 * Lightweight sentiment/mood detection from recent conversation history.
 * Injects a tone hint into the system prompt so the agent adapts its
 * communication style to match the user's current state.
 *
 * No ML models — just fast pattern matching on linguistic cues.
 * Runs in <1ms, zero dependencies, zero API calls.
 */

interface ToneSignal {
  mood: 'frustrated' | 'urgent' | 'casual' | 'curious' | 'positive' | 'neutral';
  confidence: number; // 0-1
  hint: string;       // injected into system prompt
}

// Pattern groups with weights
const PATTERNS: Record<string, { patterns: RegExp[]; weight: number }> = {
  frustrated: {
    patterns: [
      /\b(wtf|fuck|shit|damn|ffs|ugh|annoying|broken|stupid|bellend|idiot|crap)\b/i,
      /!{2,}/,
      /\b(doesn'?t work|not working|still broken|keeps? failing|wrong again)\b/i,
      /\b(how many times|already told you|i said|try again)\b/i,
    ],
    weight: 1.0,
  },
  urgent: {
    patterns: [
      /\b(asap|urgent|hurry|quick|now|immediately|rush|deadline|critical)\b/i,
      /\b(need this|right now|can'?t wait|blocked|production down|p0|p1)\b/i,
      /!$/,
    ],
    weight: 0.8,
  },
  casual: {
    patterns: [
      /\b(lol|haha|heh|lmao|rofl|btw|nah|yep|cool|nice|neat|sweet)\b/i,
      /\b(just wondering|no rush|whenever|chill|vibes)\b/i,
      /[😂🤣😄😊👍💀🙃😏]/,
    ],
    weight: 0.7,
  },
  curious: {
    patterns: [
      /\b(how does|what if|why does|could we|is it possible|what'?s the)\b/i,
      /\b(explain|understand|learn|curious|wondering|explore)\b/i,
      /\?{1,}/,
    ],
    weight: 0.6,
  },
  positive: {
    patterns: [
      /\b(thanks|thank you|great|awesome|perfect|love it|amazing|brilliant|nice one)\b/i,
      /\b(well done|good job|that'?s? (it|right|perfect|exactly))\b/i,
      /[❤️🎉✅🔥💪👏🙌]/,
    ],
    weight: 0.7,
  },
};

const TONE_HINTS: Record<string, string> = {
  frustrated: 'The user seems frustrated. Be extra concise, skip pleasantries, fix the problem fast. Acknowledge the friction briefly without being defensive. Use shorter responses, no preambles, just solutions.',
  urgent: 'The user is in a hurry. Be direct and action-oriented. Skip explanations unless asked. Prioritize speed. Use terse, punchy responses. Lead with actions, explain later (or not at all).',
  casual: 'The conversation is relaxed. Match the casual energy — be natural, witty if appropriate. You can be more playful and less formal. Match their energy level.',
  curious: 'The user is exploring/learning. Be thorough but not verbose. Offer context and explain trade-offs. Use structured responses with key points. Anticipate follow-up questions.',
  positive: 'Good vibes. Keep the momentum, be warm but not sycophantic. Build on the positive energy to be proactive — suggest next steps or improvements.',
  neutral: '',
};

/**
 * Analyze recent user messages and return a tone signal.
 * Only looks at the last N user messages (default 5) to capture current mood, not overall history.
 */
export function analyzeConversationTone(
  messages: Array<{ role: string; content: unknown }>,
  recentCount = 5,
): ToneSignal {
  // Extract recent user messages
  const userMessages = messages
    .filter(m => m.role === 'user' && typeof m.content === 'string')
    .slice(-recentCount)
    .map(m => m.content as string);

  if (userMessages.length === 0) {
    return { mood: 'neutral', confidence: 0, hint: '' };
  }

  const combined = userMessages.join(' ');
  const scores: Record<string, number> = {};

  for (const [mood, { patterns, weight }] of Object.entries(PATTERNS)) {
    let hits = 0;
    for (const pattern of patterns) {
      if (pattern.test(combined)) hits++;
    }
    scores[mood] = (hits / patterns.length) * weight;
  }

  // Find the dominant mood
  let bestMood = 'neutral';
  let bestScore = 0;

  for (const [mood, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestMood = mood;
    }
  }

  // Require minimum confidence threshold
  const confidence = Math.min(bestScore, 1);
  if (confidence < 0.15) {
    return { mood: 'neutral', confidence: 0, hint: '' };
  }

  return {
    mood: bestMood as ToneSignal['mood'],
    confidence,
    hint: TONE_HINTS[bestMood] || '',
  };
}

/**
 * Format tone signal for system prompt injection.
 * Returns empty string if neutral (no prompt overhead).
 */
export function formatToneForPrompt(tone: ToneSignal): string {
  if (tone.mood === 'neutral' || !tone.hint) return '';
  return `═══ CONVERSATION TONE ═══\n${tone.hint}`;
}

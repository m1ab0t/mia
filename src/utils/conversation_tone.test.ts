import { describe, it, expect } from 'vitest';
import { analyzeConversationTone, formatToneForPrompt } from './conversation_tone';

function msgs(...texts: string[]) {
  return texts.map(t => ({ role: 'user', content: t }));
}

describe('analyzeConversationTone', () => {
  it('detects frustration from swearing', () => {
    const tone = analyzeConversationTone(msgs('this is broken', 'wtf it still doesnt work!!'));
    expect(tone.mood).toBe('frustrated');
    expect(tone.confidence).toBeGreaterThan(0);
  });

  it('detects casual from lol/emoji', () => {
    const tone = analyzeConversationTone(msgs('lol nice', 'haha cool 😊'));
    expect(tone.mood).toBe('casual');
  });

  it('detects urgency', () => {
    const tone = analyzeConversationTone(msgs('need this asap, production is down!'));
    expect(tone.mood).toBe('urgent');
  });

  it('detects curiosity from questions', () => {
    const tone = analyzeConversationTone(msgs('how does this work?', 'what if we tried a different approach?'));
    expect(tone.mood).toBe('curious');
  });

  it('detects positive vibes', () => {
    const tone = analyzeConversationTone(msgs('thanks, that was perfect!', 'amazing work 🎉'));
    expect(tone.mood).toBe('positive');
  });

  it('returns neutral for bland messages', () => {
    const tone = analyzeConversationTone(msgs('ok', 'yes'));
    expect(tone.mood).toBe('neutral');
  });

  it('returns neutral for empty history', () => {
    const tone = analyzeConversationTone([]);
    expect(tone.mood).toBe('neutral');
    expect(tone.confidence).toBe(0);
  });

  it('only looks at user messages', () => {
    const messages = [
      { role: 'assistant', content: 'wtf broken shit' },
      { role: 'user', content: 'ok sounds good' },
    ];
    const tone = analyzeConversationTone(messages);
    expect(tone.mood).toBe('neutral');
  });
});

describe('formatToneForPrompt', () => {
  it('returns empty for neutral', () => {
    expect(formatToneForPrompt({ mood: 'neutral', confidence: 0, hint: '' })).toBe('');
  });

  it('returns section for frustrated', () => {
    const result = formatToneForPrompt({
      mood: 'frustrated',
      confidence: 0.8,
      hint: 'The user seems frustrated.',
    });
    expect(result).toContain('CONVERSATION TONE');
    expect(result).toContain('frustrated');
  });
});

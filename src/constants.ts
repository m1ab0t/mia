// Default plugin
export const DEFAULT_PLUGIN = 'claude-code';

// Default context limits
export const DEFAULT_MAX_TOKENS = 128000;
export const DEFAULT_CURRENT_TOKENS = 0;
export const DEFAULT_PERCENT_USED = 0;

// Default context usage object
export const DEFAULT_CONTEXT_USAGE = {
  currentTokens: DEFAULT_CURRENT_TOKENS,
  maxTokens: DEFAULT_MAX_TOKENS,
  percentUsed: DEFAULT_PERCENT_USED,
};

// Map models to their providers for fluency.js
const PROVIDER_PREFIXES: [RegExp, string][] = [
  [/^openrouter\//, 'openrouter'],
  [/^gpt-|^o[1-9]|^chatgpt-/, 'openai'],
  [/^deepseek-/, 'deepseek'],
  [/^gemini-/, 'gemini'],
  [/^groq\/|^llama-|^mixtral-|^gemma-/, 'groq'],
  [/^mistral-|^open-mistral-|^codestral-|^pixtral-/, 'mistral'],
  [/^command-|^aya-/, 'cohere'],
  [/^bedrock\//, 'bedrock'],
];

export function getProviderForModel(model: string): string {
  if (!model) return 'anthropic';
  for (const [pattern, provider] of PROVIDER_PREFIXES) {
    if (pattern.test(model)) return provider;
  }
  return 'anthropic';
}

/**
 * Curated model catalog for the setup wizard.
 * Static list — no external registry dependency.
 */

export interface ProviderChoice {
  value: string;
  label: string;
  hint?: string;
}

export interface ModelChoice {
  value: string;
  label: string;
  hint?: string;
}

interface CuratedProvider {
  id: string;
  label: string;
  hint: string;
  recommended: { id: string; label: string; hint?: string }[];
}

const CURATED_PROVIDERS: CuratedProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'Claude models',
    recommended: [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'recommended · fast & capable' },
      { id: 'claude-opus-4-6',   label: 'Claude Opus 4.6',   hint: 'most capable' },
      { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  hint: 'fastest · near-frontier' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'GPT-5 & o-series',
    recommended: [
      { id: 'gpt-5.2-chat-latest', label: 'GPT-5.2 Chat Latest', hint: 'recommended · newest' },
      { id: 'gpt-5.2',             label: 'GPT-5.2',             hint: 'newest release' },
      { id: 'gpt-5.1-chat-latest', label: 'GPT-5.1 Chat Latest', hint: 'always latest 5.1' },
      { id: 'gpt-5.1',             label: 'GPT-5.1',             hint: 'latest chat' },
      { id: 'gpt-5',               label: 'GPT-5',               hint: 'flagship' },
      { id: 'gpt-5-mini',          label: 'GPT-5 Mini',          hint: 'fast & efficient' },
      { id: 'gpt-5-nano',          label: 'GPT-5 Nano',          hint: 'fastest & cheapest' },

    ],
  },
];

export function getProviderChoices(): ProviderChoice[] {
  return CURATED_PROVIDERS.map((p) => ({
    value: p.id,
    label: p.label,
    hint: p.hint,
  }));
}

export function getModelChoices(providerId: string): ModelChoice[] {
  const curated = CURATED_PROVIDERS.find((p) => p.id === providerId);
  if (!curated) return [];
  return curated.recommended.map((m) => ({
    value: m.id,
    label: m.label,
    hint: m.hint,
  }));
}

export function getDefaultModel(providerId: string): string | undefined {
  return getModelChoices(providerId)[0]?.value;
}

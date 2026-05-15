import type { AppSettings, ChatModelOverride, ProviderKind } from '@shared/types';

/** Build settings for streamChat when a saved chat pins a specific provider + model. */
export function applyChatModelOverride(
  settings: AppSettings,
  override: ChatModelOverride | null | undefined
): AppSettings {
  if (!override?.model?.trim()) {
    return settings;
  }
  const { provider, model } = override;
  return {
    ...settings,
    selectedProvider: provider,
    providers: {
      ...settings.providers,
      [provider]: {
        ...settings.providers[provider],
        model: model.trim()
      }
    }
  };
}

export function formatOverrideLabel(override: ChatModelOverride, pathLabel: (s: string) => string): string {
  const prov = override.provider === 'openrouter' ? 'OpenRouter' : override.provider === 'ollama' ? 'Ollama' : 'LM Studio';
  return `${prov}: ${pathLabel(override.model)}`;
}

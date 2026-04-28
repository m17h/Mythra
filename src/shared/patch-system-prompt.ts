import type { AppSettings } from './types';

/** Mirrors Settings → Prompt textarea behavior: switches to custom and updates linked preset if needed. */
export function patchSystemPromptInSettings(settings: AppSettings, v: string): AppSettings {
  const selected = settings.selectedProvider;
  const provider = settings.providers[selected];
  if (provider.activePromptPresetId) {
    const id = provider.activePromptPresetId;
    return {
      ...settings,
      providers: {
        ...settings.providers,
        [selected]: {
          ...provider,
          systemPrompt: v,
          promptPresets: provider.promptPresets.map((c) =>
            c.id === id ? { ...c, prompt: v, updatedAt: Date.now() } : c
          )
        }
      }
    };
  }
  return {
    ...settings,
    providers: {
      ...settings.providers,
      [selected]: {
        ...provider,
        systemPrompt: v
      }
    }
  };
}

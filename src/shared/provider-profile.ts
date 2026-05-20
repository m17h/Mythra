import type { AppSettings, OpenRouterReasoningEffort, ProviderKind, ProviderProfile, SavedPromptPreset } from './types';

const OPENROUTER_REASONING_EFFORTS: OpenRouterReasoningEffort[] = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const PROVIDER_KINDS: ProviderKind[] = ['lmstudio', 'openrouter', 'ollama'];

function normalizeReasoningEffort(v: unknown, fallback: OpenRouterReasoningEffort | undefined): OpenRouterReasoningEffort {
  return OPENROUTER_REASONING_EFFORTS.includes(v as OpenRouterReasoningEffort)
    ? (v as OpenRouterReasoningEffort)
    : fallback ?? 'auto';
}

function isSavedPromptPresetList(v: unknown): v is SavedPromptPreset[] {
  return (
    Array.isArray(v) &&
    v.every(
      (x) =>
        x != null &&
        typeof x === 'object' &&
        typeof (x as SavedPromptPreset).id === 'string' &&
        typeof (x as SavedPromptPreset).name === 'string' &&
        typeof (x as SavedPromptPreset).prompt === 'string' &&
        typeof (x as SavedPromptPreset).updatedAt === 'number'
    )
  );
}

/** True when disk payload explicitly uses the new `promptPresets` field (not only defaulted). */
function rawHasPromptPresetsKey(raw: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(raw, 'promptPresets');
}

/** Normalize disk / IPC payloads: migrates legacy `promptPresetId` / `customPromptPresets` / `activeCustomPresetId`. */
export function normalizeProviderProfile(
  defaults: ProviderProfile,
  saved?: Partial<Record<string, unknown>>
): ProviderProfile {
  const raw = saved ?? {};
  const base = { ...defaults, ...raw } as Record<string, unknown>;

  if (rawHasPromptPresetsKey(raw) && isSavedPromptPresetList(raw.promptPresets)) {
    const v = raw.activePromptPresetId;
    const activePromptPresetId = typeof v === 'string' ? v : null;
    return {
      kind: (base.kind as ProviderKind) ?? defaults.kind,
      baseUrl: typeof base.baseUrl === 'string' ? base.baseUrl : defaults.baseUrl,
      apiKey: typeof base.apiKey === 'string' ? base.apiKey : defaults.apiKey,
      model: typeof base.model === 'string' ? base.model : defaults.model,
      systemPrompt: typeof base.systemPrompt === 'string' ? base.systemPrompt : defaults.systemPrompt,
      activePromptPresetId,
      promptPresets: raw.promptPresets as SavedPromptPreset[],
      appName: typeof base.appName === 'string' ? base.appName : defaults.appName,
      appUrl: typeof base.appUrl === 'string' ? base.appUrl : defaults.appUrl,
      reasoningEffort: normalizeReasoningEffort(base.reasoningEffort, defaults.reasoningEffort)
    };
  }

  const promptPresets: SavedPromptPreset[] = isSavedPromptPresetList(raw.customPromptPresets)
    ? (raw.customPromptPresets as SavedPromptPreset[])
    : [];

  const oldPid = raw.promptPresetId as string | undefined;
  const oldA = raw.activeCustomPresetId;
  let activePromptPresetId: string | null = null;
  if (oldPid === 'custom') {
    activePromptPresetId = typeof oldA === 'string' ? oldA : null;
  } else {
    activePromptPresetId = null;
  }

  return {
    kind: (base.kind as ProviderKind) ?? defaults.kind,
    baseUrl: typeof base.baseUrl === 'string' ? base.baseUrl : defaults.baseUrl,
    apiKey: typeof base.apiKey === 'string' ? base.apiKey : defaults.apiKey,
    model: typeof base.model === 'string' ? base.model : defaults.model,
    systemPrompt: typeof base.systemPrompt === 'string' ? base.systemPrompt : defaults.systemPrompt,
    activePromptPresetId,
    promptPresets,
    appName: typeof base.appName === 'string' ? base.appName : defaults.appName,
    appUrl: typeof base.appUrl === 'string' ? base.appUrl : defaults.appUrl,
    reasoningEffort: normalizeReasoningEffort(base.reasoningEffort, defaults.reasoningEffort)
  };
}

export function syncProviderSystemPromptFields(settings: AppSettings, sourceProvider: ProviderKind = settings.selectedProvider): AppSettings {
  const source = settings.providers[sourceProvider] ?? settings.providers[settings.selectedProvider];
  if (!source) return settings;

  return {
    ...settings,
    providers: PROVIDER_KINDS.reduce<AppSettings['providers']>(
      (providers, kind) => ({
        ...providers,
        [kind]: {
          ...settings.providers[kind],
          systemPrompt: source.systemPrompt,
          activePromptPresetId: source.activePromptPresetId,
          promptPresets: source.promptPresets
        }
      }),
      settings.providers
    )
  };
}

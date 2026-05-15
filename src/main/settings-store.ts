import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { defaultSettings, type AppSettings } from '@shared/types';
import { isChatThreadBackgroundPresetId } from '@shared/chat-thread-backgrounds';
import { normalizeProviderProfile } from '@shared/provider-profile';

const SETTINGS_FILE = 'mythra-settings.json';
/** Older installs before the Mythra rename. */
const LEGACY_SETTINGS_FILES = ['openkiwi-settings.json', 'pixel-forge-settings.json'] as const;

function normalizeMergedSearch(saved: Partial<AppSettings['search']> | undefined): AppSettings['search'] {
  const base = { ...defaultSettings.search, ...saved };
  let provider: string = typeof base.provider === 'string' ? base.provider : defaultSettings.search.provider;
  /** Legacy single-provider enum before chain preferences. */
  if (provider === 'tavily') provider = 'tavily_then_brave';
  if (provider === 'brave') provider = 'brave_then_tavily';
  if (provider !== 'duckduckgo' && provider !== 'tavily_then_brave' && provider !== 'brave_then_tavily') {
    provider = defaultSettings.search.provider;
  }

  return {
    provider: provider as AppSettings['search']['provider'],
    tavilyApiKey: typeof base.tavilyApiKey === 'string' ? base.tavilyApiKey : '',
    braveApiKey: typeof base.braveApiKey === 'string' ? base.braveApiKey : ''
  };
}

const mergeSettings = (saved: Partial<AppSettings> | undefined): AppSettings => ({
  ...defaultSettings,
  ...saved,
  lastWorkspaceRoot:
    typeof saved?.lastWorkspaceRoot === 'string' && saved.lastWorkspaceRoot.trim().length > 0
      ? saved.lastWorkspaceRoot.trim()
      : null,
  providers: {
    lmstudio: normalizeProviderProfile(
      defaultSettings.providers.lmstudio,
      saved?.providers?.lmstudio as Partial<Record<string, unknown>> | undefined
    ),
    openrouter: normalizeProviderProfile(
      defaultSettings.providers.openrouter,
      saved?.providers?.openrouter as Partial<Record<string, unknown>> | undefined
    ),
    ollama: normalizeProviderProfile(
      defaultSettings.providers.ollama,
      saved?.providers?.ollama as Partial<Record<string, unknown>> | undefined
    )
  },
  search: normalizeMergedSearch(saved?.search),
  tools: {
    ...defaultSettings.tools,
    ...saved?.tools
  },
  agent: {
    ...defaultSettings.agent,
    ...saved?.agent
  },
  ui: {
    ...defaultSettings.ui,
    ...saved?.ui,
    chatThreadBackgroundPreset:
      saved?.ui?.chatThreadBackgroundPreset != null && isChatThreadBackgroundPresetId(String(saved.ui.chatThreadBackgroundPreset))
        ? saved.ui.chatThreadBackgroundPreset
        : saved?.ui?.chatThreadBackgroundPreset === null
          ? null
          : typeof saved?.ui?.chatThreadBackgroundPath === 'string' && saved.ui.chatThreadBackgroundPath.trim().length > 0
            ? null
            : defaultSettings.ui.chatThreadBackgroundPreset,
    chatThreadBackgroundPath:
      typeof saved?.ui?.chatThreadBackgroundPath === 'string' && saved.ui.chatThreadBackgroundPath.trim().length > 0
        ? saved.ui.chatThreadBackgroundPath.trim()
        : null,
    chatThreadBackgroundBlur:
      typeof saved?.ui?.chatThreadBackgroundBlur === 'boolean'
        ? saved.ui.chatThreadBackgroundBlur
        : defaultSettings.ui.chatThreadBackgroundBlur,
    favoriteModels: {
      lmstudio: [
        ...(saved?.ui?.favoriteModels?.lmstudio ?? defaultSettings.ui.favoriteModels.lmstudio)
      ],
      openrouter: [
        ...(saved?.ui?.favoriteModels?.openrouter ?? defaultSettings.ui.favoriteModels.openrouter)
      ],
      ollama: [
        ...(saved?.ui?.favoriteModels?.ollama ?? defaultSettings.ui.favoriteModels.ollama)
      ]
    }
  }
});

export class SettingsStore {
  private readonly userData = app.getPath('userData');
  private readonly path = join(this.userData, SETTINGS_FILE);

  async load(): Promise<AppSettings> {
    const pathsToTry = [this.path, ...LEGACY_SETTINGS_FILES.map((f) => join(this.userData, f))];

    for (const tryPath of pathsToTry) {
      try {
        const raw = await readFile(tryPath, 'utf8');
        const merged = mergeSettings(JSON.parse(raw) as Partial<AppSettings>);
        if (tryPath !== this.path && !existsSync(this.path)) {
          try {
            await mkdir(dirname(this.path), { recursive: true });
            await writeFile(this.path, JSON.stringify(merged, null, 2), 'utf8');
          } catch {
            /* non-fatal migration copy */
          }
        }
        return merged;
      } catch {
        /* try next */
      }
    }
    return defaultSettings;
  }

  async save(next: AppSettings): Promise<AppSettings> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }
}

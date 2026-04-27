import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { defaultSettings, type AppSettings } from '@shared/types';

const SETTINGS_FILE = 'openkiwi-settings.json';
const LEGACY_SETTINGS_FILE = 'pixel-forge-settings.json';

const mergeSettings = (saved: Partial<AppSettings> | undefined): AppSettings => ({
  ...defaultSettings,
  ...saved,
  providers: {
    lmstudio: {
      ...defaultSettings.providers.lmstudio,
      ...saved?.providers?.lmstudio
    },
    openrouter: {
      ...defaultSettings.providers.openrouter,
      ...saved?.providers?.openrouter
    }
  },
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
    favoriteModels: {
      lmstudio: [
        ...(saved?.ui?.favoriteModels?.lmstudio ?? defaultSettings.ui.favoriteModels.lmstudio)
      ],
      openrouter: [
        ...(saved?.ui?.favoriteModels?.openrouter ?? defaultSettings.ui.favoriteModels.openrouter)
      ]
    }
  }
});

export class SettingsStore {
  private readonly userData = app.getPath('userData');
  private readonly path = join(this.userData, SETTINGS_FILE);
  private readonly legacyPath = join(this.userData, LEGACY_SETTINGS_FILE);

  async load(): Promise<AppSettings> {
    if (!existsSync(this.path) && existsSync(this.legacyPath)) {
      try {
        await copyFile(this.legacyPath, this.path);
      } catch {
        // fall through to read legacy
      }
    }
    for (const p of [this.path, this.legacyPath]) {
      try {
        const raw = await readFile(p, 'utf8');
        return mergeSettings(JSON.parse(raw) as Partial<AppSettings>);
      } catch {
        // try next
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

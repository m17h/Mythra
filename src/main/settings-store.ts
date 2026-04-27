import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { defaultSettings, type AppSettings } from '@shared/types';

const SETTINGS_FILE = 'pixel-forge-settings.json';

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
    ...saved?.ui
  }
});

export class SettingsStore {
  private readonly path = join(app.getPath('userData'), SETTINGS_FILE);

  async load(): Promise<AppSettings> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return mergeSettings(JSON.parse(raw) as Partial<AppSettings>);
    } catch {
      return defaultSettings;
    }
  }

  async save(next: AppSettings): Promise<AppSettings> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }
}

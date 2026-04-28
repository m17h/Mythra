import { useEffect, useRef, useState } from 'react';
import { defaultSettings, type AppSettings, type ModelInfo, type ProviderKind, type SearchProvider } from '@shared/types';
import { themes } from '@renderer/lib/themes';
import { getPromptPreset } from '@shared/prompt-presets';
import { AppSelect } from './AppSelect';
import { ModelSearch } from './ModelSearch';
import { PromptPresetMenu, type PresetPatchOptions } from './PromptPresetMenu';

interface SettingsPanelProps {
  settings: AppSettings;
  modelOptions: ModelInfo[];
  statusMessage: string;
  onChange: (next: AppSettings) => void;
  onSave: () => Promise<void>;
  /** Writes full settings to disk (used after custom preset add/save/rename/delete). */
  onPresetPersist: (next: AppSettings) => Promise<void>;
  onRefreshModels: () => void;
  focusSearchSettingsKey?: number;
}

const providerOptions: Array<{ value: ProviderKind; label: string }> = [
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'openrouter', label: 'OpenRouter' }
];

const searchProviderOptions: Array<{ value: SearchProvider; label: string }> = [
  { value: 'duckduckgo', label: 'DuckDuckGo fallback' },
  { value: 'tavily', label: 'Tavily' },
  { value: 'brave', label: 'Brave Search' }
];

const HEADER_SAVE_ACK_MS = 1500;

export function SettingsPanel({
  settings,
  modelOptions,
  statusMessage,
  onChange,
  onSave,
  onPresetPersist,
  onRefreshModels,
  focusSearchSettingsKey = 0
}: SettingsPanelProps) {
  const [headerSaveAck, setHeaderSaveAck] = useState(false);
  const saveAckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSectionRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      if (saveAckTimerRef.current) clearTimeout(saveAckTimerRef.current);
    },
    []
  );

  useEffect(() => {
    if (focusSearchSettingsKey <= 0) return;
    searchSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    searchSectionRef.current?.classList.add('settings-section--focus-pulse');
    const timer = setTimeout(() => {
      searchSectionRef.current?.classList.remove('settings-section--focus-pulse');
    }, 1400);
    return () => clearTimeout(timer);
  }, [focusSearchSettingsKey]);

  const provider = settings.providers[settings.selectedProvider];
  const isLmStudio = settings.selectedProvider === 'lmstudio';
  const isOpenRouter = settings.selectedProvider === 'openrouter';
  const activeSearchProvider = settings.search.provider;
  const activeSearchHasKey =
    activeSearchProvider === 'tavily'
      ? Boolean(settings.search.tavilyApiKey.trim())
      : activeSearchProvider === 'brave'
        ? Boolean(settings.search.braveApiKey.trim())
        : false;

  const updateProvider = (patch: Partial<typeof provider>, opts?: PresetPatchOptions) => {
    const next: AppSettings = {
      ...settings,
      providers: {
        ...settings.providers,
        [settings.selectedProvider]: { ...provider, ...patch }
      }
    };
    onChange(next);
    if (opts?.persist) void onPresetPersist(next);
  };

  const updateSearch = (patch: Partial<AppSettings['search']>, persist = false) => {
    const next: AppSettings = {
      ...settings,
      search: {
        ...settings.search,
        ...patch
      }
    };
    onChange(next);
    if (persist) void onPresetPersist(next);
  };

  const onHeaderSave = async () => {
    if (saveAckTimerRef.current) {
      clearTimeout(saveAckTimerRef.current);
      saveAckTimerRef.current = null;
    }
    try {
      await onSave();
      setHeaderSaveAck(true);
      saveAckTimerRef.current = setTimeout(() => {
        setHeaderSaveAck(false);
        saveAckTimerRef.current = null;
      }, HEADER_SAVE_ACK_MS);
    } catch {
      setHeaderSaveAck(false);
    }
  };

  const activeCustom = provider.activeCustomPresetId
    ? provider.customPromptPresets.find((c) => c.id === provider.activeCustomPresetId)
    : undefined;

  return (
    <section className="panel settings-panel">
      <div className="settings-panel__header">
        <div>
          <h3 className="settings-panel__title">Settings</h3>
          <p className="settings-panel__subtitle">Provider, tools, and preferences</p>
        </div>
        <button
          aria-live="polite"
          className={`btn btn--secondary settings-panel__save${headerSaveAck ? ' settings-panel__save--ack' : ''}`}
          onClick={onHeaderSave}
          type="button"
        >
          {headerSaveAck ? (
            <>
              <span aria-hidden className="settings-panel__save-check">✓</span> Saved
            </>
          ) : (
            'Save'
          )}
        </button>
      </div>

      <div className="settings-scroll">
        <div className="settings-section">
          <h4 className="settings-section__title">Connection</h4>

          <label className="field">
            <span>Provider</span>
            <AppSelect
              options={providerOptions}
              value={settings.selectedProvider}
              onChange={(providerKind) => onChange({ ...settings, selectedProvider: providerKind })}
            />
          </label>

          {isLmStudio ? (
            <label className="field">
              <span>Base URL</span>
              <input onChange={(e) => updateProvider({ baseUrl: e.target.value })} value={provider.baseUrl} />
            </label>
          ) : (
            <p className="inline-hint">
              OpenRouter uses the official API at the default endpoint—no base URL to set here. Choose LM Studio above if you need a local or custom server URL.
            </p>
          )}

          <label className="field">
            <span>{isOpenRouter ? 'API Key' : 'Server Key'}</span>
            <input
              onChange={(e) => updateProvider({ apiKey: e.target.value })}
              placeholder={isOpenRouter ? 'sk-or-v1-...' : 'lm-studio'}
              type="password"
              value={provider.apiKey}
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>Model</span>
              {modelOptions.length > 0 ? (
                <ModelSearch
                  favoriteIds={settings.ui.favoriteModels?.[settings.selectedProvider] ?? []}
                  models={modelOptions}
                  onChange={(id) => updateProvider({ model: id })}
                  onToggleFavorite={(id) => {
                    const k = settings.selectedProvider;
                    const baseFav =
                      settings.ui.favoriteModels ?? defaultSettings.ui.favoriteModels;
                    const nextSet = new Set(baseFav[k] ?? []);
                    if (nextSet.has(id)) nextSet.delete(id);
                    else nextSet.add(id);
                    const next: AppSettings = {
                      ...settings,
                      ui: {
                        ...settings.ui,
                        favoriteModels: {
                          ...baseFav,
                          [k]: [...nextSet].sort((a, b) => a.localeCompare(b))
                        }
                      }
                    };
                    onChange(next);
                    // Same as web search / custom presets: persist immediately so favorites survive restart (dev or prod).
                    void onPresetPersist(next);
                  }}
                  value={provider.model}
                />
              ) : (
                <select onChange={(e) => updateProvider({ model: e.target.value })} value={provider.model}>
                  <option value="">Select model</option>
                </select>
              )}
            </label>
            <button className="btn btn--secondary field-row__button" onClick={onRefreshModels} type="button">
              Test + Refresh
            </button>
          </div>

          {isLmStudio && modelOptions.length === 0 && (
            <div className="inline-hint">No models loaded yet. Start the LM Studio server and load a model first.</div>
          )}
        </div>

        <div className="settings-section">
          <h4 className="settings-section__title">System Prompt</h4>

          <label className="field">
            <span>Preset</span>
            <PromptPresetMenu onPatch={updateProvider} provider={provider} />
          </label>

          <div className="inline-hint">
            {provider.promptPresetId === 'custom'
              ? activeCustom
                ? `Editing “${activeCustom.name}.” The prompt text syncs to this preset. Preset → Custom → Save, New, rename, and delete are written to disk right away. Use the header Save for connection, tools, theme, and the rest.`
                : 'Custom prompt. Open Preset → Custom for New, Save, load, rename, or delete. Preset list changes are saved to disk when you use those actions. Use the header Save for connection, tools, and theme.'
              : getPromptPreset(provider.promptPresetId).description}
          </div>

          <label className="field">
            <span>Prompt</span>
            <textarea
              onChange={(e) => {
                const v = e.target.value;
                if (provider.promptPresetId === 'custom' && provider.activeCustomPresetId) {
                  const id = provider.activeCustomPresetId;
                  updateProvider({
                    promptPresetId: 'custom',
                    systemPrompt: v,
                    customPromptPresets: provider.customPromptPresets.map((c) =>
                      c.id === id ? { ...c, prompt: v, updatedAt: Date.now() } : c
                    )
                  });
                } else {
                  updateProvider({ promptPresetId: 'custom', systemPrompt: v });
                }
              }}
              rows={6}
              value={provider.systemPrompt}
            />
          </label>
        </div>

        <div className="settings-section" ref={searchSectionRef}>
          <h4 className="settings-section__title">Web Search</h4>

          <label className="field">
            <span>Search Provider</span>
            <AppSelect
              options={searchProviderOptions}
              onChange={(providerKind) => updateSearch({ provider: providerKind }, true)}
              value={activeSearchProvider}
            />
          </label>

          <div className="inline-hint">
            DuckDuckGo works without a key, but it only returns instant answers and is often thin. Tavily is recommended
            for AI-ready search. Brave Search is a strong general web-search option.
          </div>

          <label className="field">
            <span>Tavily API Key</span>
            <input
              autoComplete="off"
              onChange={(e) => updateSearch({ tavilyApiKey: e.target.value })}
              placeholder="tvly-..."
              type="password"
              value={settings.search.tavilyApiKey}
            />
          </label>

          <label className="field">
            <span>Brave Search API Key</span>
            <input
              autoComplete="off"
              onChange={(e) => updateSearch({ braveApiKey: e.target.value })}
              placeholder="BSA..."
              type="password"
              value={settings.search.braveApiKey}
            />
          </label>

          {activeSearchProvider !== 'duckduckgo' && !activeSearchHasKey ? (
            <div className="inline-hint inline-hint--warning">
              Add and save an API key for {activeSearchProvider === 'tavily' ? 'Tavily' : 'Brave Search'}, or OpenKiwi
              will fall back to DuckDuckGo instant answers.
            </div>
          ) : null}
        </div>

        <div className="settings-section">
          <h4 className="settings-section__title">Theme</h4>
          <div className="theme-grid">
            {themes.map((theme) => (
              <button
                key={theme.id}
                className={`theme-tile ${settings.ui.themeId === theme.id ? 'is-active' : ''}`}
                onClick={() => onChange({ ...settings, ui: { ...settings.ui, themeId: theme.id } })}
                type="button"
              >
                <strong>{theme.name}</strong>
                <span>{theme.preview}</span>
              </button>
            ))}
          </div>
          <div className="field field--after-theme-grid">
            <span>Session mode</span>
            <div className="session-mode-toggle">
              <button
                className={`session-mode-toggle__option ${settings.ui.sessionMode === 'talk' ? 'is-active' : ''}`}
                onClick={() => onChange({ ...settings, ui: { ...settings.ui, sessionMode: 'talk' } })}
                type="button"
              >
                Chat
              </button>
              <button
                className={`session-mode-toggle__option ${settings.ui.sessionMode === 'agent' ? 'is-active' : ''}`}
                onClick={() => onChange({ ...settings, ui: { ...settings.ui, sessionMode: 'agent' } })}
                type="button"
              >
                Agent
              </button>
              <span
                className="session-mode-toggle__slider"
                style={{ transform: settings.ui.sessionMode === 'agent' ? 'translateX(100%)' : 'translateX(0)' }}
              />
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h4 className="settings-section__title">Tool Access</h4>
          <div className="toggle-list">
            {([
              ['fileRead', 'Read files'],
              ['fileWrite', 'Write files'],
              ['workspaceSearch', 'Workspace search'],
              ['commandDeck', 'Command deck']
            ] as const).map(([key, label]) => (
              <label className={`toggle-row ${settings.tools[key] ? 'is-active-soft' : ''}`} key={key}>
                <span>{label}</span>
                <input
                  checked={settings.tools[key]}
                  onChange={(e) => onChange({ ...settings, tools: { ...settings.tools, [key]: e.target.checked } })}
                  type="checkbox"
                />
              </label>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <h4 className="settings-section__title">Agent Autonomy</h4>
          <label className={`toggle-row toggle-row--warning ${settings.agent.fullAccess ? 'is-active' : ''}`}>
            <span>Full access mode</span>
            <input
              checked={settings.agent.fullAccess}
              onChange={(e) => onChange({ ...settings, agent: { ...settings.agent, fullAccess: e.target.checked } })}
              type="checkbox"
            />
          </label>
          <div className="inline-hint inline-hint--warning">
            AI can write, delete files, and run commands without approval.
          </div>

          <label className={`toggle-row ${settings.agent.autoContinue ? 'is-active-soft' : ''}`}>
            <span>Continue until done</span>
            <input
              checked={settings.agent.autoContinue}
              onChange={(e) => onChange({ ...settings, agent: { ...settings.agent, autoContinue: e.target.checked } })}
              type="checkbox"
            />
          </label>

          <label className="field">
            <span>Auto Step Limit</span>
            <select
              onChange={(e) => onChange({ ...settings, agent: { ...settings.agent, maxAutoSteps: Number(e.target.value) } })}
              value={String(settings.agent.maxAutoSteps)}
            >
              <option value="12">12 steps</option>
              <option value="24">24 steps</option>
              <option value="40">40 steps</option>
              <option value="60">60 steps</option>
            </select>
          </label>
        </div>

        {statusMessage && <div className="status-line">{statusMessage}</div>}
      </div>
    </section>
  );
}

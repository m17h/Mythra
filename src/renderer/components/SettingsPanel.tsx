import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { defaultSettings, type AppSettings, type ModelInfo, type ProviderKind, type SearchProvider } from '@shared/types';
import { themes } from '@renderer/lib/themes';
import { getThemeName } from '@shared/themes';
import { patchSystemPromptInSettings } from '@shared/patch-system-prompt';
import { AppSelect } from './AppSelect';
import { ModelSearch } from './ModelSearch';
import { PromptPresetMenu, type PresetPatchOptions } from './PromptPresetMenu';

interface SettingsPanelProps {
  settings: AppSettings;
  modelOptions: ModelInfo[];
  statusMessage: string;
  onChange: (next: AppSettings) => void;
  /** Writes full settings to disk (used after custom preset add/save/rename/delete). */
  onPresetPersist: (next: AppSettings) => Promise<void>;
  onRefreshModels: () => void;
  /** Opens the in-app Connection guide (OpenRouter & LM Studio) from Settings. */
  onOpenConnectionHelp?: () => void;
  /** Opens the in-app explanation about Tavily / Brave Search (same dialog as onboarding). */
  onOpenWebSearchInfo?: () => void;
  /** Opens guidance about writing system prompts and presets. */
  onOpenSystemPromptInfo?: () => void;
  /** Opens the large system prompt editor (same dialog animation as Web Search info). */
  onOpenSystemPromptModal?: () => void;
  focusSearchSettingsKey?: number;
}

const providerOptions: Array<{ value: ProviderKind; label: string }> = [
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'openrouter', label: 'OpenRouter' }
];

const searchProviderOptions: Array<{ value: SearchProvider; label: string }> = [
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'tavily_then_brave', label: 'Tavily, then Brave' },
  { value: 'brave_then_tavily', label: 'Brave, then Tavily' }
];

export function SettingsPanel({
  settings,
  modelOptions,
  statusMessage,
  onChange,
  onPresetPersist,
  onRefreshModels,
  onOpenConnectionHelp,
  onOpenWebSearchInfo,
  onOpenSystemPromptInfo,
  onOpenSystemPromptModal,
  focusSearchSettingsKey = 0
}: SettingsPanelProps) {
  const [themeSectionExpanded, setThemeSectionExpanded] = useState(false);
  const searchSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusSearchSettingsKey <= 0) return;
    const el = searchSectionRef.current;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el?.classList.add('settings-section--focus-pulse');
    const onEnd = () => {
      el?.classList.remove('settings-section--focus-pulse');
      el?.removeEventListener('animationend', onEnd);
    };
    el?.addEventListener('animationend', onEnd);
    return () => {
      el?.removeEventListener('animationend', onEnd);
      el?.classList.remove('settings-section--focus-pulse');
    };
  }, [focusSearchSettingsKey]);

  const provider = settings.providers[settings.selectedProvider];
  const isLmStudio = settings.selectedProvider === 'lmstudio';
  const isOpenRouter = settings.selectedProvider === 'openrouter';
  const activeSearchProvider = settings.search.provider;
  const anyPremiumApiKeySaved =
    Boolean(settings.search.tavilyApiKey.trim()) || Boolean(settings.search.braveApiKey.trim());

  const activeThemeLabel = getThemeName(settings.ui.themeId);

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

  return (
    <section className="panel settings-panel">
      <div className="settings-panel__header">
        <div>
          <h3 className="settings-panel__title">Settings</h3>
          <p className="settings-panel__subtitle">Provider, tools, and preferences</p>
        </div>
      </div>

      <div className="settings-scroll">
        <div className="settings-section">
          <div className="settings-section__title-cluster">
            <h4 className="settings-section__title settings-section__title--cluster">Connection</h4>
            {onOpenConnectionHelp ? (
              <button
                className="settings-info-button"
                type="button"
                aria-label="About OpenRouter, LM Studio, and Mythra"
                title="OpenRouter & LM Studio in Mythra"
                onClick={onOpenConnectionHelp}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                  <path d="M12 16v-4.5M12 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            ) : null}
          </div>

          <div className="field">
            <span id="settings-connection-provider-label">Provider</span>
            <AppSelect
              ariaLabelledBy="settings-connection-provider-label"
              options={providerOptions}
              value={settings.selectedProvider}
              onChange={(providerKind) => onChange({ ...settings, selectedProvider: providerKind })}
            />
          </div>

          {isLmStudio ? (
            <label className="field">
              <span>Base URL</span>
              <input onChange={(e) => updateProvider({ baseUrl: e.target.value })} value={provider.baseUrl} />
            </label>
          ) : null}

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
            <div className="field">
              <span>Model</span>
              {modelOptions.length > 0 ? (
                <ModelSearch
                  favoriteIds={settings.ui.favoriteModels?.[settings.selectedProvider] ?? []}
                  models={modelOptions}
                  onChange={(id) => updateProvider({ model: id })}
                  portalDropdown
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
            </div>
            {isLmStudio ? (
              <button className="btn btn--secondary field-row__button" onClick={onRefreshModels} type="button">
                Test + Refresh
              </button>
            ) : null}
          </div>

          {isLmStudio && modelOptions.length === 0 && (
            <div className="inline-hint">No models loaded yet. Start the LM Studio server and load a model first.</div>
          )}
        </div>

        <div className="settings-section">
          <div className="settings-section__title-cluster">
            <h4 className="settings-section__title settings-section__title--cluster">System Prompt</h4>
            {onOpenSystemPromptInfo ? (
              <button
                className="settings-info-button"
                type="button"
                aria-label="About system prompts and presets"
                title="Tips for system prompts"
                onClick={onOpenSystemPromptInfo}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                  <path d="M12 16v-4.5M12 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            ) : null}
          </div>

          <div className="field">
            <span>Preset</span>
            <PromptPresetMenu onPatch={updateProvider} provider={provider} />
          </div>

          {provider.promptPresets.length === 0 ? (
            <div className="inline-hint">
              Add presets to save reusable system prompts for this provider. Use <strong>New preset…</strong> or{' '}
              <strong>Save as new…</strong> from the menu.
            </div>
          ) : null}

          <label className="field">
            <span className="field__label-row">
              <span>Prompt</span>
              {onOpenSystemPromptModal ? (
                <button
                  aria-label="Open system prompt in a larger editor"
                  className="settings-info-button"
                  onClick={() => onOpenSystemPromptModal()}
                  title="Expand editor"
                  type="button"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeWidth="2"
                    />
                  </svg>
                </button>
              ) : null}
            </span>
            <textarea
              onChange={(e) => {
                onChange(patchSystemPromptInSettings(settings, e.target.value));
              }}
              rows={6}
              value={provider.systemPrompt}
            />
          </label>
        </div>

        <div className="settings-section" ref={searchSectionRef}>
          <div className="settings-section__title-cluster">
            <h4 className="settings-section__title settings-section__title--cluster">Web Search</h4>
            {onOpenWebSearchInfo ? (
              <button
                className="settings-info-button"
                type="button"
                aria-label="About Web Search providers (Tavily and Brave)"
                title="About Tavily and Brave Search"
                onClick={onOpenWebSearchInfo}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                  <path d="M12 16v-4.5M12 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            ) : null}
          </div>

          <label className="field">
            <span>Search Provider</span>
            <AppSelect
              options={searchProviderOptions}
              onChange={(providerKind) => updateSearch({ provider: providerKind }, true)}
              value={activeSearchProvider}
            />
          </label>

          <div className="inline-hint">
            DuckDuckGo works without a key but only returns instant answers and is often thin. For the chained options,
            Mythra uses each saved API key in order; if a step fails (quota, HTTP error) it tries the next, then falls back
            to DuckDuckGo. Tavily is a strong pick for AI-ready snippets; Brave is a solid general web search.
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

          {activeSearchProvider !== 'duckduckgo' && !anyPremiumApiKeySaved ? (
            <div className="inline-hint inline-hint--warning">
              Add and save at least one Tavily or Brave Search API key, or Mythra will use DuckDuckGo instant answers
              only under this provider choice.
            </div>
          ) : null}
        </div>

        <div className="settings-section">
          <div className={`chat-thread-options chat-thread-options--settings ${themeSectionExpanded ? 'is-expanded' : ''}`}>
            <button
              className="chat-thread-options__header"
              onClick={() => setThemeSectionExpanded((v) => !v)}
              type="button"
            >
              <span className="chat-thread-options__header-left">
                <svg
                  className="chat-thread-options__chevron"
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M4 2.5L7.5 6 4 9.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="chat-thread-options__title">Theme</span>
              </span>
              {!themeSectionExpanded ? <span className="chat-thread-options__badge">{activeThemeLabel}</span> : null}
            </button>

            <AnimatePresence initial={false}>
              {themeSectionExpanded ? (
                <motion.div
                  key="theme-body"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                  style={{ overflow: 'hidden' }}
                >
                  <div className="chat-thread-options__body">
                    <div className="theme-grid">
                      {settings.ui.themeId === 'custom' ? (
                        <div
                          className="theme-tile is-active"
                          role="status"
                          aria-label="Theme: Custom, selected"
                        >
                          <strong>{getThemeName('custom')}</strong>
                          <span>Adjusted by Agent (preset clears this)</span>
                        </div>
                      ) : null}
                      {themes.map((theme) => (
                        <button
                          key={theme.id}
                          className={`theme-tile ${settings.ui.themeId === theme.id ? 'is-active' : ''}`}
                          onClick={() => {
                            const next: AppSettings = {
                              ...settings,
                              ui: { ...settings.ui, themeId: theme.id, customThemeTokens: undefined }
                            };
                            void onPresetPersist(next);
                          }}
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
                          style={{
                            transform: settings.ui.sessionMode === 'agent' ? 'translateX(100%)' : 'translateX(0)'
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>

        <div className="settings-section">
          <h4 className="settings-section__title">Tool Access</h4>
          <div className="toggle-list">
            {([
              ['fileRead', 'Read files'],
              ['fileWrite', 'Write files'],
              ['workspaceSearch', 'Workspace search'],
              ['commandDeck', 'Command deck'],
              ['allowModelSystemPrompt', 'AI can change system prompt']
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
          <div className="inline-hint">
            When <strong>AI can change system prompt</strong> is on, Agent mode may call <code>set_system_prompt</code>{' '}
            after you ask—saved to Settings for the selected provider (with approval unless Full access).
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

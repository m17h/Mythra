import { useEffect, useRef, useState } from 'react';
import type { AppSettings, ModelInfo, ProviderKind, SessionMode } from '@shared/types';
import { themes } from '@renderer/lib/themes';
import { getPromptPreset } from '@shared/prompt-presets';
import { PromptPresetMenu } from './PromptPresetMenu';

interface SettingsPanelProps {
  settings: AppSettings;
  modelOptions: ModelInfo[];
  statusMessage: string;
  onChange: (next: AppSettings) => void;
  onSave: () => void;
  onRefreshModels: () => void;
}

const providerOptions: Array<{ value: ProviderKind; label: string }> = [
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'openrouter', label: 'OpenRouter' }
];

function ModelSearch({
  models,
  value,
  onChange
}: {
  models: ModelInfo[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = query
    ? models.filter((m) => m.id.toLowerCase().includes(query.toLowerCase()))
    : models;

  const displayValue = value || '';

  return (
    <div className="model-search" ref={ref}>
      <input
        className="model-search__input"
        placeholder="Search models..."
        value={open ? query : displayValue}
        onFocus={() => {
          setOpen(true);
          setQuery('');
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
      />
      {open && (
        <div className="model-search__dropdown">
          {filtered.length === 0 ? (
            <div className="model-search__empty">No models match "{query}"</div>
          ) : (
            filtered.slice(0, 50).map((m) => (
              <button
                key={m.id}
                className={`model-search__option ${m.id === value ? 'is-active' : ''}`}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                  setQuery('');
                }}
                type="button"
              >
                <span className="model-search__option-id">{m.id}</span>
                {m.contextLength ? (
                  <span className="model-search__option-ctx">{Math.round(m.contextLength / 1024)}k ctx</span>
                ) : null}
              </button>
            ))
          )}
          {filtered.length > 50 && (
            <div className="model-search__more">+ {filtered.length - 50} more results. Refine your search.</div>
          )}
        </div>
      )}
    </div>
  );
}

export function SettingsPanel({ settings, modelOptions, statusMessage, onChange, onSave, onRefreshModels }: SettingsPanelProps) {
  const provider = settings.providers[settings.selectedProvider];
  const isLmStudio = settings.selectedProvider === 'lmstudio';
  const isOpenRouter = settings.selectedProvider === 'openrouter';

  const updateProvider = (patch: Partial<typeof provider>) => {
    onChange({
      ...settings,
      providers: {
        ...settings.providers,
        [settings.selectedProvider]: { ...provider, ...patch }
      }
    });
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
        <button className="btn btn--secondary" onClick={onSave} type="button">Save</button>
      </div>

      <div className="settings-scroll">
        <div className="settings-section">
          <h4 className="settings-section__title">Connection</h4>

          <label className="field">
            <span>Provider</span>
            <select
              value={settings.selectedProvider}
              onChange={(e) => onChange({ ...settings, selectedProvider: e.target.value as ProviderKind })}
            >
              {providerOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Base URL</span>
            <input onChange={(e) => updateProvider({ baseUrl: e.target.value })} value={provider.baseUrl} />
          </label>

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
              {isOpenRouter && modelOptions.length > 10 ? (
                <ModelSearch
                  models={modelOptions}
                  value={provider.model}
                  onChange={(id) => updateProvider({ model: id })}
                />
              ) : (
                <select onChange={(e) => updateProvider({ model: e.target.value })} value={provider.model}>
                  <option value="">Select model</option>
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>{m.id}</option>
                  ))}
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

          {isOpenRouter && (
            <div className="field-row">
              <label className="field">
                <span>App Name</span>
                <input onChange={(e) => updateProvider({ appName: e.target.value })} value={provider.appName} />
              </label>
              <label className="field">
                <span>App URL</span>
                <input onChange={(e) => updateProvider({ appUrl: e.target.value })} value={provider.appUrl} />
              </label>
            </div>
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
                ? `Editing “${activeCustom.name}.” The prompt text syncs to this preset; use Preset → Custom to Save, rename, or delete. Use the header Save to write settings to disk.`
                : 'Custom prompt. Open Preset → Custom for New, Save, load, rename, or delete saved presets. Header Save writes settings to disk.'
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
          <label className="field field--after-theme-grid">
            <span>Session mode</span>
            <select
              onChange={(e) =>
                onChange({
                  ...settings,
                  ui: { ...settings.ui, sessionMode: e.target.value as SessionMode }
                })
              }
              value={settings.ui.sessionMode}
            >
              <option value="agent">Agent (workspace, tools, autonomous runs)</option>
              <option value="talk">Talk (plain chat, no file tools)</option>
            </select>
          </label>
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

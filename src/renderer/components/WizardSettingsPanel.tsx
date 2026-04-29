import { useEffect, useState } from 'react';
import { defaultSettings, type AppSettings, type ModelInfo, type ProviderKind, type WizardProfile } from '@shared/types';
import { AppSelect } from './AppSelect';
import { ModelSearch } from './ModelSearch';

interface WizardSettingsPanelProps {
  wizard: WizardProfile;
  settings: AppSettings;
  modelOptions: ModelInfo[];
  statusMessage: string;
  onChange: (wizard: WizardProfile) => void;
  onOpenDocument: (path: string) => void;
  onRefreshModels: (provider: ProviderKind) => Promise<ModelInfo[]>;
  /** Update + persist favorites (same mechanism as Connection → Model in Settings). */
  onPresetPersist: (next: AppSettings) => Promise<void>;
  onSettingsChangeForFavorites: (next: AppSettings) => void;
}

const providerOptions: Array<{ value: ProviderKind; label: string }> = [
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'openrouter', label: 'OpenRouter' }
];

export function WizardSettingsPanel({
  wizard,
  settings,
  modelOptions,
  statusMessage,
  onChange,
  onOpenDocument,
  onRefreshModels,
  onPresetPersist,
  onSettingsChangeForFavorites
}: WizardSettingsPanelProps) {
  const [localModels, setLocalModels] = useState<ModelInfo[]>(modelOptions);

  useEffect(() => {
    setLocalModels(modelOptions);
  }, [modelOptions]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const docs = await window.electronAPI.listWizardDocuments(wizard.workspaceRoot);
        if (cancelled) return;
        const prevKey = wizard.documents.map((d) => d.path).join('\0');
        const nextKey = docs.map((d) => d.path).join('\0');
        if (prevKey !== nextKey) {
          onChange({ ...wizard, documents: docs });
        }
      } catch {
        /* workspace missing or unreadable */
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only re-scan when switching to another Wizard workspace; live updates come from App workspace events.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional narrow deps
  }, [wizard.workspaceRoot]);

  return (
    <section className="panel settings-panel">
      <div className="settings-panel__header">
        <div>
          <h3 className="settings-panel__title">Wizard</h3>
          <p className="settings-panel__subtitle">Model, memory, and private workspace</p>
        </div>
      </div>

      <div className="settings-scroll">
        <div className="settings-section">
          <h4 className="settings-section__title">Identity</h4>
          <label className="field">
            <span>Name</span>
            <input onChange={(e) => onChange({ ...wizard, name: e.target.value })} value={wizard.name} />
          </label>
          <div className="field">
            <span>Workspace</span>
            <input readOnly value={wizard.workspaceRoot} />
          </div>
          <div className="inline-hint">This local folder belongs to this Wizard. Cloud-synced folders are not used.</div>
        </div>

        <div className="settings-section">
          <h4 className="settings-section__title">Model</h4>
          <div className="field">
            <span>Provider</span>
            <AppSelect
              onChange={async (provider) => {
                const list = await onRefreshModels(provider);
                setLocalModels(list);
                onChange({ ...wizard, provider, model: list[0]?.id ?? '' });
              }}
              options={providerOptions}
              value={wizard.provider}
            />
          </div>
          <div className="field">
            <span>Model</span>
            {localModels.length ? (
              <ModelSearch
                favoriteIds={settings.ui.favoriteModels?.[wizard.provider] ?? defaultSettings.ui.favoriteModels[wizard.provider]}
                models={localModels}
                onChange={(model) => onChange({ ...wizard, model })}
                onToggleFavorite={(id) => {
                  const k = wizard.provider;
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
                  onSettingsChangeForFavorites(next);
                  void onPresetPersist(next);
                }}
                value={wizard.model}
              />
            ) : (
              <input readOnly value={wizard.model || 'No model selected'} />
            )}
          </div>
        </div>

        <div className="settings-section">
          <h4 className="settings-section__title">Agent autonomy</h4>
          <label className={`toggle-row toggle-row--warning ${wizard.fullAccess ? 'is-active' : ''}`}>
            <span>Full access mode</span>
            <input
              checked={Boolean(wizard.fullAccess)}
              onChange={(e) => onChange({ ...wizard, fullAccess: e.target.checked })}
              type="checkbox"
            />
          </label>
          <div className="inline-hint inline-hint--warning">
            When on, this Wizard can write, delete files, and run commands without per-action approval — same idea as
            Settings → Agent autonomy → Full access for normal chats.
          </div>
        </div>

        <div className="settings-section">
          <h4 className="settings-section__title">Core Documents</h4>
          <div className="wizard-doc-list">
            {wizard.documents.map((doc) => (
              <button className="wizard-doc-list__item" key={doc.path} onClick={() => onOpenDocument(doc.path)} type="button">
                <span>{doc.label}</span>
                <code>{doc.path.split(/[\\/]/).pop()}</code>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <h4 className="settings-section__title">System Prompt</h4>
          <label className="field">
            <span>Prompt</span>
            <textarea onChange={(e) => onChange({ ...wizard, systemPrompt: e.target.value })} rows={10} value={wizard.systemPrompt} />
          </label>
        </div>

        {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
      </div>
    </section>
  );
}

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
  onSave: () => Promise<void>;
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
  onSave
}: WizardSettingsPanelProps) {
  const [headerSaveAck, setHeaderSaveAck] = useState(false);
  const [localModels, setLocalModels] = useState<ModelInfo[]>(modelOptions);

  useEffect(() => {
    setLocalModels(modelOptions);
  }, [modelOptions]);

  const save = async () => {
    await onSave();
    setHeaderSaveAck(true);
    window.setTimeout(() => setHeaderSaveAck(false), 1500);
  };

  return (
    <section className="panel settings-panel">
      <div className="settings-panel__header">
        <div>
          <h3 className="settings-panel__title">Wizard</h3>
          <p className="settings-panel__subtitle">Model, memory, and private workspace</p>
        </div>
        <button
          aria-live="polite"
          className={`btn btn--secondary settings-panel__save${headerSaveAck ? ' settings-panel__save--ack' : ''}`}
          onClick={save}
          type="button"
        >
          {headerSaveAck ? 'Saved' : 'Save'}
        </button>
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
                onToggleFavorite={() => undefined}
                value={wizard.model}
              />
            ) : (
              <input readOnly value={wizard.model || 'No model selected'} />
            )}
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

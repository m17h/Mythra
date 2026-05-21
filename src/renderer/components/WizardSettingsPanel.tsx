import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { defaultSettings, type AppSettings, type ModelInfo, type ProviderKind, type WizardProfile } from '@shared/types';
import { roughTokensFromText } from '@renderer/lib/estimate-context-tokens';
import { AppSelect } from './AppSelect';
import { ModelSearch } from './ModelSearch';

interface WizardSettingsPanelProps {
  wizard: WizardProfile;
  settings: AppSettings;
  modelOptions: ModelInfo[];
  statusMessage: string;
  onChange: (wizard: WizardProfile) => void;
  onRenameRequest: (name: string) => Promise<boolean>;
  onOpenDocument: (path: string) => void;
  onOpenWorkspaceFolder: (root: string) => Promise<void>;
  onRefreshModels: (provider: ProviderKind) => Promise<ModelInfo[]>;
  /** Update + persist favorites (same mechanism as Connection → Model in Settings). */
  onPresetPersist: (next: AppSettings) => Promise<void>;
  onSettingsChangeForFavorites: (next: AppSettings) => void;
  /** Opens the same system-prompt help as Settings → System Prompt (optional). */
  onOpenSystemPromptInfo?: () => void;
}

const providerOptions: Array<{ value: ProviderKind; label: string }> = [
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'ollama', label: 'Ollama' }
];

const pathLabel = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() ?? value;
const formatTokenEstimate = (tokens: number) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : tokens.toLocaleString();
const wizardDocumentPathKey = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');

function mergeWizardDocumentPreferences(fresh: WizardProfile['documents'], previous: WizardProfile['documents']) {
  const previousByPath = new Map(previous.map((doc) => [wizardDocumentPathKey(doc.path), doc]));
  return fresh.map((doc) => {
    const existing = previousByPath.get(wizardDocumentPathKey(doc.path));
    return { ...doc, autoInject: existing?.autoInject ?? doc.autoInject ?? true };
  });
}

export function WizardSettingsPanel({
  wizard,
  settings,
  modelOptions,
  statusMessage,
  onChange,
  onRenameRequest,
  onOpenDocument,
  onOpenWorkspaceFolder,
  onRefreshModels,
  onPresetPersist,
  onSettingsChangeForFavorites,
  onOpenSystemPromptInfo
}: WizardSettingsPanelProps) {
  const [localModels, setLocalModels] = useState<ModelInfo[]>(modelOptions);
  const [nameDraft, setNameDraft] = useState(wizard.name);
  const [markdownDocumentsExpanded, setMarkdownDocumentsExpanded] = useState(false);
  const [markdownTokenEstimate, setMarkdownTokenEstimate] = useState<{
    loading: boolean;
    tokens: number;
    readable: number;
    included: number;
    total: number;
  }>({ loading: true, tokens: 0, readable: 0, included: 0, total: 0 });

  useEffect(() => {
    setLocalModels(modelOptions);
  }, [modelOptions]);

  useEffect(() => {
    setNameDraft(wizard.name);
  }, [wizard.name]);

  const commitNameDraft = async () => {
    const next = nameDraft.trim();
    if (!next || next === wizard.name) {
      setNameDraft(wizard.name);
      return;
    }
    const accepted = await onRenameRequest(next);
    if (!accepted) {
      setNameDraft(wizard.name);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const docs = await window.electronAPI.listWizardDocuments(wizard.workspaceRoot);
        if (cancelled) return;
        const docsWithPreferences = mergeWizardDocumentPreferences(docs, wizard.documents);
        const prevKey = wizard.documents.map((d) => d.path).join('\0');
        const nextKey = docs.map((d) => d.path).join('\0');
        if (prevKey !== nextKey) {
          onChange({ ...wizard, documents: docsWithPreferences });
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

  useEffect(() => {
    let cancelled = false;
    const markdownDocs = wizard.documents.filter((doc) => /\.md$/i.test(doc.path));
    const includedDocs = markdownDocs.filter((doc) => doc.autoInject !== false);
    setMarkdownTokenEstimate((prev) => ({
      loading: includedDocs.length > 0,
      tokens: includedDocs.length > 0 ? prev.tokens : 0,
      readable: includedDocs.length > 0 ? prev.readable : 0,
      included: includedDocs.length,
      total: markdownDocs.length
    }));
    if (includedDocs.length === 0) return () => {
      cancelled = true;
    };

    void (async () => {
      let tokens = 0;
      let readable = 0;
      await Promise.all(
        includedDocs.map(async (doc) => {
          try {
            const file = await window.electronAPI.readWizardDocument(wizard.workspaceRoot, doc.path);
            tokens += roughTokensFromText(file.content);
            readable += 1;
          } catch {
            /* Ignore unreadable docs in the estimate; count stays visible. */
          }
        })
      );
      if (!cancelled) {
        setMarkdownTokenEstimate({
          loading: false,
          tokens,
          readable,
          included: includedDocs.length,
          total: markdownDocs.length
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wizard.documents, wizard.workspaceRoot]);

  const markdownDocumentCount = wizard.documents.filter((doc) => /\.md$/i.test(doc.path)).length;
  const includedMarkdownDocumentCount = wizard.documents.filter(
    (doc) => /\.md$/i.test(doc.path) && doc.autoInject !== false
  ).length;

  const toggleDocumentAutoInject = (path: string, autoInject: boolean) => {
    onChange({
      ...wizard,
      documents: wizard.documents.map((doc) =>
        wizardDocumentPathKey(doc.path) === wizardDocumentPathKey(path) ? { ...doc, autoInject } : doc
      )
    });
  };
  const hasTokenEstimateValue = markdownTokenEstimate.tokens > 0 || markdownTokenEstimate.readable > 0;
  const markdownTokenEstimateText =
    markdownTokenEstimate.loading && !hasTokenEstimateValue
      ? 'Calculating...'
      : `${formatTokenEstimate(markdownTokenEstimate.tokens)} tokens`;

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
            <input
              onBlur={() => void commitNameDraft()}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
                if (e.key === 'Escape') {
                  setNameDraft(wizard.name);
                  e.currentTarget.blur();
                }
              }}
              value={nameDraft}
            />
          </label>
          <button
            aria-label={`Open ${pathLabel(wizard.workspaceRoot)} in ${
              window.electronAPI.platform === 'darwin' ? 'Finder' : 'file explorer'
            }`}
            className="workspace-meta workspace-meta--settings"
            onClick={() => void onOpenWorkspaceFolder(wizard.workspaceRoot)}
            title={`Open ${wizard.workspaceRoot}`}
            type="button"
          >
            <div className="workspace-meta__value">{pathLabel(wizard.workspaceRoot)}</div>
            <div className="workspace-meta__hint">{wizard.workspaceRoot}</div>
          </button>
        </div>

        <div className="settings-section">
          <h4 className="settings-section__title">Model</h4>
          <div className="field">
            <span>Provider</span>
            <AppSelect
              onChange={async (provider) => {
                const fallbackModel = settings.providers[provider]?.model ?? '';
                setLocalModels([]);
                onChange({ ...wizard, provider, model: fallbackModel });
                try {
                  const list = await onRefreshModels(provider);
                  setLocalModels(list);
                  onChange({ ...wizard, provider, model: list[0]?.id ?? fallbackModel });
                } catch {
                  setLocalModels([]);
                }
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
                portalDropdown
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
          <div className="wizard-doc-token-meter">
            <div className="wizard-doc-token-meter__copy">
              <span>Markdown context estimate</span>
              <strong>{markdownTokenEstimateText}</strong>
            </div>
            <div className="wizard-doc-token-meter__meta">
              {markdownTokenEstimate.total === 0
                ? 'No Markdown documents found'
                : markdownTokenEstimate.loading
                  ? `${markdownTokenEstimate.included}/${markdownTokenEstimate.total} docs included`
                  : markdownTokenEstimate.included === 0
                    ? `0/${markdownTokenEstimate.total} docs included`
                    : `${markdownTokenEstimate.readable}/${markdownTokenEstimate.included} included docs readable (${markdownTokenEstimate.total} available)`}
            </div>
          </div>
          <div className={`chat-thread-options chat-thread-options--settings ${markdownDocumentsExpanded ? 'is-expanded' : ''}`}>
            <button
              className="chat-thread-options__header"
              onClick={() => setMarkdownDocumentsExpanded((v) => !v)}
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
                <span className="chat-thread-options__title">Markdown documents</span>
              </span>
              {!markdownDocumentsExpanded ? (
                <span className="chat-thread-options__badge">
                  {includedMarkdownDocumentCount}/{markdownDocumentCount} docs
                </span>
              ) : null}
            </button>

            <AnimatePresence initial={false}>
              {markdownDocumentsExpanded ? (
                <motion.div
                  key="wizard-markdown-documents"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                  style={{ overflow: 'hidden' }}
                >
                  <div className="chat-thread-options__body">
                    <div className="wizard-doc-list">
                      {wizard.documents.map((doc) => (
                        <div
                          className={`wizard-doc-list__item ${doc.autoInject !== false ? 'is-included' : 'is-excluded'}`}
                          key={doc.path}
                        >
                          <label className="wizard-doc-list__toggle">
                            <input
                              checked={doc.autoInject !== false}
                              onChange={(e) => toggleDocumentAutoInject(doc.path, e.target.checked)}
                              type="checkbox"
                            />
                            <span className="wizard-doc-list__text">
                              <span>{doc.label}</span>
                              <small>{doc.autoInject !== false ? 'Auto-injected' : 'Not injected'}</small>
                            </span>
                            <code>{doc.path.split(/[\\/]/).pop()}</code>
                          </label>
                          <button
                            className="wizard-doc-list__open"
                            onClick={() => onOpenDocument(doc.path)}
                            title={`Open ${doc.path}`}
                            type="button"
                          >
                            Open
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
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
          <label className={`toggle-row toggle-row--warning ${wizard.allowOutsideWorkspace ? 'is-active' : ''}`}>
            <span>Allow paths outside workspace</span>
            <input
              checked={Boolean(wizard.allowOutsideWorkspace)}
              onChange={(e) => onChange({ ...wizard, allowOutsideWorkspace: e.target.checked })}
              type="checkbox"
            />
          </label>
          <div className="inline-hint inline-hint--warning">
            When on, read/write/replace/rename/delete/outline tools may use ../ or absolute paths elsewhere on this Mac
            (cloud-sync locations remain blocked). list_files, symbol search, apply_patch, git diff, and shell cwd stay
            inside this Wizard folder—copy files here if they need listing or patching.
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section__title-cluster">
            <h4 className="settings-section__title settings-section__title--cluster">System Prompt</h4>
            {onOpenSystemPromptInfo ? (
              <button
                aria-label="About system prompts and presets"
                className="settings-info-button"
                onClick={onOpenSystemPromptInfo}
                title="Tips for system prompts"
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                  <path d="M12 16v-4.5M12 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            ) : null}
          </div>
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

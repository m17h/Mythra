import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { defaultSettings, type AppSettings, type ModelInfo, type ProviderKind, type WizardSetupRequest } from '@shared/types';
import { AppSelect } from './AppSelect';
import { ModelSearch } from './ModelSearch';

interface WizardSetupModalProps {
  open: boolean;
  settings: AppSettings | null;
  onClose: () => void;
  onCreate: (request: WizardSetupRequest) => Promise<void>;
  onListModels: (provider: ProviderKind) => Promise<ModelInfo[]>;
}

const providerOptions: Array<{ value: ProviderKind; label: string }> = [
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'openrouter', label: 'OpenRouter' }
];

const defaultPrompt = (name: string) => `You are ${name || 'this Wizard'}, a persistent OpenKiwi Wizard.

Use your private workspace as your long-term home base:
- soul.md defines your identity, style, values, and boundaries.
- tools.md defines tool preferences, workflows, and project conventions.
- memory.md stores durable facts the user wants you to remember.
- corrections.md stores mistakes, corrections, and lessons learned.

Before making important decisions, read the relevant core documents. Keep your memory and corrections current when the user teaches you something durable. Work in Agent behavior by default: inspect files, use tools deliberately, and be explicit about what changed.

At the start of every new session, read soul.md, tools.md, memory.md, and corrections.md before giving your first substantive response.`;

export function WizardSetupModal({ open, settings, onClose, onCreate, onListModels }: WizardSetupModalProps) {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<ProviderKind>('lmstudio');
  const [model, setModel] = useState('');
  const [modelOptions, setModelOptions] = useState<ModelInfo[]>([]);
  const [workspaceMode, setWorkspaceMode] = useState<'desktop' | 'choose'>('desktop');
  const [chosenWorkspace, setChosenWorkspace] = useState('');
  const [recommendedWorkspace, setRecommendedWorkspace] = useState('');
  const [customDocsRaw, setCustomDocsRaw] = useState('');
  const [prompt, setPrompt] = useState(defaultPrompt(''));
  const [promptDirty, setPromptDirty] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName('');
    setProvider(settings?.selectedProvider ?? 'lmstudio');
    setModel('');
    setModelOptions([]);
    setWorkspaceMode('desktop');
    setChosenWorkspace('');
    setRecommendedWorkspace('');
    setCustomDocsRaw('');
    setPrompt(defaultPrompt(''));
    setPromptDirty(false);
    setError('');
  }, [open, settings?.selectedProvider]);

  useEffect(() => {
    if (!open) return;
    const trimmed = name.trim();
    if (!promptDirty) setPrompt(defaultPrompt(trimmed));
    if (!trimmed) {
      setRecommendedWorkspace('');
      return;
    }
    void window.electronAPI.getRecommendedWizardWorkspace(trimmed).then(setRecommendedWorkspace);
  }, [name, open, promptDirty]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingModels(true);
    void onListModels(provider)
      .then((list) => {
        if (cancelled) return;
        setModelOptions(list);
        setModel((current) => (current && list.some((item) => item.id === current) ? current : (list[0]?.id ?? '')));
      })
      .catch((e) => {
        if (cancelled) return;
        setModelOptions([]);
        setModel('');
        setError(e instanceof Error ? e.message : 'Could not load models.');
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onListModels, open, provider]);

  const customDocuments = useMemo(
    () =>
      customDocsRaw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    [customDocsRaw]
  );

  const canCreate = Boolean(name.trim() && model.trim() && (workspaceMode === 'desktop' || chosenWorkspace.trim()));

  const chooseFolder = async () => {
    setError('');
    const picked = await window.electronAPI.chooseWizardWorkspace(name.trim() || 'OpenKiwi Wizard');
    if (picked) {
      setWorkspaceMode('choose');
      setChosenWorkspace(picked);
    }
  };

  const submit = async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    setError('');
    try {
      await onCreate({
        name: name.trim(),
        provider,
        model,
        systemPrompt: prompt,
        createOnDesktop: workspaceMode === 'desktop',
        workspaceRoot: workspaceMode === 'choose' ? chosenWorkspace : undefined,
        customDocuments
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create Wizard.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          animate={{ opacity: 1 }}
          className="app-dialog-backdrop"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          role="presentation"
        >
          <motion.div
            aria-modal="true"
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="app-dialog app-dialog--scrollable wizard-setup"
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            role="dialog"
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <div className="app-dialog__kicker">New Wizard</div>
            <h3>Create a Wizard</h3>
            <p>A Wizard is a named AI with its own model, local workspace, memory documents, and system prompt.</p>

            <div className="wizard-setup__grid">
              <label className="field">
                <span>Name</span>
                <input onChange={(e) => setName(e.target.value)} placeholder="Luna" value={name} />
              </label>

              <label className="field">
                <span>Provider</span>
                <AppSelect options={providerOptions} onChange={setProvider} value={provider} portalDropdown />
              </label>

              <div className="field wizard-setup__wide">
                <span>Model</span>
                {modelOptions.length ? (
                  <ModelSearch
                    favoriteIds={settings?.ui.favoriteModels?.[provider] ?? defaultSettings.ui.favoriteModels[provider]}
                    models={modelOptions}
                    onChange={(next) => setModel(next)}
                    onToggleFavorite={() => undefined}
                    value={model}
                    portalDropdown
                  />
                ) : (
                  <input
                    disabled
                    placeholder={loadingModels ? 'Loading models...' : 'No models available'}
                    value=""
                    readOnly
                  />
                )}
              </div>

              <div className="wizard-setup__wide wizard-setup__choice-block">
                <div className="field">
                  <span>Workspace</span>
                  <div className="wizard-setup__workspace-actions">
                    <button
                      className={`btn btn--secondary ${workspaceMode === 'desktop' ? 'is-selected' : ''}`}
                      onClick={() => setWorkspaceMode('desktop')}
                      type="button"
                    >
                      Create on Desktop
                    </button>
                    <button className="btn btn--secondary" onClick={chooseFolder} type="button">
                      Choose folder
                    </button>
                  </div>
                </div>
                <div className="inline-hint">
                  {workspaceMode === 'desktop'
                    ? recommendedWorkspace || 'Enter a name to preview the recommended local folder.'
                    : chosenWorkspace || 'Choose a local folder. Cloud-synced folders are blocked.'}
                </div>
              </div>

              <label className="field wizard-setup__wide">
                <span>Custom Documents</span>
                <textarea
                  onChange={(e) => setCustomDocsRaw(e.target.value)}
                  placeholder={'Optional. One Markdown document per line.\nprojects.md\npreferences.md'}
                  rows={3}
                  value={customDocsRaw}
                />
              </label>

              <label className="field wizard-setup__wide">
                <span>System Prompt</span>
                <textarea
                  onChange={(e) => {
                    setPromptDirty(true);
                    setPrompt(e.target.value);
                  }}
                  rows={8}
                  value={prompt}
                />
              </label>
            </div>

            <div className="wizard-setup__docs">
              <span>Core documents created automatically</span>
              <div>
                <code>soul.md</code>
                <code>tools.md</code>
                <code>memory.md</code>
                <code>corrections.md</code>
              </div>
            </div>

            {error ? <div className="inline-hint inline-hint--warning">{error}</div> : null}

            <div className="app-dialog__actions">
              <button className="btn btn--secondary" disabled={creating} onClick={onClose} type="button">
                Cancel
              </button>
              <button className="btn btn--primary" disabled={!canCreate || creating} onClick={submit} type="button">
                {creating ? 'Creating...' : 'Create Wizard'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

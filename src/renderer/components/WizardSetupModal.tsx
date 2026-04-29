import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { defaultSettings, type AppSettings, type ModelInfo, type ProviderKind, type WizardSetupRequest } from '@shared/types';
import { sanitizeWizardFolderSegment } from '@shared/wizard-folder';
import { AppSelect } from './AppSelect';
import { ModelSearch } from './ModelSearch';

interface WizardSetupModalProps {
  open: boolean;
  settings: AppSettings | null;
  onClose: () => void;
  onCreate: (request: WizardSetupRequest) => Promise<void>;
  onListModels: (provider: ProviderKind) => Promise<ModelInfo[]>;
  /** Persist the chosen parent folder so new Wizards keep using it until changed. */
  onPersistWizardProjectsParentFolder: (absoluteFolderPath: string) => Promise<void>;
}

const providerOptions: Array<{ value: ProviderKind; label: string }> = [
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'openrouter', label: 'OpenRouter' }
];

/** Preferred default when creating a Wizard (OpenRouter catalog id: Gemini 3.1 Flash Lite Preview). */
const WIZARD_SETUP_DEFAULT_MODEL_ID = 'google/gemini-3.1-flash-lite-preview';

const defaultPrompt = (name: string) => `You are ${name || 'this Wizard'}, a persistent OpenKiwi Wizard.

Use your private workspace as your long-term home base:
- soul.md defines your identity, style, values, and boundaries.
- tools.md defines tool preferences, workflows, and project conventions.
- memory.md stores durable facts the user wants you to remember.
- corrections.md stores mistakes, corrections, and lessons learned.

Before making important decisions, read the relevant core documents. Keep your memory and corrections current when the user teaches you something durable. Work in Agent behavior by default: inspect files, use tools deliberately, and be explicit about what changed.

At the start of every new session, read soul.md, tools.md, memory.md, and corrections.md before giving your first substantive response.`;

function previewWizardWorkspacePath(platform: string, parentFolder: string, wizardDisplayName: string): string {
  const segment = sanitizeWizardFolderSegment(wizardDisplayName);
  if (!segment) return '';
  const base = parentFolder.trim().replace(/[/\\]+$/, '');
  if (!base) return segment;
  const sep = platform === 'win32' ? '\\' : '/';
  return `${base}${sep}${segment}`;
}

export function WizardSetupModal({
  open,
  settings,
  onClose,
  onCreate,
  onListModels,
  onPersistWizardProjectsParentFolder
}: WizardSetupModalProps) {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<ProviderKind>('openrouter');
  const [model, setModel] = useState('');
  const [modelOptions, setModelOptions] = useState<ModelInfo[]>([]);
  /** Absolute path of the folder that will contain one subfolder per Wizard. */
  const [wizardProjectsParentFolder, setWizardProjectsParentFolder] = useState('');
  /** Same source as sidebar “reopen last workspace”; seeds the folder picker when no parent is saved yet. */
  const [lastValidWorkspaceRoot, setLastValidWorkspaceRoot] = useState<string | null>(null);
  const [customDocsRaw, setCustomDocsRaw] = useState('');
  const [prompt, setPrompt] = useState(defaultPrompt(''));
  const [promptDirty, setPromptDirty] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName('');
    setProvider('openrouter');
    setModel('');
    setModelOptions([]);
    setWizardProjectsParentFolder(settings?.ui?.wizardProjectsParentFolder?.trim() ?? '');
    setCustomDocsRaw('');
    setPrompt(defaultPrompt(''));
    setPromptDirty(false);
    setError('');
    void window.electronAPI.getLastValidWorkspaceRoot().then(setLastValidWorkspaceRoot);
    // Intentionally only when `open` toggles — avoid resetting the form when parent-folder preference saves mid-modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- settings read once when the dialog opens
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = name.trim();
    if (!promptDirty) setPrompt(defaultPrompt(trimmed));
  }, [name, open, promptDirty]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingModels(true);
    void onListModels(provider)
      .then((list) => {
        if (cancelled) return;
        setModelOptions(list);
        setModel((current) => {
          if (current && list.some((item) => item.id === current)) return current;
          const preferred = list.find((item) => item.id === WIZARD_SETUP_DEFAULT_MODEL_ID);
          return preferred?.id ?? list[0]?.id ?? '';
        });
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

  const workspacePreview = useMemo(
    () => previewWizardWorkspacePath(window.electronAPI.platform, wizardProjectsParentFolder, name),
    [wizardProjectsParentFolder, name]
  );

  const canCreate = Boolean(name.trim() && model.trim() && wizardProjectsParentFolder.trim());

  const chooseProjectsFolder = async () => {
    setError('');
    const hint = wizardProjectsParentFolder.trim() || lastValidWorkspaceRoot || undefined;
    const picked = await window.electronAPI.chooseWizardProjectsFolder(hint);
    if (!picked) return;
    setWizardProjectsParentFolder(picked);
    try {
      await onPersistWizardProjectsParentFolder(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save Wizards folder preference.');
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
        workspaceRoot: wizardProjectsParentFolder.trim(),
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
                  <span>Wizards folder</span>
                  <div className="wizard-setup__workspace-actions">
                    <button className="btn btn--secondary" onClick={() => void chooseProjectsFolder()} type="button">
                      Choose folder…
                    </button>
                  </div>
                </div>
                <div className="inline-hint">
                  Pick one folder that will hold every Wizard&apos;s workspace. Each Wizard is created as a subfolder named
                  from its title (sanitized). Two Wizards cannot use the same folder name here unless you choose a
                  different Wizards folder later.
                </div>
                {wizardProjectsParentFolder ? (
                  <div className="inline-hint">
                    <strong>Parent:</strong> {wizardProjectsParentFolder}
                  </div>
                ) : (
                  <div className="inline-hint">Choose a local folder (cloud-synced paths are blocked).</div>
                )}
                {workspacePreview ? (
                  <div className="inline-hint">
                    <strong>This Wizard:</strong> <code>{workspacePreview}</code>
                  </div>
                ) : null}
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

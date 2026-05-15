import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import {
  defaultSettings,
  type AppSettings,
  type ModelInfo,
  type ProviderKind,
  type WizardMythwizImportedPayload,
  type WizardSetupRequest
} from '@shared/types';
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
  /** Same as Wizard / Connection model picker: update in-memory settings when favoriting. */
  onSettingsChangeForFavorites?: (next: AppSettings) => void;
  /** Persist favorites immediately (survive restart). */
  onPresetPersist?: (next: AppSettings) => Promise<void>;
}

const providerOptions: Array<{ value: ProviderKind; label: string }> = [
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'ollama', label: 'Ollama' }
];

/** Preferred default when creating a Wizard (OpenRouter catalog id: Gemini 3.1 Flash Lite Preview). */
const WIZARD_SETUP_DEFAULT_MODEL_ID = 'google/gemini-3.1-flash-lite-preview';

const ONBOARDING_SYSTEM_TAIL =
  '\n\nSoul.md and memory.md were seeded from your onboarding answers where you provided them. Keep those files authoritative—use write_file when personality or remembered facts change.\n';

const defaultPrompt = (name: string) => `You are ${name || 'this Wizard'}, a persistent Mythra Wizard.

Use your private workspace as your long-term home base:
- soul.md defines your identity, style, values, and boundaries.
- tools.md defines tool preferences, workflows, and project conventions.
- memory.md stores durable facts the user wants you to remember.
- corrections.md stores mistakes, corrections, and lessons learned.
- Mythra only seeds those four core files—not todo.md or other defaults. Add task lists or extra guides as new .md files if the user wants them.
- File paths default to your workspace folder only; enable **Allow paths outside workspace** in Inspector → Wizard settings if cross-folder reads/writes are needed (local disks only).

Before making important decisions, read the relevant core documents. Keep your memory and corrections current when the user teaches you something durable. Work in Agent behavior by default: inspect files, use tools deliberately, and be explicit about what changed.

Good fits for a Wizard include: learning the user’s writing style, maintaining a structured note system in this folder, specializing in one codebase or topic, or running recurring research/meeting workflows—help the user shape that in soul.md and extra markdown.

At the start of every message in a Wizard chat, Mythra injects every Markdown (.md) file from your workspace into context (core docs first). Keep extra guides or notes as additional .md files if you want them always loaded.`;

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
  onPersistWizardProjectsParentFolder,
  onSettingsChangeForFavorites,
  onPresetPersist
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
  const [setupStep, setSetupStep] = useState<1 | 2>(1);
  const [personalityNotes, setPersonalityNotes] = useState('');
  const [memoryNotes, setMemoryNotes] = useState('');
  const [importedMythwiz, setImportedMythwiz] = useState<WizardMythwizImportedPayload | null>(null);

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
    setSetupStep(1);
    setPersonalityNotes('');
    setMemoryNotes('');
    setImportedMythwiz(null);
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

  const pickImportMythwiz = async () => {
    setError('');
    const result = await window.electronAPI.chooseWizardImportMythwiz();
    if (!result.ok) {
      if ('cancelled' in result && result.cancelled) return;
      setError('error' in result ? result.error : 'Could not import bundle.');
      return;
    }
    const data = result.data;
    setImportedMythwiz(data);
    setSetupStep(1);
    const displayName = data.wizardDisplayName.trim();
    setName(displayName);
    const promptFromBundle = data.systemPrompt.trim();
    if (promptFromBundle.length > 0) {
      setPrompt(promptFromBundle);
      setPromptDirty(true);
    } else {
      setPromptDirty(false);
    }
    setPersonalityNotes('');
    setMemoryNotes('');
    setCustomDocsRaw('');
  };

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
    const finishFromBasicsOnly = Boolean(importedMythwiz);
    if ((!finishFromBasicsOnly && setupStep !== 2) || !canCreate || creating) return;
    setCreating(true);
    setError('');
    const seeded =
      !importedMythwiz &&
      (personalityNotes.trim().length > 0 || memoryNotes.trim().length > 0);
    const systemPromptFinal = seeded ? `${prompt.trimEnd()}${ONBOARDING_SYSTEM_TAIL}` : prompt;
    const mythwizWorkspaceFiles =
      importedMythwiz && importedMythwiz.workspaceFiles.length > 0
        ? importedMythwiz.workspaceFiles
        : undefined;
    try {
      await onCreate({
        name: name.trim(),
        provider,
        model,
        systemPrompt: systemPromptFinal,
        workspaceRoot: wizardProjectsParentFolder.trim(),
        customDocuments,
        wizardPersonality: personalityNotes.trim() || undefined,
        wizardMemory: memoryNotes.trim() || undefined,
        mythwizWorkspaceFiles
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create Wizard.');
    } finally {
      setCreating(false);
    }
  };

  const goToPersonalityStep = () => {
    if (!canCreate) return;
    setError('');
    setSetupStep(2);
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          animate={{ opacity: 1 }}
          className="app-dialog-backdrop"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          onClick={() => {
            if (!creating) onClose();
          }}
          role="presentation"
        >
          <motion.div
            aria-modal="true"
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="app-dialog app-dialog--scrollable wizard-setup"
            onClick={(e) => e.stopPropagation()}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            role="dialog"
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <div className="wizard-setup__topbar">
              <div className="app-dialog__kicker">New Wizard</div>
              <button
                className="btn btn--secondary wizard-setup__import-btn"
                disabled={creating}
                onClick={() => void pickImportMythwiz()}
                type="button"
              >
                Import Wizard
              </button>
            </div>
            {importedMythwiz ? null : (
              <div className="wizard-setup__steps" role="tablist" aria-label="Wizard setup steps">
                <span className={setupStep === 1 ? 'is-active' : ''}>1 Basics</span>
                <span aria-hidden>→</span>
                <span className={setupStep === 2 ? 'is-active' : ''}>2 Personality &amp; memory</span>
              </div>
            )}

            {importedMythwiz ? (
              <div className="wizard-setup__import-note">
                Bundle loaded from disk.
                {importedMythwiz.workspaceFiles.length > 0 ? (
                  <>
                    {' '}
                    {importedMythwiz.workspaceFiles.length} workspace file(s) will overwrite matching paths after the usual
                    scaffold is created.
                  </>
                ) : (
                  <> Only the system prompt was imported from this bundle (if present). Mythra still creates default core Markdown docs.</>
                )}{' '}
                Personality and memory come from the imported workspace files — edit those docs later if you want changes.
                Adjust name, provider, and model here, then create.
              </div>
            ) : null}

            {setupStep === 1 ? (
              <>
                <h3>{importedMythwiz ? 'Finish importing Wizard' : 'Create a Wizard'}</h3>
                <p>
                  {importedMythwiz
                    ? 'Pick provider, model, and where to store this Wizard’s workspace. Imported bundle content is applied when you create.'
                    : 'A Wizard is a named AI with its own model, local workspace, memory documents, and system prompt.'}
                </p>

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
                        onToggleFavorite={(id) => {
                          if (!settings || !onSettingsChangeForFavorites || !onPresetPersist) return;
                          const k = provider;
                          const baseFav = settings.ui.favoriteModels ?? defaultSettings.ui.favoriteModels;
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
              </>
            ) : (
              <>
                <h3>Personality &amp; memory</h3>
                <p>
                  Describe how this Wizard should behave and what it should remember long-term. Your answers seed{' '}
                  <code>soul.md</code> and <code>memory.md</code> in its workspace. You can refine them anytime in the editor or
                  ask the Wizard to update them in chat (Agent mode).
                </p>

                <div className="wizard-setup__grid">
                  <label className="field wizard-setup__wide">
                    <span>Personality &amp; style</span>
                    <textarea
                      onChange={(e) => setPersonalityNotes(e.target.value)}
                      placeholder="Tone, values, boundaries, how formal or playful to be, topics to emphasize or avoid…"
                      rows={5}
                      value={personalityNotes}
                    />
                  </label>

                  <label className="field wizard-setup__wide">
                    <span>Things to remember</span>
                    <textarea
                      onChange={(e) => setMemoryNotes(e.target.value)}
                      placeholder="Names, preferences, ongoing projects, facts you want kept across sessions…"
                      rows={5}
                      value={memoryNotes}
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
              </>
            )}

            {error ? <div className="inline-hint inline-hint--warning">{error}</div> : null}

            <div className="app-dialog__actions">
              <button className="btn btn--secondary" disabled={creating} onClick={onClose} type="button">
                Cancel
              </button>
              {setupStep === 1 ? (
                importedMythwiz ? (
                  <button
                    className="btn btn--primary"
                    disabled={!canCreate || creating}
                    onClick={() => void submit()}
                    type="button"
                  >
                    {creating ? 'Creating...' : 'Create Wizard'}
                  </button>
                ) : (
                  <button className="btn btn--primary" disabled={!canCreate || creating} onClick={goToPersonalityStep} type="button">
                    Next
                  </button>
                )
              ) : (
                <>
                  <button className="btn btn--secondary" disabled={creating} onClick={() => setSetupStep(1)} type="button">
                    Back
                  </button>
                  <button className="btn btn--primary" disabled={!canCreate || creating} onClick={() => void submit()} type="button">
                    {creating ? 'Creating...' : 'Create Wizard'}
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

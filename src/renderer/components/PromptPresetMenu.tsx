import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProviderProfile, SavedPromptPreset } from '@shared/types';
import { AppConfirmDialog } from './AppConfirmDialog';

const uid = () => Math.random().toString(36).slice(2, 11);

function nextPresetName(list: SavedPromptPreset[]) {
  return `Preset ${list.length + 1}`;
}

function savedBaselineForProvider(provider: ProviderProfile): string {
  if (!provider.activePromptPresetId) return '';
  const row = provider.promptPresets.find((x) => x.id === provider.activePromptPresetId);
  return row?.prompt ?? '';
}

function isPromptDirty(provider: ProviderProfile): boolean {
  return provider.systemPrompt !== savedBaselineForProvider(provider);
}

/** Main trigger label: Draft while textarea differs from saved preset (or non-empty “empty” slot). */
function presetBarLabel(provider: ProviderProfile): string {
  if (isPromptDirty(provider)) return 'Draft';
  if (!provider.activePromptPresetId) return 'Empty';
  const row = provider.promptPresets.find((x) => x.id === provider.activePromptPresetId);
  return row?.name ?? 'Empty';
}

export type PresetPatchOptions = { persist?: boolean };

interface PromptPresetMenuProps {
  provider: ProviderProfile;
  onPatch: (patch: Partial<ProviderProfile>, opts?: PresetPatchOptions) => void;
}

export function PromptPresetMenu({ provider, onPatch }: PromptPresetMenuProps) {
  const [mainOpen, setMainOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** In-app name step — `window.prompt` is unreliable in Electron. */
  const [nameForNewOpen, setNameForNewOpen] = useState(false);
  const [nameForNewDraft, setNameForNewDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const deleteTargetRef = useRef<{ id: string; name: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newPresetNameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!mainOpen) {
      setNameForNewOpen(false);
    }
  }, [mainOpen]);

  useLayoutEffect(() => {
    if (!nameForNewOpen) return;
    newPresetNameInputRef.current?.focus();
    newPresetNameInputRef.current?.select();
  }, [nameForNewOpen]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      setMainOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const createNewPreset = () => {
    const newPreset: SavedPromptPreset = {
      id: uid(),
      name: nextPresetName(provider.promptPresets),
      prompt: '',
      updatedAt: Date.now()
    };
    onPatch(
      {
        activePromptPresetId: newPreset.id,
        systemPrompt: '',
        promptPresets: [...provider.promptPresets, newPreset]
      },
      { persist: true }
    );
    setMainOpen(false);
  };

  const loadPreset = (id: string) => {
    const p = provider.promptPresets.find((c) => c.id === id);
    if (!p) return;
    onPatch({ activePromptPresetId: id, systemPrompt: p.prompt });
    setMainOpen(false);
  };

  const openNameForNewPreset = () => {
    setNameForNewOpen(true);
    setNameForNewDraft(nextPresetName(provider.promptPresets));
  };

  const commitNewNamedPreset = () => {
    const t = nameForNewDraft.trim() || 'Untitled';
    const newPreset: SavedPromptPreset = {
      id: uid(),
      name: t,
      prompt: provider.systemPrompt,
      updatedAt: Date.now()
    };
    onPatch(
      {
        activePromptPresetId: newPreset.id,
        promptPresets: [...provider.promptPresets, newPreset]
      },
      { persist: true }
    );
    setNameForNewOpen(false);
    setMainOpen(false);
  };

  const cancelNameForNewPreset = () => {
    setNameForNewOpen(false);
  };

  const savePresetFromEditor = () => {
    if (provider.activePromptPresetId) {
      const id = provider.activePromptPresetId;
      onPatch(
        {
          promptPresets: provider.promptPresets.map((c) =>
            c.id === id ? { ...c, prompt: provider.systemPrompt, updatedAt: Date.now() } : c
          )
        },
        { persist: true }
      );
      return;
    }
    openNameForNewPreset();
  };

  const beginDeletePreset = (id: string, name: string) => {
    const payload = { id, name };
    deleteTargetRef.current = payload;
    setDeleteTarget(payload);
  };

  const cancelDeletePreset = () => {
    setDeleteTarget(null);
  };

  const confirmDeletePreset = () => {
    const t = deleteTarget ?? deleteTargetRef.current;
    if (!t) return;
    setDeleteTarget(null);
    setRenamingId(null);
    const next = provider.promptPresets.filter((c) => c.id !== t.id);
    const patch: Partial<ProviderProfile> = { promptPresets: next };
    if (provider.activePromptPresetId === t.id) {
      patch.activePromptPresetId = null;
    }
    onPatch(patch, { persist: true });
  };

  const deleteLabelCopy = deleteTarget ?? deleteTargetRef.current;

  const startRename = (c: SavedPromptPreset) => {
    setRenamingId(c.id);
    setRenameDraft(c.name);
    queueMicrotask(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  };

  const commitRename = (id: string) => {
    const t = renameDraft.trim();
    if (t) {
      onPatch(
        {
          promptPresets: provider.promptPresets.map((c) =>
            c.id === id ? { ...c, name: t, updatedAt: Date.now() } : c
          )
        },
        { persist: true }
      );
    }
    setRenamingId(null);
  };

  const cancelRename = () => {
    setRenamingId(null);
  };

  const sortedPresets = [...provider.promptPresets].sort((a, b) => b.updatedAt - a.updatedAt);

  const dirty = isPromptDirty(provider);
  const showQuickSave = dirty && !nameForNewOpen;

  const runQuickSave = () => {
    if (provider.activePromptPresetId) {
      savePresetFromEditor();
      setMainOpen(false);
      return;
    }
    setMainOpen(true);
    openNameForNewPreset();
  };

  return (
    <>
      <div className="prompt-preset-menu" ref={rootRef}>
        <div className="prompt-preset-menu__bar">
          <button
            aria-expanded={mainOpen}
            aria-haspopup="listbox"
            className="prompt-preset-menu__button"
            onClick={() => setMainOpen((o) => !o)}
            type="button"
          >
            <span className="prompt-preset-menu__button-text">{presetBarLabel(provider)}</span>
            <span className="prompt-preset-menu__button-caret" aria-hidden>
              {mainOpen ? '▲' : '▼'}
            </span>
          </button>
          {showQuickSave ? (
            <button
              aria-label={provider.activePromptPresetId ? 'Save changes to the active preset' : 'Save as a new preset'}
              className="prompt-preset-menu__quick-save"
              onClick={(e) => {
                e.stopPropagation();
                runQuickSave();
              }}
              type="button"
            >
              Save
            </button>
          ) : null}
        </div>

        {mainOpen ? (
          <div className="prompt-preset-menu__dropdown" role="listbox">
            {nameForNewOpen ? (
              <div className="prompt-preset-menu__name-wizard" onKeyDown={(e) => e.stopPropagation()}>
                <div className="prompt-preset-menu__name-wizard-title">Name this preset</div>
                <input
                  className="prompt-preset-menu__name-wizard-input"
                  onChange={(e) => setNameForNewDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitNewNamedPreset();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelNameForNewPreset();
                    }
                  }}
                  placeholder="e.g. Workspace agent v2"
                  ref={newPresetNameInputRef}
                  type="text"
                  value={nameForNewDraft}
                />
                <div className="prompt-preset-menu__name-wizard-actions">
                  <button
                    className="prompt-preset-menu__name-wizard-btn prompt-preset-menu__name-wizard-btn--primary"
                    onClick={commitNewNamedPreset}
                    type="button"
                  >
                    Save
                  </button>
                  <button
                    className="prompt-preset-menu__name-wizard-btn"
                    onClick={cancelNameForNewPreset}
                    type="button"
                  >
                    Back
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button className="prompt-preset-menu__item" onClick={createNewPreset} type="button">
                  New preset…
                </button>
                <button
                  className="prompt-preset-menu__item"
                  disabled={!provider.activePromptPresetId}
                  onClick={savePresetFromEditor}
                  title={
                    provider.activePromptPresetId
                      ? 'Save the prompt box into the active preset'
                      : 'Select a preset to overwrite, or use Save as new…'
                  }
                  type="button"
                >
                  Save
                </button>
                <button className="prompt-preset-menu__item" onClick={openNameForNewPreset} type="button">
                  Save as new…
                </button>
                {sortedPresets.length > 0 ? (
                  <>
                    <div className="prompt-preset-menu__flyout-sep" role="separator" />
                    {sortedPresets.map((c) => (
                      <div className="prompt-preset-menu__flyout-row" key={c.id}>
                        {renamingId === c.id ? (
                          <input
                            className="prompt-preset-menu__flyout-rename prompt-preset-menu__flyout-rename--full"
                            onBlur={() => commitRename(c.id)}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.currentTarget.blur();
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelRename();
                              }
                            }}
                            ref={renameInputRef}
                            value={renameDraft}
                          />
                        ) : (
                          <button
                            className={`prompt-preset-menu__flyout-item prompt-preset-menu__flyout-item--row ${
                              provider.activePromptPresetId === c.id ? 'is-active' : ''
                            }`}
                            onClick={() => loadPreset(c.id)}
                            title={c.name}
                            type="button"
                          >
                            <span className="prompt-preset-menu__flyout-name">{c.name}</span>
                          </button>
                        )}
                        {renamingId === c.id ? null : (
                          <div className="prompt-preset-menu__flyout-tools">
                            <button
                              className="prompt-preset-menu__icon-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                startRename(c);
                              }}
                              title="Rename"
                              type="button"
                            >
                              <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden>
                                <path
                                  d="M7.5 1.2L1.2 7.5v2.1h2.1l6.3-6.3L7.5 1.2zM1.5 8.6v-1.2L7.5 1.1l1.1 1.1-6.1 6.1H1.5v.2z"
                                  fill="currentColor"
                                />
                              </svg>
                            </button>
                            <button
                              className="prompt-preset-menu__icon-btn prompt-preset-menu__icon-btn--danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                beginDeletePreset(c.id, c.name);
                              }}
                              title="Delete"
                              type="button"
                            >
                              <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden>
                                <path
                                  d="M2 3h8M4.5 3V2a1 1 0 011-1h1a1 1 0 011 1v1M5 5.5v3M7 5.5v3M3 3l.5 7a1 1 0 001 1h3a1 1 0 001-1L9 3"
                                  stroke="currentColor"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth="1.1"
                                />
                              </svg>
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
      <AppConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Delete"
        confirmVariant="danger"
        description={
          deleteLabelCopy ? (
            <>
              Delete <strong>{deleteLabelCopy.name}</strong>? This cannot be undone.
            </>
          ) : null
        }
        kicker="Preset"
        open={deleteTarget != null}
        title="Delete preset?"
        onCancel={cancelDeletePreset}
        onConfirm={confirmDeletePreset}
      />
    </>
  );
}

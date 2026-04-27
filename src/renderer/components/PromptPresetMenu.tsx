import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CustomPromptPreset, ProviderProfile } from '@shared/types';
import { getPromptPreset, promptPresets } from '@shared/prompt-presets';

const uid = () => Math.random().toString(36).slice(2, 11);

function nextCustomName(list: CustomPromptPreset[]) {
  return `My preset ${list.length + 1}`;
}

function buttonLabel(provider: ProviderProfile) {
  if (provider.promptPresetId !== 'custom') return getPromptPreset(provider.promptPresetId).label;
  if (provider.activeCustomPresetId) {
    const c = provider.customPromptPresets.find((x) => x.id === provider.activeCustomPresetId);
    if (c) return `Custom · ${c.name}`;
  }
  return 'Custom';
}

export type PresetPatchOptions = { persist?: boolean };

interface PromptPresetMenuProps {
  provider: ProviderProfile;
  onPatch: (patch: Partial<ProviderProfile>, opts?: PresetPatchOptions) => void;
}

const FLYOUT_W = 292;

export function PromptPresetMenu({ provider, onPatch }: PromptPresetMenuProps) {
  const [mainOpen, setMainOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** In-app name step — `window.prompt` is unreliable in Electron. */
  const [nameForNewOpen, setNameForNewOpen] = useState(false);
  const [nameForNewDraft, setNameForNewDraft] = useState('');
  const [flyoutPos, setFlyoutPos] = useState({ top: 0, left: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const customBtnRef = useRef<HTMLButtonElement>(null);
  const subCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newPresetNameInputRef = useRef<HTMLInputElement>(null);

  const clearSubCloseTimer = () => {
    if (subCloseTimer.current) {
      clearTimeout(subCloseTimer.current);
      subCloseTimer.current = null;
    }
  };

  const scheduleSubClose = () => {
    clearSubCloseTimer();
    subCloseTimer.current = setTimeout(() => setSubOpen(false), 220);
  };

  const openSub = () => {
    clearSubCloseTimer();
    setSubOpen(true);
  };

  useEffect(
    () => () => {
      clearSubCloseTimer();
    },
    []
  );

  useEffect(() => {
    if (!mainOpen) {
      setSubOpen(false);
      setNameForNewOpen(false);
    }
  }, [mainOpen]);

  useLayoutEffect(() => {
    if (!nameForNewOpen) return;
    newPresetNameInputRef.current?.focus();
    newPresetNameInputRef.current?.select();
  }, [nameForNewOpen]);

  useLayoutEffect(() => {
    if (!subOpen) return;
    const update = () => {
      const el = customBtnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const left = r.left - FLYOUT_W + 1;
      setFlyoutPos({ top: r.top, left: Math.max(8, left) });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [subOpen, mainOpen, nameForNewOpen]);


  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (document.getElementById('prompt-preset-flyout')?.contains(t)) return;
      setMainOpen(false);
      setSubOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const applyBuiltin = (id: string) => {
    const preset = getPromptPreset(id);
    onPatch({ promptPresetId: preset.id, systemPrompt: preset.prompt, activeCustomPresetId: null });
    setMainOpen(false);
    setSubOpen(false);
  };

  const createNewPreset = () => {
    const newPreset: CustomPromptPreset = {
      id: uid(),
      name: nextCustomName(provider.customPromptPresets),
      prompt: '',
      updatedAt: Date.now()
    };
    onPatch(
      {
        promptPresetId: 'custom',
        activeCustomPresetId: newPreset.id,
        systemPrompt: '',
        customPromptPresets: [...provider.customPromptPresets, newPreset]
      },
      { persist: true }
    );
    setMainOpen(false);
    setSubOpen(false);
  };

  const loadCustomPreset = (id: string) => {
    const p = provider.customPromptPresets.find((c) => c.id === id);
    if (!p) return;
    onPatch({ promptPresetId: 'custom', activeCustomPresetId: id, systemPrompt: p.prompt });
    setMainOpen(false);
    setSubOpen(false);
  };

  const openNameForNewPreset = () => {
    setNameForNewOpen(true);
    setNameForNewDraft(nextCustomName(provider.customPromptPresets));
  };

  const commitNewNamedPreset = () => {
    const t = nameForNewDraft.trim() || 'Untitled';
    const newPreset: CustomPromptPreset = {
      id: uid(),
      name: t,
      prompt: provider.systemPrompt,
      updatedAt: Date.now()
    };
    onPatch(
      {
        promptPresetId: 'custom',
        activeCustomPresetId: newPreset.id,
        customPromptPresets: [...provider.customPromptPresets, newPreset]
      },
      { persist: true }
    );
    setNameForNewOpen(false);
    setMainOpen(false);
    setSubOpen(false);
  };

  const cancelNameForNewPreset = () => {
    setNameForNewOpen(false);
  };

  const savePresetFromEditor = () => {
    if (provider.activeCustomPresetId) {
      const id = provider.activeCustomPresetId;
      onPatch(
        {
          promptPresetId: 'custom',
          customPromptPresets: provider.customPromptPresets.map((c) =>
            c.id === id ? { ...c, prompt: provider.systemPrompt, updatedAt: Date.now() } : c
          )
        },
        { persist: true }
      );
      return;
    }
    openNameForNewPreset();
  };

  const saveAsNew = () => {
    openNameForNewPreset();
  };

  const deletePreset = (id: string, name: string) => {
    if (!window.confirm(`Delete preset “${name}”?`)) return;
    setRenamingId(null);
    const next = provider.customPromptPresets.filter((c) => c.id !== id);
    const patch: Partial<ProviderProfile> = { customPromptPresets: next };
    if (provider.activeCustomPresetId === id) {
      patch.activeCustomPresetId = null;
    }
    onPatch(patch, { persist: true });
  };

  const startRename = (c: CustomPromptPreset) => {
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
          customPromptPresets: provider.customPromptPresets.map((c) =>
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

  const sortedCustom = [...provider.customPromptPresets].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="prompt-preset-menu" ref={rootRef}>
      <button
        className="prompt-preset-menu__button"
        onClick={() => setMainOpen((o) => !o)}
        type="button"
      >
        <span className="prompt-preset-menu__button-text">{buttonLabel(provider)}</span>
        <span className="prompt-preset-menu__button-caret" aria-hidden>
          {mainOpen ? '▲' : '▼'}
        </span>
      </button>

      {mainOpen && (
        <div className="prompt-preset-menu__dropdown" role="listbox">
          {promptPresets.map((p) => (
            <button
              className={`prompt-preset-menu__item ${provider.promptPresetId === p.id ? 'is-active' : ''}`}
              key={p.id}
              onClick={() => applyBuiltin(p.id)}
              type="button"
            >
              {p.label}
            </button>
          ))}

          <div
            className="prompt-preset-menu__sub-wrap"
            onMouseEnter={openSub}
            onMouseLeave={(e) => {
              const to = e.relatedTarget as Node | null;
              if (to && document.getElementById('prompt-preset-flyout')?.contains(to)) return;
              scheduleSubClose();
            }}
          >
            <button
              ref={customBtnRef}
              className={`prompt-preset-menu__item prompt-preset-menu__item--custom ${
                provider.promptPresetId === 'custom' ? 'is-active' : ''
              }`}
              onClick={(e) => {
                e.stopPropagation();
                openSub();
              }}
              type="button"
            >
              <span>Custom</span>
              <span className="prompt-preset-menu__sub-hint" aria-hidden>
                ◀
              </span>
            </button>
            {subOpen &&
              createPortal(
                <div
                  className="prompt-preset-menu__flyout prompt-preset-menu__flyout--fixed"
                  id="prompt-preset-flyout"
                  onMouseDown={(e) => e.stopPropagation()}
                  onMouseEnter={openSub}
                  onMouseLeave={(e) => {
                    if (nameForNewOpen) return;
                    const to = e.relatedTarget as Node | null;
                    if (to && (rootRef.current?.contains(to) || customBtnRef.current?.contains(to))) return;
                    scheduleSubClose();
                  }}
                  role="menu"
                  style={{ top: flyoutPos.top, left: flyoutPos.left, width: FLYOUT_W }}
                >
                  {nameForNewOpen ? (
                    <div className="prompt-preset-menu__name-wizard" onKeyDown={(e) => e.stopPropagation()}>
                      <div className="prompt-preset-menu__name-wizard-title">Name this preset</div>
                      <input
                        className="prompt-preset-menu__name-wizard-input"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitNewNamedPreset();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelNameForNewPreset();
                          }
                        }}
                        onChange={(e) => setNameForNewDraft(e.target.value)}
                        placeholder="e.g. Agent workspace v2"
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
                  <button
                    className="prompt-preset-menu__flyout-item prompt-preset-menu__flyout-item--action"
                    onClick={createNewPreset}
                    type="button"
                  >
                    New preset…
                  </button>
                  <button
                    className="prompt-preset-menu__flyout-item prompt-preset-menu__flyout-item--action"
                    onClick={savePresetFromEditor}
                    title={
                      provider.activeCustomPresetId
                        ? 'Save the prompt box into the active custom preset'
                        : 'Name and save the current prompt text as a new custom preset'
                    }
                    type="button"
                  >
                    {provider.activeCustomPresetId ? 'Save' : 'Save as new…'}
                  </button>
                  {provider.activeCustomPresetId ? (
                    <button
                      className="prompt-preset-menu__flyout-item"
                      onClick={saveAsNew}
                      type="button"
                    >
                      Save copy as new…
                    </button>
                  ) : null}
                  {sortedCustom.length > 0 ? (
                    <>
                      <div className="prompt-preset-menu__flyout-sep" />
                      {sortedCustom.map((c) => (
                        <div
                          className="prompt-preset-menu__flyout-row"
                          key={c.id}
                        >
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
                                provider.activeCustomPresetId === c.id && provider.promptPresetId === 'custom'
                                  ? 'is-active'
                                  : ''
                              }`}
                              onClick={() => loadCustomPreset(c.id)}
                              type="button"
                              title={c.name}
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
                                type="button"
                                title="Rename"
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
                                  deletePreset(c.id, c.name);
                                }}
                                type="button"
                                title="Delete"
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
                </div>,
                document.body
              )}
          </div>
        </div>
      )}
    </div>
  );
}


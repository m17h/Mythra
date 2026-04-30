import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SavedChatMeta } from '@shared/types';

const dialogTransition = { duration: 0.18, ease: 'easeOut' as const };

const CORE_MD_NAMES = ['soul.md', 'tools.md', 'memory.md', 'corrections.md'];

function basename(path: string): string {
  const s = path.replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function basenameLower(path: string): string {
  return basename(path).toLowerCase();
}

function partitionWizardPaths(paths: string[]): { coreRows: string[]; otherRows: string[] } {
  const coreRows: string[] = [];
  for (const name of CORE_MD_NAMES) {
    const hit = paths.find((p) => basenameLower(p) === name);
    if (hit) coreRows.push(hit);
  }
  const coreSet = new Set(coreRows);
  const otherRows = paths.filter((p) => !coreSet.has(p)).sort((a, b) => a.localeCompare(b));
  return { coreRows, otherRows };
}

interface WizardExportDialogProps {
  open: boolean;
  wizardChat: SavedChatMeta | null;
  onClose: () => void;
  onStatusMessage?: (message: string) => void;
}

export function WizardExportDialog({ open, wizardChat, onClose, onStatusMessage }: WizardExportDialogProps) {
  const wizard = wizardChat?.wizard ?? null;
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [allPaths, setAllPaths] = useState<string[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [includeSystemPrompt, setIncludeSystemPrompt] = useState(true);
  const [exporting, setExporting] = useState(false);

  const { coreRows, otherRows } = useMemo(() => partitionWizardPaths(allPaths), [allPaths]);

  useEffect(() => {
    if (!open || !wizard?.workspaceRoot) return;

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const paths = await window.electronAPI.listWizardExportFiles(wizard.workspaceRoot);
        if (cancelled) return;
        setAllPaths(paths);
        setSelectedPaths(new Set(paths));
        setIncludeSystemPrompt(true);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
          setAllPaths([]);
          setSelectedPaths(new Set());
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, wizard?.workspaceRoot, wizardChat?.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const togglePath = useCallback((p: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  const selectAllWorkspace = useCallback(() => {
    setSelectedPaths(new Set(allPaths));
  }, [allPaths]);

  const clearWorkspaceSelection = useCallback(() => {
    setSelectedPaths(new Set());
  }, []);

  const canExport =
    Boolean(wizard?.workspaceRoot) &&
    !loading &&
    !exporting &&
    (includeSystemPrompt || selectedPaths.size > 0);

  const handleExport = async () => {
    if (!wizard?.workspaceRoot || !canExport) return;
    setExporting(true);
    try {
      const result = await window.electronAPI.exportWizardMythwiz({
        workspaceRoot: wizard.workspaceRoot,
        wizardDisplayName: wizard.name.trim() || wizardChat?.title.trim() || 'Wizard',
        systemPrompt: wizard.systemPrompt ?? '',
        includeSystemPromptFile: includeSystemPrompt,
        workspaceRelativePaths: [...selectedPaths]
      });
      if (result.ok) {
        onStatusMessage?.(`Exported Wizard bundle to ${result.path}`);
        onClose();
      } else if ('cancelled' in result && result.cancelled) {
        /* user dismissed save dialog */
      } else if ('error' in result) {
        onStatusMessage?.(`Export failed: ${result.error}`);
      }
    } finally {
      setExporting(false);
    }
  };

  return (
    <AnimatePresence>
      {open && wizard ? (
        <motion.div
          animate={{ opacity: 1 }}
          className="app-dialog-backdrop"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          role="presentation"
        >
          <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            aria-labelledby="wizard-export-title"
            aria-modal="true"
            className="app-dialog app-dialog--scrollable"
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            role="dialog"
            transition={dialogTransition}
          >
            <div className="app-dialog__kicker">Wizard</div>
            <h3 id="wizard-export-title">Export Wizard bundle</h3>
            <p>
              Choose what goes into the shareable <code className="app-dialog__code">.mythwiz</code> file (ZIP format).
              Send only what you intend others to receive.
            </p>

            {loading ? (
              <p className="wizard-export-dialog__muted">Reading workspace file list…</p>
            ) : loadError ? (
              <p className="wizard-export-dialog__error">{loadError}</p>
            ) : (
              <>
                <div className="app-dialog__section">
                  <div className="app-dialog__section-title">Included content</div>
                  <label className="wizard-export-dialog__check-row">
                    <input
                      checked={includeSystemPrompt}
                      disabled={exporting}
                      onChange={(e) => setIncludeSystemPrompt(e.target.checked)}
                      type="checkbox"
                    />
                    <span>
                      <strong>system_prompt.md</strong>
                      <span className="wizard-export-dialog__hint"> Wizard persona / instructions</span>
                    </span>
                  </label>

                  {coreRows.length ? (
                    <>
                      <div className="wizard-export-dialog__subhead">Core Markdown docs</div>
                      {coreRows.map((p) => (
                        <label className="wizard-export-dialog__check-row" key={p}>
                          <input
                            checked={selectedPaths.has(p)}
                            disabled={exporting}
                            onChange={() => togglePath(p)}
                            type="checkbox"
                          />
                          <span>
                            <strong>{basename(p)}</strong>
                            <span className="wizard-export-dialog__hint"> {p}</span>
                          </span>
                        </label>
                      ))}
                    </>
                  ) : null}

                  <div className="wizard-export-dialog__subhead wizard-export-dialog__subhead--toolbar">
                    <span>Other workspace files</span>
                    <span className="wizard-export-dialog__toolbar">
                      <button
                        className="wizard-export-dialog__linkish"
                        disabled={exporting || allPaths.length === 0}
                        onClick={selectAllWorkspace}
                        type="button"
                      >
                        Select all
                      </button>
                      <span aria-hidden className="wizard-export-dialog__sep">
                        ·
                      </span>
                      <button
                        className="wizard-export-dialog__linkish"
                        disabled={exporting || selectedPaths.size === 0}
                        onClick={clearWorkspaceSelection}
                        type="button"
                      >
                        Clear workspace files
                      </button>
                    </span>
                  </div>

                  {otherRows.length === 0 ? (
                    <p className="wizard-export-dialog__muted">No extra files beyond the core docs listed above.</p>
                  ) : (
                    <div className="wizard-export-dialog__file-scroll">
                      {otherRows.map((p) => (
                        <label className="wizard-export-dialog__check-row" key={p}>
                          <input
                            checked={selectedPaths.has(p)}
                            disabled={exporting}
                            onChange={() => togglePath(p)}
                            type="checkbox"
                          />
                          <span title={p}>{p}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="app-dialog__actions">
              <button className="btn btn--secondary" disabled={exporting} onClick={onClose} type="button">
                Cancel
              </button>
              <button
                className="btn btn--primary"
                disabled={!canExport || Boolean(loadError)}
                onClick={() => void handleExport()}
                type="button"
              >
                {exporting ? 'Exporting…' : 'Choose save location…'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

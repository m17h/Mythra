import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import type { AppSettings, NexusSetupRequest, SavedChatMeta } from '@shared/types';
import { sanitizeWizardFolderSegment } from '@shared/wizard-folder';
import { AppSelect } from './AppSelect';

interface NexusSetupModalProps {
  open: boolean;
  settings: AppSettings | null;
  wizards: SavedChatMeta[];
  onClose: () => void;
  onCreate: (request: NexusSetupRequest) => Promise<void>;
  onPersistNexusProjectsParentFolder: (absoluteFolderPath: string) => Promise<void>;
}

function previewNexusWorkspacePath(platform: string, parentFolder: string, projectDisplayName: string): string {
  const segment = sanitizeWizardFolderSegment(projectDisplayName);
  if (!segment) return '';
  const base = parentFolder.trim().replace(/[/\\]+$/, '');
  if (!base) return segment;
  const sep = platform === 'win32' ? '\\' : '/';
  return `${base}${sep}${segment}`;
}

export function NexusSetupModal({
  open,
  settings,
  wizards,
  onClose,
  onCreate,
  onPersistNexusProjectsParentFolder
}: NexusSetupModalProps) {
  const [name, setName] = useState('');
  const [mission, setMission] = useState('');
  const [nexusProjectsParentFolder, setNexusProjectsParentFolder] = useState('');
  const [lastValidWorkspaceRoot, setLastValidWorkspaceRoot] = useState<string | null>(null);
  const [leaderWizardId, setLeaderWizardId] = useState('');
  const [memberWizardIds, setMemberWizardIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const wizardOptions = useMemo(
    () => wizards.map((wizard) => ({ value: wizard.id, label: wizard.wizard?.name ?? wizard.title })),
    [wizards]
  );

  useEffect(() => {
    if (!open) return;
    setName('');
    setMission('');
    setNexusProjectsParentFolder(settings?.ui?.nexusProjectsParentFolder?.trim() ?? '');
    const firstWizardId = wizards[0]?.id ?? '';
    setLeaderWizardId(firstWizardId);
    setMemberWizardIds(firstWizardId ? new Set([firstWizardId]) : new Set());
    setCreating(false);
    setError('');
    void window.electronAPI.getLastValidWorkspaceRoot().then(setLastValidWorkspaceRoot);
    // Intentionally read settings once per open; saving the folder preference mid-modal should not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- settings read once when the dialog opens
  }, [open, wizards]);

  const selectedMembers = useMemo(() => {
    const ids = new Set(memberWizardIds);
    if (leaderWizardId) ids.add(leaderWizardId);
    return ids;
  }, [leaderWizardId, memberWizardIds]);

  const workspacePreview = useMemo(
    () => previewNexusWorkspacePath(window.electronAPI.platform, nexusProjectsParentFolder, name),
    [nexusProjectsParentFolder, name]
  );

  const canCreate = Boolean(name.trim() && mission.trim() && nexusProjectsParentFolder.trim() && leaderWizardId && selectedMembers.size >= 2);

  const chooseProjectsFolder = async () => {
    setError('');
    const hint = nexusProjectsParentFolder.trim() || lastValidWorkspaceRoot || undefined;
    const picked = await window.electronAPI.chooseNexusWorkspace(hint);
    if (!picked) return;
    setNexusProjectsParentFolder(picked);
    try {
      await onPersistNexusProjectsParentFolder(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save Nexus projects folder preference.');
    }
  };

  const submit = async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    setError('');
    try {
      await onCreate({
        name: name.trim(),
        mission: mission.trim(),
        workspaceRoot: nexusProjectsParentFolder.trim(),
        leaderWizardId,
        memberWizardIds: [...selectedMembers]
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create Nexus.');
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
          onClick={() => {
            if (!creating) onClose();
          }}
          role="presentation"
        >
          <motion.div
            aria-modal="true"
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="app-dialog app-dialog--scrollable nexus-setup"
            onClick={(e) => e.stopPropagation()}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            role="dialog"
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <div className="app-dialog__kicker">New Nexus</div>
            <h3>Create a Nexus project</h3>
            <p>
              A Nexus gives multiple Wizards a shared local project workspace. Their private Markdown docs still define
              who they are, while the shared folder holds the project they work on together.
            </p>

            <div className="wizard-setup__grid">
              <label className="field">
                <span>Name</span>
                <input onChange={(e) => setName(e.target.value)} placeholder="Website rebuild" value={name} />
              </label>

              <label className="field">
                <span>Leader</span>
                {wizardOptions.length ? (
                  <AppSelect
                    options={wizardOptions}
                    onChange={(id) => {
                      setLeaderWizardId(id);
                      setMemberWizardIds((current) => new Set(current).add(id));
                    }}
                    value={leaderWizardId || wizardOptions[0]?.value || ''}
                    portalDropdown
                  />
                ) : (
                  <input disabled readOnly value="Create at least two Wizards first" />
                )}
              </label>

              <label className="field wizard-setup__wide">
                <span>Mission</span>
                <textarea
                  onChange={(e) => setMission(e.target.value)}
                  placeholder="Describe the project, outcome, constraints, and what done should look like."
                  rows={5}
                  value={mission}
                />
              </label>

              <div className="field wizard-setup__wide">
                <span>Nexus projects folder</span>
                <div className="wizard-setup__workspace-actions">
                  <button className="btn btn--secondary" onClick={() => void chooseProjectsFolder()} type="button">
                    Choose folder…
                  </button>
                </div>
                <div className="inline-hint">
                  Pick one folder that will hold every Nexus project workspace. Each project is created as a subfolder
                  named from its title (sanitized).
                </div>
                {nexusProjectsParentFolder ? (
                  <div className="inline-hint">
                    <strong>Parent:</strong> {nexusProjectsParentFolder}
                  </div>
                ) : (
                  <div className="inline-hint">Choose a local folder (cloud-synced paths are blocked).</div>
                )}
                {workspacePreview ? (
                  <div className="inline-hint">
                    <strong>This Nexus:</strong> <code>{workspacePreview}</code>
                  </div>
                ) : null}
                <div className="inline-hint">
                  {nexusProjectsParentFolder ? (
                    <>
                      The team will read and write files in this generated project folder.
                    </>
                  ) : (
                    'Choose where Nexus project folders should live before creating this project.'
                  )}
                </div>
              </div>

              <div className="field wizard-setup__wide">
                <span>Team</span>
                <div className="nexus-setup__wizard-grid">
                  {wizards.map((wizard) => {
                    const checked = selectedMembers.has(wizard.id);
                    const isLeader = wizard.id === leaderWizardId;
                    return (
                      <label className={`nexus-setup__wizard ${checked ? 'is-selected' : ''}`} key={wizard.id}>
                        <input
                          checked={checked}
                          disabled={isLeader}
                          onChange={(e) => {
                            setMemberWizardIds((current) => {
                              const next = new Set(current);
                              if (e.target.checked) next.add(wizard.id);
                              else next.delete(wizard.id);
                              return next;
                            });
                          }}
                          type="checkbox"
                        />
                        <span>
                          <strong>{wizard.wizard?.name ?? wizard.title}</strong>
                          <small>{isLeader ? 'Leader' : wizard.wizard?.model ?? 'Wizard'}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <div className="inline-hint">
                  Each card is one Wizard. The leader stays selected; check others to add them to the team. At least two
                  Wizards total are required (leader + one more).
                </div>
              </div>
            </div>

            {error ? <div className="inline-hint inline-hint--warning">{error}</div> : null}

            <div className="app-dialog__actions">
              <button className="btn btn--secondary" disabled={creating} onClick={onClose} type="button">
                Cancel
              </button>
              <button className="btn btn--primary" disabled={!canCreate || creating} onClick={() => void submit()} type="button">
                {creating ? 'Creating...' : 'Create Nexus'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

import { useMemo, useState } from 'react';
import type { NexusProject } from '@shared/types';
import { AppSelect } from './AppSelect';

export interface NexusSettingsParticipant {
  wizardId: string;
  name: string;
  role: 'leader' | 'member';
  workspaceRoot?: string;
}

export interface NexusAvailableWizardOption {
  id: string;
  name: string;
}

function setNexusLeader(project: NexusProject, leaderId: string): NexusProject {
  if (!project.members.some((m) => m.wizardId === leaderId)) return project;
  return {
    ...project,
    leaderWizardId: leaderId,
    members: project.members.map((m) => ({
      wizardId: m.wizardId,
      role: m.wizardId === leaderId ? 'leader' : 'member'
    }))
  };
}

function removeNexusMember(project: NexusProject, wizardId: string): NexusProject | 'below_min' {
  if (project.members.length <= 2) return 'below_min';
  const nextMembers = project.members.filter((m) => m.wizardId !== wizardId);
  let leaderId = project.leaderWizardId;
  if (wizardId === leaderId) {
    leaderId = nextMembers[0]!.wizardId;
  }
  const ids = new Set(nextMembers.map((m) => m.wizardId));
  const tasks = project.tasks.map((t) =>
    ids.has(t.assigneeWizardId) ? t : { ...t, assigneeWizardId: leaderId }
  );
  return setNexusLeader({ ...project, members: nextMembers, tasks }, leaderId);
}

function addNexusMember(project: NexusProject, wizardId: string): NexusProject {
  if (project.members.some((m) => m.wizardId === wizardId)) return project;
  return {
    ...project,
    members: [...project.members, { wizardId, role: 'member' as const }]
  };
}

interface NexusSettingsPanelProps {
  project: NexusProject;
  participants: NexusSettingsParticipant[];
  /** Wizards not yet in this Nexus (from the Wizards sidebar list). */
  availableWizards: NexusAvailableWizardOption[];
  statusMessage: string;
  onChange: (project: NexusProject) => void;
  /** Brief status when a team edit is blocked (e.g. minimum size). */
  onTeamConstraint?: (message: string) => void;
  /** Opens this Wizard in the sidebar (same flow as picking them under Wizards). */
  onOpenWizard: (wizardId: string) => void;
}

export function NexusSettingsPanel({
  project,
  participants,
  availableWizards,
  statusMessage,
  onChange,
  onTeamConstraint,
  onOpenWizard
}: NexusSettingsPanelProps) {
  const [wizardIdToAdd, setWizardIdToAdd] = useState('');

  const leaderOptions = useMemo(
    () => participants.map((p) => ({ value: p.wizardId, label: p.name })),
    [participants]
  );

  const addOptions = useMemo(
    () => availableWizards.map((w) => ({ value: w.id, label: w.name })),
    [availableWizards]
  );

  const addValue = wizardIdToAdd && addOptions.some((o) => o.value === wizardIdToAdd) ? wizardIdToAdd : addOptions[0]?.value ?? '';

  const tryRemove = (wizardId: string) => {
    const next = removeNexusMember(project, wizardId);
    if (next === 'below_min') {
      onTeamConstraint?.('A Nexus needs at least two Wizards. Add another Wizard before removing this one.');
      return;
    }
    onChange(next);
  };

  const tryAdd = () => {
    const id = addValue;
    if (!id) return;
    onChange(addNexusMember(project, id));
    setWizardIdToAdd('');
  };

  return (
    <section className="panel settings-panel">
      <div className="settings-panel__header">
        <div>
          <h3 className="settings-panel__title">Nexus project</h3>
          <p className="settings-panel__subtitle">Shared workspace and team</p>
        </div>
      </div>

      <div className="settings-scroll">
        <div className="settings-section settings-section--nexus-team">
          <h4 className="settings-section__title">Participating Wizards</h4>
          <p className="inline-hint nexus-settings-team-hint">
            With two or more Wizards, Mythra runs Nexus sessions in relay mode by default (one teammate stream at a time in the same assistant bubble so everyone reads earlier segments before speaking). Enable parallel replies below if you want everyone answering at once instead.
          </p>

          {leaderOptions.length > 0 ? (
            <label className="field nexus-settings-leader-field">
              <span>Nexus leader</span>
              <AppSelect
                onChange={(id) => onChange(setNexusLeader(project, id))}
                options={leaderOptions}
                portalDropdown
                value={project.leaderWizardId}
              />
              <span className="inline-hint">Coordinates assignments in Nexus prompts; you can change anytime.</span>
            </label>
          ) : null}

          <ul className="nexus-settings-team">
            {participants.map((p) => (
              <li className="nexus-settings-team__member" key={p.wizardId}>
                <div className="nexus-settings-team__identity">
                  <span className="nexus-settings-team__name">{p.name}</span>
                  <span className={`nexus-settings-team__badge ${p.role === 'leader' ? 'nexus-settings-team__badge--leader' : ''}`}>
                    {p.role === 'leader' ? 'Leader' : 'Member'}
                  </span>
                </div>
                {p.workspaceRoot ? (
                  <code className="nexus-settings-team__path" title={p.workspaceRoot}>
                    {p.workspaceRoot}
                  </code>
                ) : null}
                <div className="nexus-settings-team__actions">
                  <button className="btn btn--secondary nexus-settings-team__open" onClick={() => onOpenWizard(p.wizardId)} type="button">
                    Open Wizard
                  </button>
                  <button
                    className="btn btn--danger nexus-settings-team__remove"
                    disabled={project.members.length <= 2}
                    onClick={() => tryRemove(p.wizardId)}
                    title={project.members.length <= 2 ? 'Add another Wizard before removing' : `Remove ${p.name} from this Nexus`}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="nexus-settings-add-wizard">
            <h5 className="nexus-settings-add-wizard__title">Add Wizard</h5>
            {addOptions.length > 0 ? (
              <div className="nexus-settings-add-wizard__row">
                <AppSelect
                  onChange={(id) => setWizardIdToAdd(id)}
                  options={addOptions}
                  portalDropdown
                  value={addValue}
                />
                <button className="btn btn--secondary" onClick={() => tryAdd()} type="button">
                  Add to project
                </button>
              </div>
            ) : (
              <p className="inline-hint">Every Wizard is already in this Nexus, or no other Wizards exist yet.</p>
            )}
          </div>
        </div>

        <div className="settings-section">
          <h4 className="settings-section__title">Collaboration & tools</h4>
          <label className={`toggle-row toggle-row--warning ${project.teamFullAccess ? 'is-active' : ''}`}>
            <span>Team full access</span>
            <input
              checked={Boolean(project.teamFullAccess)}
              onChange={(e) => {
                const next = e.target.checked;
                onChange({
                  ...project,
                  teamFullAccess: next,
                  ...(next ? { leaderApprovesTools: false } : {})
                });
              }}
              type="checkbox"
            />
          </label>
          <div className="inline-hint inline-hint--warning">
            When on, every teammate stream skips per-action tool approvals in Nexus sessions (same idea as Settings → Agent autonomy → Full access).
          </div>

          <label className={`toggle-row ${project.leaderApprovesTools ? 'is-active' : ''}`}>
            <span>Leader approves tools instead of user</span>
            <input
              checked={Boolean(project.leaderApprovesTools)}
              disabled={Boolean(project.teamFullAccess)}
              onChange={(e) => onChange({ ...project, leaderApprovesTools: e.target.checked })}
              type="checkbox"
            />
          </label>
          <div className="inline-hint">
            When Full access is off, Mythra asks the Nexus leader model (your leader Wizard&apos;s provider/model) for APPROVE or DENY instead of showing you the confirmation modal.
          </div>

          <label className={`toggle-row ${project.parallelWizardResponses ? 'is-active' : ''}`}>
            <span>Parallel replies (all Wizards at once)</span>
            <input
              checked={Boolean(project.parallelWizardResponses)}
              onChange={(e) => onChange({ ...project, parallelWizardResponses: e.target.checked })}
              type="checkbox"
            />
          </label>
          <div className="inline-hint">
            When off (default), teammates respond one stream at a time in one assistant bubble and may continue until they emit{' '}
            <code>[NEXUS_END]</code> or reach the turn cap.
          </div>

          {!project.parallelWizardResponses ? (
            <label className="field">
              <span>Max relay turns per message</span>
              <input
                inputMode="numeric"
                max={96}
                min={1}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  onChange({
                    ...project,
                    maxSequentialWizardTurns: Number.isFinite(n) ? Math.min(96, Math.max(1, n)) : 24
                  });
                }}
                type="number"
                value={project.maxSequentialWizardTurns ?? 24}
              />
              <span className="inline-hint">Each teammate reply counts as one turn; raises the relay ceiling before Mythra stops the round-robin.</span>
            </label>
          ) : null}
        </div>

        <div className="settings-section">
          <h4 className="settings-section__title">Project</h4>
          <label className="field">
            <span>Name</span>
            <input onChange={(e) => onChange({ ...project, name: e.target.value })} value={project.name} />
          </label>
          <label className="field">
            <span>Mission</span>
            <textarea
              onChange={(e) => onChange({ ...project, mission: e.target.value })}
              rows={6}
              value={project.mission}
            />
          </label>
          <div className="field">
            <span>Shared workspace</span>
            <input readOnly value={project.workspaceRoot} />
          </div>
          <div className="inline-hint">Files tools use this folder for Nexus sessions. Change it only by moving the project on disk and updating Mythra.</div>
          <div className="field">
            <span>Status</span>
            <input readOnly value={project.status} />
          </div>
        </div>

        {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
      </div>
    </section>
  );
}

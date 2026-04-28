import type { WorkspaceChanges } from '@shared/types';

interface ChangesPanelProps {
  changes: WorkspaceChanges | null;
  loading: boolean;
  workspaceRoot?: string;
  onRefresh: () => void;
}

const emptyText = 'No working tree changes.';

const diffLineClass = (line: string) => {
  if (line.startsWith('+++') || line.startsWith('---')) return 'changes-diff__line--file';
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'changes-diff__line--meta';
  if (line.startsWith('@@')) return 'changes-diff__line--hunk';
  if (line.startsWith('+')) return 'changes-diff__line--add';
  if (line.startsWith('-')) return 'changes-diff__line--del';
  return '';
};

function DiffView({ diff }: { diff: string }) {
  const trimmed = diff.trim();
  if (!trimmed) {
    return <pre>{emptyText}</pre>;
  }
  return (
    <pre className="changes-diff" aria-label="Git diff">
      {trimmed.split('\n').map((line, index) => (
        <span className={`changes-diff__line ${diffLineClass(line)}`} key={`${index}-${line.slice(0, 12)}`}>
          {line || ' '}
        </span>
      ))}
    </pre>
  );
}

export function ChangesPanel({ changes, loading, workspaceRoot, onRefresh }: ChangesPanelProps) {
  return (
    <section className="changes-panel">
      <header className="changes-panel__header">
        <div>
          <h3>Changes</h3>
          <p>{workspaceRoot ? 'Git status and unstaged diff' : 'Open a workspace to inspect changes'}</p>
        </div>
        <button className="btn btn--secondary changes-panel__refresh" disabled={!workspaceRoot || loading} onClick={onRefresh} type="button">
          {loading ? 'Refreshing' : 'Refresh'}
        </button>
      </header>

      {!workspaceRoot ? (
        <div className="changes-panel__empty">No workspace is open.</div>
      ) : changes?.error ? (
        <div className="changes-panel__empty">{changes.error}</div>
      ) : (
        <div className="changes-panel__body">
          <section className="changes-panel__block">
            <h4>Status</h4>
            <pre>{changes?.status.trim() || emptyText}</pre>
          </section>
          <section className="changes-panel__block changes-panel__block--diff">
            <h4>Diff</h4>
            <DiffView diff={changes?.diff ?? ''} />
          </section>
        </div>
      )}
    </section>
  );
}

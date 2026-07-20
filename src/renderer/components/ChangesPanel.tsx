import type { WorkspaceChanges } from '@shared/types';
import { useMemo } from 'react';
import { parseDiffGroups } from '@renderer/lib/diff-view';

interface ChangesPanelProps {
  changes: WorkspaceChanges | null;
  loading: boolean;
  workspaceRoot?: string;
  onRefresh: () => void;
  onDiscardPatch?: (patch: string) => void;
  onOpenFile?: (path: string) => void;
}

const emptyText = 'No working tree changes.';
const MAX_RENDERED_DIFF_LINES = 2_500;

function filePathFromDiffTitle(title: string) {
  return title === 'Diff' ? '' : title;
}

function hunksForGroup(group: ReturnType<typeof parseDiffGroups>['groups'][number]) {
  const hunks: Array<{ id: string; title: string; patch: string; lines: typeof group.lines }> = [];
  let current: typeof group.lines = [];
  for (const line of group.lines) {
    if (line.text.startsWith('@@')) {
      if (current.length > 0) {
        const first = current.find((item) => item.text.startsWith('@@'));
        hunks.push({
          id: `${group.id}-${hunks.length}`,
          title: first?.text ?? `Hunk ${hunks.length + 1}`,
          patch: [...group.patchHeader, ...current.map((item) => item.text)].join('\n') + '\n',
          lines: current
        });
      }
      current = [line];
      continue;
    }
    if (current.length > 0) current.push(line);
  }
  if (current.length > 0) {
    const first = current.find((item) => item.text.startsWith('@@'));
    hunks.push({
      id: `${group.id}-${hunks.length}`,
      title: first?.text ?? `Hunk ${hunks.length + 1}`,
      patch: [...group.patchHeader, ...current.map((item) => item.text)].join('\n') + '\n',
      lines: current
    });
  }
  return hunks;
}

function DiffView({
  diff,
  onDiscardPatch,
  onOpenFile
}: {
  diff: string;
  onDiscardPatch?: (patch: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const parsed = useMemo(() => parseDiffGroups(diff, MAX_RENDERED_DIFF_LINES), [diff]);
  if (parsed.groups.length === 0) {
    return <pre>{emptyText}</pre>;
  }
  return (
    <div className="changes-diff-groups" aria-label="Git diff">
      {parsed.truncated ? (
        <div className="changes-diff__truncated">
          Showing first {MAX_RENDERED_DIFF_LINES.toLocaleString()} of {parsed.originalLineCount.toLocaleString()} diff lines.
        </div>
      ) : null}
      {parsed.groups.map((group, index) => {
        const hunks = hunksForGroup(group);
        return (
          <details className="changes-diff-file" key={group.id} open={index < 4}>
            <summary>
              <span>{group.title}</span>
              <small>{group.lines.length.toLocaleString()} lines</small>
            </summary>
            <div className="changes-diff-file__actions">
              <button disabled={!filePathFromDiffTitle(group.title)} onClick={() => onOpenFile?.(filePathFromDiffTitle(group.title))} type="button">
                Open file
              </button>
              <button onClick={() => void navigator.clipboard.writeText(group.lines.map((line) => line.text).join('\n'))} type="button">
                Copy file diff
              </button>
            </div>
            {hunks.length > 0 ? (
              <div className="changes-hunks">
                {hunks.map((hunk) => (
                  <details className="changes-hunk" key={hunk.id}>
                    <summary>
                      <span>{hunk.title}</span>
                      <small>{hunk.lines.length.toLocaleString()} lines</small>
                    </summary>
                    <div className="changes-hunk__actions">
                      <button onClick={() => void navigator.clipboard.writeText(hunk.patch)} type="button">Copy hunk patch</button>
                      <button
                        disabled={!onDiscardPatch || parsed.truncated}
                        onClick={() => onDiscardPatch?.(hunk.patch)}
                        title={parsed.truncated ? 'Discard is disabled while the diff is truncated to avoid applying an incomplete patch.' : undefined}
                        type="button"
                      >
                        Discard hunk
                      </button>
                    </div>
                    <pre className="changes-diff">
                      {hunk.lines.map((line) => (
                        <span className={`changes-diff__line ${line.className}`} key={line.id}>
                          {line.text}
                        </span>
                      ))}
                    </pre>
                  </details>
                ))}
              </div>
            ) : (
              <pre className="changes-diff">
                {group.lines.map((line) => (
                  <span className={`changes-diff__line ${line.className}`} key={line.id}>
                    {line.text}
                  </span>
                ))}
              </pre>
            )}
          </details>
        );
      })}
    </div>
  );
}

export function ChangesPanel({ changes, loading, workspaceRoot, onRefresh, onDiscardPatch, onOpenFile }: ChangesPanelProps) {
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
        <div className="changes-panel__empty changes-panel__error" role="alert">{changes.error}</div>
      ) : (
        <div className="changes-panel__body">
          <section className="changes-panel__block">
            <h4>Status</h4>
            <pre>{changes?.status.trim() || emptyText}</pre>
          </section>
          <section className="changes-panel__block changes-panel__block--diff">
            <h4>Diff</h4>
            <DiffView diff={changes?.diff ?? ''} onDiscardPatch={onDiscardPatch} onOpenFile={onOpenFile} />
          </section>
        </div>
      )}
    </section>
  );
}

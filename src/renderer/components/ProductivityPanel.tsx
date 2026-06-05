import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CostDashboardSummary, ProjectSettings, PromptSnippet, TestRunSummary, ToolHistoryEntry } from '@shared/types';

const uid = () => Math.random().toString(36).slice(2, 11);

function money(value: number) {
  if (!Number.isFinite(value)) return '$0.00';
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function ProductivityPanel({
  activeChatId,
  onForkChat,
  onInsertSnippet,
  onOpenChatSearch,
  workspaceRoot
}: {
  activeChatId?: string;
  onForkChat: () => void;
  onInsertSnippet: (text: string) => void;
  onOpenChatSearch: () => void;
  workspaceRoot?: string;
}) {
  const [snippets, setSnippets] = useState<PromptSnippet[]>([]);
  const [snippetName, setSnippetName] = useState('');
  const [snippetText, setSnippetText] = useState('');
  const [projectSettings, setProjectSettings] = useState<ProjectSettings | null>(null);
  const [toolHistory, setToolHistory] = useState<ToolHistoryEntry[]>([]);
  const [testRuns, setTestRuns] = useState<TestRunSummary[]>([]);
  const [costSummary, setCostSummary] = useState<CostDashboardSummary | null>(null);
  const [status, setStatus] = useState('');
  const [runningTests, setRunningTests] = useState(false);

  const refresh = useCallback(() => {
    void window.electronAPI.listPromptSnippets().then(setSnippets);
    void window.electronAPI.listToolHistory(80).then(setToolHistory);
    void window.electronAPI.listTestRuns(workspaceRoot, 20).then(setTestRuns);
    void window.electronAPI.getCostDashboardSummary().then(setCostSummary);
    if (workspaceRoot) {
      void window.electronAPI.getProjectSettings(workspaceRoot).then(setProjectSettings);
    } else {
      setProjectSettings(null);
    }
  }, [workspaceRoot]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveSnippet = async () => {
    const text = snippetText.trim();
    if (!text) return;
    await window.electronAPI.savePromptSnippet({
      id: uid(),
      name: snippetName.trim() || `Snippet ${snippets.length + 1}`,
      text,
      updatedAt: Date.now()
    });
    setSnippetName('');
    setSnippetText('');
    refresh();
  };

  const saveProjectSettings = async () => {
    if (!projectSettings) return;
    const saved = await window.electronAPI.saveProjectSettings(projectSettings);
    setProjectSettings(saved);
    setStatus('Project settings saved.');
  };

  const runProjectTests = async () => {
    if (!workspaceRoot || !projectSettings?.defaultTestCommand.trim()) return;
    setRunningTests(true);
    setStatus('Running tests...');
    try {
      const command = projectSettings.defaultTestCommand.trim();
      const result = await window.electronAPI.runCommandCapture(command, workspaceRoot);
      const summary = result.code === 0 ? 'Passed' : `Failed with exit code ${result.code ?? result.signal ?? 'unknown'}`;
      await window.electronAPI.saveTestRun({
        id: uid(),
        workspaceRoot,
        command,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        code: result.code,
        signal: result.signal,
        summary,
        stdoutTail: result.stdout.slice(-4000),
        stderrTail: result.stderr.slice(-4000)
      });
      setStatus(summary);
      refresh();
    } finally {
      setRunningTests(false);
    }
  };

  const topCostRows = useMemo(() => costSummary?.byModel.slice(0, 8) ?? [], [costSummary]);

  return (
    <section className="productivity-panel">
      <header className="productivity-panel__header">
        <div>
          <h3>Tools</h3>
          <p>Search, snippets, project defaults, test runs, tool history, and cost usage.</p>
        </div>
        <button className="btn btn--secondary" onClick={refresh} type="button">Refresh</button>
      </header>

      <div className="productivity-panel__body">
        <section className="productivity-card">
          <h4>Quick Actions</h4>
          <div className="productivity-actions">
            <button className="btn btn--secondary" onClick={onOpenChatSearch} type="button">Search chats</button>
            <button className="btn btn--secondary" disabled={!activeChatId} onClick={onForkChat} type="button">Fork chat</button>
            <button className="btn btn--secondary" disabled={!workspaceRoot || runningTests} onClick={() => void runProjectTests()} type="button">
              {runningTests ? 'Running...' : 'Run tests'}
            </button>
          </div>
          {status ? <p className="productivity-status">{status}</p> : null}
        </section>

        <section className="productivity-card">
          <h4>Project Settings</h4>
          {projectSettings ? (
            <>
              <label className="productivity-field">
                <span>Default test command</span>
                <input
                  value={projectSettings.defaultTestCommand}
                  onChange={(event) => setProjectSettings({ ...projectSettings, defaultTestCommand: event.target.value })}
                />
              </label>
              <label className="productivity-field">
                <span>Project notes</span>
                <textarea
                  value={projectSettings.notes}
                  onChange={(event) => setProjectSettings({ ...projectSettings, notes: event.target.value })}
                />
              </label>
              <button className="btn btn--primary" onClick={() => void saveProjectSettings()} type="button">Save project settings</button>
            </>
          ) : (
            <div className="productivity-empty">Open a workspace to save project defaults.</div>
          )}
        </section>

        <section className="productivity-card">
          <h4>Prompt Snippets</h4>
          <label className="productivity-field">
            <span>Name</span>
            <input value={snippetName} onChange={(event) => setSnippetName(event.target.value)} placeholder="Snippet name" />
          </label>
          <label className="productivity-field">
            <span>Text</span>
            <textarea value={snippetText} onChange={(event) => setSnippetText(event.target.value)} placeholder="Reusable prompt text" />
          </label>
          <button className="btn btn--primary" onClick={() => void saveSnippet()} type="button">Save snippet</button>
          <div className="productivity-list">
            {snippets.map((snippet) => (
              <div className="productivity-row" key={snippet.id}>
                <div>
                  <strong>{snippet.name}</strong>
                  <span>{snippet.text.slice(0, 120)}</span>
                </div>
                <div className="productivity-row__actions">
                  <button onClick={() => onInsertSnippet(snippet.text)} type="button">Insert</button>
                  <button onClick={() => void window.electronAPI.deletePromptSnippet(snippet.id).then(refresh)} type="button">Delete</button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="productivity-card">
          <h4>Cost Dashboard</h4>
          {costSummary ? (
            <>
              <div className="productivity-stats">
                <span><strong>{money(costSummary.totalCostUsd)}</strong>Total</span>
                <span><strong>{costSummary.totalTokens.toLocaleString()}</strong>Tokens</span>
                <span><strong>{costSummary.pricedMessages.toLocaleString()}</strong>Priced replies</span>
              </div>
              <div className="productivity-list">
                {topCostRows.map((row) => (
                  <div className="productivity-row" key={`${row.provider}-${row.model}`}>
                    <div>
                      <strong>{row.model}</strong>
                      <span>{row.provider} - {row.messages} replies - {row.totalTokens.toLocaleString()} tokens</span>
                    </div>
                    <b>{money(row.totalCostUsd)}</b>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="productivity-empty">No cost data yet.</div>
          )}
        </section>

        <section className="productivity-card">
          <h4>Test Summaries</h4>
          <div className="productivity-list">
            {testRuns.length === 0 ? <div className="productivity-empty">No test runs recorded.</div> : null}
            {testRuns.map((run) => (
              <details className="productivity-row productivity-row--details" key={run.id}>
                <summary>
                  <strong>{run.summary}</strong>
                  <span>{run.command} - {new Date(run.finishedAt).toLocaleString()}</span>
                </summary>
                <pre>{[run.stdoutTail, run.stderrTail].filter(Boolean).join('\n\n')}</pre>
              </details>
            ))}
          </div>
        </section>

        <section className="productivity-card">
          <h4>Tool History</h4>
          <div className="productivity-list">
            {toolHistory.length === 0 ? <div className="productivity-empty">No tool activity recorded yet.</div> : null}
            {toolHistory.map((entry) => (
              <div className={`productivity-row productivity-row--${entry.kind}`} key={entry.id}>
                <div>
                  <strong>{entry.kind}</strong>
                  <span>{entry.message}</span>
                </div>
                <small>{new Date(entry.at).toLocaleTimeString()}</small>
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

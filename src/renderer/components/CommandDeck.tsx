import type { CommandResult } from '@shared/types';

interface CommandDeckProps {
  commandInput: string;
  logs: string;
  activeJobId?: string;
  lastResult?: CommandResult;
  onCommandInputChange: (value: string) => void;
  onRun: () => void;
  onKill: () => void;
}

export function CommandDeck({
  commandInput,
  logs,
  activeJobId,
  lastResult,
  onCommandInputChange,
  onRun,
  onKill
}: CommandDeckProps) {
  return (
    <section className="command-deck">
      <div className="command-deck__header">
        <div>
          <div className="section-kicker">Command Deck</div>
          <div className="command-deck__status">
            {activeJobId ? `Live job ${activeJobId.slice(0, 8)}` : 'Idle'}
            {lastResult ? ` · exit ${lastResult.code ?? 'signal'}` : ''}
          </div>
        </div>
        <div className="command-deck__actions">
          <button className="action-button" onClick={onRun} type="button">
            Run
          </button>
          <button className="action-button action-button--ghost" onClick={onKill} disabled={!activeJobId} type="button">
            Stop
          </button>
        </div>
      </div>
      <div className="command-bar">
        <span className="command-bar__prompt">›</span>
        <input
          className="command-bar__input"
          onChange={(event) => onCommandInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onRun();
            }
          }}
          placeholder="git status"
          value={commandInput}
        />
      </div>
      <pre className="command-log">{logs || 'No commands executed yet.\n'}</pre>
    </section>
  );
}

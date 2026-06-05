import { useEffect, useMemo, useRef, useState } from 'react';

export interface CommandPaletteAction {
  id: string;
  title: string;
  subtitle?: string;
  run: () => void;
}

export function CommandPalette({
  actions,
  onClose,
  open
}: {
  actions: CommandPaletteAction[];
  onClose: () => void;
  open: boolean;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelected(0);
      return;
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((action) =>
      `${action.title} ${action.subtitle ?? ''}`.toLowerCase().includes(q)
    );
  }, [actions, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  if (!open) return null;

  const runSelected = () => {
    const action = filtered[selected];
    if (!action) return;
    action.run();
    onClose();
  };

  return (
    <div className="command-palette-backdrop" role="presentation" onClick={onClose}>
      <div
        aria-label="Command palette"
        aria-modal="true"
        className="command-palette"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelected((value) => Math.min(filtered.length - 1, value + 1));
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelected((value) => Math.max(0, value - 1));
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              runSelected();
            }
          }}
          placeholder="Run a command..."
          type="search"
        />
        <div className="command-palette__list">
          {filtered.length === 0 ? (
            <div className="command-palette__empty">No matching commands.</div>
          ) : (
            filtered.slice(0, 12).map((action, index) => (
              <button
                className={`command-palette__row ${index === selected ? 'is-selected' : ''}`}
                key={action.id}
                onClick={() => {
                  action.run();
                  onClose();
                }}
                type="button"
              >
                <strong>{action.title}</strong>
                {action.subtitle ? <span>{action.subtitle}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

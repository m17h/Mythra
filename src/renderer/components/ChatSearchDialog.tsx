import { useEffect, useRef, useState } from 'react';
import type { ChatSearchResult } from '@shared/types';

export function ChatSearchDialog({
  onClose,
  onOpenChat,
  open
}: {
  onClose: () => void;
  onOpenChat: (id: string) => void;
  open: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChatSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      return;
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      window.electronAPI
        .searchChats(q, 40)
        .then((rows) => {
          if (!cancelled) setResults(rows);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  if (!open) return null;

  return (
    <div className="app-dialog-backdrop app-dialog-backdrop--overlay-top" role="presentation" onClick={onClose}>
      <div className="app-dialog app-dialog--scrollable chat-search-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="app-dialog__kicker">Search</div>
        <h3>Chat history</h3>
        <input
          ref={inputRef}
          className="productivity-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
          }}
          placeholder="Search previous chats, Wizard sessions, and Nexus rooms"
          type="search"
        />
        <div className="chat-search-results">
          {loading ? <div className="productivity-empty">Searching...</div> : null}
          {!loading && query.trim() && results.length === 0 ? (
            <div className="productivity-empty">No matching chats.</div>
          ) : null}
          {results.map((result) => (
            <button
              className="chat-search-result"
              key={result.chatId}
              onClick={() => {
                onOpenChat(result.chatId);
                onClose();
              }}
              type="button"
            >
              <strong>{result.title}</strong>
              <small>{result.kind ?? 'normal'} - {new Date(result.updatedAt).toLocaleString()} - {result.matchCount} matches</small>
              <span>{result.snippet}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

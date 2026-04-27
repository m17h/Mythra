type Props = {
  webSearch: boolean;
  onWebSearchChange: (next: boolean) => void;
  disabled: boolean;
};

export function WebSearchMessageEmbed({ webSearch, onWebSearchChange, disabled }: Props) {
  return (
    <aside
      className="message-embed message-embed--web-search"
      aria-label="Web search for model"
    >
      <div className="message-embed__row">
        <span className="message-embed__label">Web search</span>
        <label
          className={`chat-panel__web-toggle message-embed__toggle ${disabled ? 'is-disabled' : ''} ${webSearch ? 'is-on' : ''}`}
          title="Allow the model to call web_search (DuckDuckGo) in Chat or Agent"
        >
          <input
            checked={webSearch}
            disabled={disabled}
            onChange={(e) => onWebSearchChange(e.target.checked)}
            type="checkbox"
          />
          <span className="chat-panel__web-toggle-track">
            <span className="chat-panel__web-toggle-knob" />
          </span>
        </label>
      </div>
    </aside>
  );
}

import type { SessionMode } from '@shared/types';

type Props = {
  sessionMode: SessionMode;
  onSessionModeToggle: () => void;
  disabled: boolean;
};

export function SessionModeMessageEmbed({ sessionMode, onSessionModeToggle, disabled }: Props) {
  const isChat = sessionMode === 'talk';
  return (
    <aside
      className="message-embed message-embed--session-mode"
      aria-label="Change session mode"
    >
      <div className="message-embed__row">
        <span className="message-embed__label">Session mode</span>
        <div className={`chat-panel__mode-toggle message-embed__toggle ${disabled ? 'is-disabled' : ''}`}>
          <button
            className={`chat-panel__mode-option ${isChat ? 'is-active' : ''}`}
            disabled={disabled}
            onClick={() => {
              if (!isChat) onSessionModeToggle();
            }}
            title="Plain chat (tools off)"
            type="button"
          >
            Chat
          </button>
          <button
            className={`chat-panel__mode-option ${!isChat ? 'is-active' : ''}`}
            disabled={disabled}
            onClick={() => {
              if (isChat) onSessionModeToggle();
            }}
            title="Tools on"
            type="button"
          >
            Tools
          </button>
          <span
            className="chat-panel__mode-slider"
            style={{ transform: isChat ? 'translateX(0)' : 'translateX(100%)' }}
          />
        </div>
      </div>
    </aside>
  );
}

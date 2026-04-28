import { AnimatePresence, motion } from 'framer-motion';

const dialogTransition = { duration: 0.18, ease: 'easeOut' as const };

interface SystemPromptModalProps {
  open: boolean;
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
}

export function SystemPromptModal({ open, value, onChange, onClose }: SystemPromptModalProps) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          animate={{ opacity: 1 }}
          className="app-dialog-backdrop"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          role="presentation"
        >
          <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            aria-describedby="system-prompt-modal-hint"
            aria-labelledby="system-prompt-modal-title"
            aria-modal="true"
            className="app-dialog app-dialog--system-prompt"
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            role="dialog"
            transition={dialogTransition}
          >
            <div className="app-dialog__kicker">Settings</div>
            <h3 id="system-prompt-modal-title">System prompt</h3>
            <p className="system-prompt-modal__hint" id="system-prompt-modal-hint">
              Changes apply in memory to the active provider. Use <strong>Save</strong> in Settings to write your profile
              to disk.
            </p>
            <textarea
              autoFocus
              className="system-prompt-modal__textarea"
              id="system-prompt-modal-field"
              onChange={(e) => onChange(e.target.value)}
              spellCheck={false}
              value={value}
            />
            <div className="app-dialog__actions">
              <button className="btn btn--primary" onClick={onClose} type="button">
                Done
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

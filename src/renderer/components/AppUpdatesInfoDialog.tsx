import { AnimatePresence, motion } from 'framer-motion';

const dialogTransition = { duration: 0.18, ease: 'easeOut' as const };

interface AppUpdatesInfoDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AppUpdatesInfoDialog({ open, onClose }: AppUpdatesInfoDialogProps) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          animate={{ opacity: 1 }}
          className="app-dialog-backdrop"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          onClick={onClose}
          role="presentation"
        >
          <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            aria-describedby="app-updates-info-desc"
            aria-labelledby="app-updates-info-title"
            aria-modal="true"
            className="app-dialog"
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            transition={dialogTransition}
          >
            <div className="app-dialog__kicker">App updates</div>
            <h3 id="app-updates-info-title">Need help or want something changed?</h3>
            <p id="app-updates-info-desc">
              Email <strong>support@morgangermani.com</strong> if you have a feature request, found a bug, or need help
              with Mythra.
            </p>

            <div className="app-dialog__actions">
              <button className="btn btn--primary" onClick={onClose} type="button">
                Got it
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

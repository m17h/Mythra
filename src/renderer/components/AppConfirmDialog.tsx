import { AnimatePresence, motion } from 'framer-motion';
import { type ReactNode, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';

const dialogTransition = { duration: 0.18, ease: 'easeOut' as const };

export interface AppConfirmDialogProps {
  open: boolean;
  kicker?: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: 'primary' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}

export function AppConfirmDialog({
  open,
  kicker,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  onConfirm,
  onCancel
}: AppConfirmDialogProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const descId = `${uid}-desc`;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          animate={{ opacity: 1 }}
          className="app-dialog-backdrop app-dialog-backdrop--overlay-top"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          role="presentation"
        >
          <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            aria-describedby={descId}
            aria-labelledby={titleId}
            aria-modal="true"
            className="app-dialog"
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            role="dialog"
            transition={dialogTransition}
          >
            {kicker ? <div className="app-dialog__kicker">{kicker}</div> : null}
            <h3 id={titleId}>{title}</h3>
            <p id={descId}>{description}</p>
            <div className="app-dialog__actions">
              <button className="btn btn--secondary" onClick={onCancel} type="button">
                {cancelLabel}
              </button>
              <button
                className={`btn ${confirmVariant === 'danger' ? 'btn--danger' : 'btn--primary'}`}
                onClick={onConfirm}
                type="button"
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body
  );
}

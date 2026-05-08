import { AnimatePresence, motion } from 'framer-motion';
import type { ReleaseNotesCache } from '@shared/types';

const dialogTransition = { duration: 0.18, ease: 'easeOut' as const };

interface ReleaseNotesDialogProps {
  open: boolean;
  cache: ReleaseNotesCache | null;
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

function formatReleaseDate(value: string | null | undefined): string {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

export function ReleaseNotesDialog({ open, cache, loading, onClose, onRefresh }: ReleaseNotesDialogProps) {
  const releases = cache?.releases ?? [];

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
            aria-labelledby="release-notes-title"
            aria-modal="true"
            className="app-dialog app-dialog--release-notes"
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            transition={dialogTransition}
          >
            <div className="app-dialog__kicker">Release notes</div>
            <h3 id="release-notes-title">What changed in Mythra</h3>
            <p>
              {cache?.fetchedAt
                ? `Last synced ${formatReleaseDate(cache.fetchedAt)}. Saved notes stay available offline.`
                : 'Saved notes stay available offline after Mythra syncs them once.'}
            </p>

            <div className="release-notes-list">
              {loading && releases.length === 0 ? (
                <div className="release-notes-empty">Loading release notes...</div>
              ) : null}

              {!loading && releases.length === 0 ? (
                <div className="release-notes-empty">
                  <strong>No saved release notes yet</strong>
                  <span>Connect to the internet and check again after the releases repo has published releases.</span>
                </div>
              ) : null}

              {releases.map((release) => (
                <article className="release-note-card" key={`${release.version}-${release.publishedAt ?? ''}`}>
                  <div className="release-note-card__header">
                    <strong>Mythra {release.version}</strong>
                    <span>
                      {release.title !== release.version ? release.title : 'Release notes'} ·{' '}
                      {formatReleaseDate(release.publishedAt)}
                    </span>
                  </div>
                  <p>{release.body || 'No release notes were added for this version.'}</p>
                </article>
              ))}
            </div>

            <div className="app-dialog__actions">
              <button className="btn btn--secondary" disabled={loading} onClick={onRefresh} type="button">
                {loading ? 'Refreshing...' : 'Refresh'}
              </button>
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

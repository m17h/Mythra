import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import type { BrowserWindow } from 'electron';

/** Same heavy dirs as workspace tree builder — skip noisy watch churn. */
const WATCH_IGNORE_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'out',
  'build',
  'coverage'
]);

const WATCH_DEBOUNCE_MS = 380;
/** When recursive directory watch is unavailable, poll periodically so nested edits still refresh. */
const POLL_FALLBACK_MS = 2000;

function shouldIgnoreWatchPath(rel: string | null): boolean {
  if (rel == null || rel === '') return false;
  const norm = rel.replace(/\\/g, '/');
  for (const seg of norm.split('/')) {
    if (!seg) continue;
    if (seg === '.DS_Store' || seg === 'Thumbs.db') return true;
    if (WATCH_IGNORE_SEGMENTS.has(seg)) return true;
  }
  return false;
}

function relToString(rel: string | Buffer | null): string | null {
  if (rel == null) return null;
  return typeof rel === 'string' ? rel : rel.toString('utf8');
}

/**
 * Watches the open workspace so the file tree updates when the disk changes outside the app
 * (Finder, terminal, external editor). Uses recursive fs.watch where supported (macOS, Windows);
 * falls back to root-level watch plus polling when recursive mode is not available (Linux).
 */
export class WorkspaceWatchController {
  private fsWatcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private getWindow: () => BrowserWindow | null) {}

  stop(): void {
    if (this.emitTimer != null) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    if (this.pollTimer != null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.fsWatcher != null) {
      this.fsWatcher.removeAllListeners();
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  setRoot(root: string): void {
    this.stop();
    const absRoot = resolve(root);

    const flush = () => {
      this.emitTimer = null;
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;
      win.webContents.send('workspace:changed', { root: absRoot });
    };

    const scheduleEmit = () => {
      if (this.emitTimer != null) clearTimeout(this.emitTimer);
      this.emitTimer = setTimeout(flush, WATCH_DEBOUNCE_MS);
    };

    const onFsEvent = (_evt: string, rel: string | Buffer | null) => {
      const asStr = relToString(rel);
      if (shouldIgnoreWatchPath(asStr)) return;
      scheduleEmit();
    };

    let usedRecursive = false;
    try {
      this.fsWatcher = watch(absRoot, { recursive: true }, onFsEvent);
      usedRecursive = true;
    } catch {
      try {
        this.fsWatcher = watch(absRoot, onFsEvent);
      } catch {
        this.fsWatcher = null;
      }
    }

    this.fsWatcher?.on('error', () => scheduleEmit());

    if (!usedRecursive) {
      this.pollTimer = setInterval(scheduleEmit, POLL_FALLBACK_MS);
    }
  }
}

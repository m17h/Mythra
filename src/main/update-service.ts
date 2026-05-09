import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { app, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import type {
  AppReleaseNote,
  AppUpdateCheckResult,
  AppUpdateEvent,
  AppUpdateProgress,
  ReleaseAssetInfo,
  ReleaseNotesCache
} from '@shared/types';

const RELEASES_API_URL = 'https://api.github.com/repos/m17h/Mythra-Releases/releases?per_page=100';
const RELEASE_NOTES_CACHE_FILE = 'release-notes.json';
const APP_UPDATE_CONFIG_FILE = 'app-update.yml';
const { autoUpdater } = electronUpdater;
const UPDATE_FEED = {
  provider: 'github' as const,
  owner: 'm17h',
  repo: 'Mythra-Releases',
  private: false
};

interface GithubAsset {
  name?: unknown;
  size?: unknown;
  browser_download_url?: unknown;
  content_type?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

function releaseNotesCachePath() {
  return join(app.getPath('userData'), RELEASE_NOTES_CACHE_FILE);
}

function appUpdateConfigPath() {
  return join(app.getPath('userData'), APP_UPDATE_CONFIG_FILE);
}

function appUpdateConfigYaml() {
  return [
    'provider: github',
    `owner: ${UPDATE_FEED.owner}`,
    `repo: ${UPDATE_FEED.repo}`,
    'updaterCacheDirName: mythra-updater',
    ''
  ].join('\n');
}

function normalizeReleaseTag(tag: string): string {
  return tag.trim().replace(/^app-/i, '').replace(/^v/i, '');
}

function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    normalizeReleaseTag(value)
      .split(/[.-]/)
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length, 3);
  for (let i = 0; i < len; i += 1) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function sanitizeReleaseBody(body: string): string {
  return body
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/(?:www\.)?github\.com\/\S+/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function assetPlatform(name: string): ReleaseAssetInfo['platform'] {
  const n = name.toLowerCase();
  if (n.endsWith('.exe') || n.includes('win')) return 'win';
  if (n.endsWith('.dmg') || n.includes('mac') || n.includes('darwin') || n.includes('arm64-notarized')) return 'mac';
  return 'other';
}

function normalizeAsset(raw: GithubAsset): ReleaseAssetInfo | null {
  if (typeof raw.name !== 'string' || typeof raw.browser_download_url !== 'string') return null;
  return {
    name: raw.name,
    size: typeof raw.size === 'number' ? raw.size : 0,
    downloadUrl: raw.browser_download_url,
    contentType: typeof raw.content_type === 'string' ? raw.content_type : undefined,
    platform: assetPlatform(raw.name)
  };
}

function normalizeRelease(raw: GithubRelease): (AppReleaseNote & { draft: boolean; assets: ReleaseAssetInfo[] }) | null {
  if (typeof raw.tag_name !== 'string') return null;
  const version = normalizeReleaseTag(raw.tag_name);
  const title =
    typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : raw.tag_name.trim();
  const assets = Array.isArray(raw.assets)
    ? raw.assets.map((asset) => normalizeAsset(asset as GithubAsset)).filter((asset): asset is ReleaseAssetInfo => Boolean(asset))
    : [];
  return {
    version,
    title,
    body: sanitizeReleaseBody(typeof raw.body === 'string' ? raw.body : ''),
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : null,
    prerelease: raw.prerelease === true,
    draft: raw.draft === true,
    assets
  };
}

function chooseDownloadAsset(assets: ReleaseAssetInfo[]): ReleaseAssetInfo | undefined {
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'other';
  const platformAssets = assets.filter((asset) => asset.platform === platform);
  if (platform === 'win') {
    return (
      platformAssets.find((asset) => /setup.*\.exe$/i.test(asset.name)) ??
      platformAssets.find((asset) => /\.exe$/i.test(asset.name)) ??
      platformAssets[0]
    );
  }
  if (platform === 'mac') {
    return (
      platformAssets.find((asset) => process.arch === 'arm64' && /arm64/i.test(asset.name)) ??
      platformAssets.find((asset) => /\.dmg$/i.test(asset.name)) ??
      platformAssets.find((asset) => /\.zip$/i.test(asset.name)) ??
      platformAssets[0]
    );
  }
  return platformAssets[0] ?? assets[0];
}

function releaseFromUpdateInfo(info: UpdateInfo): AppReleaseNote {
  const notes =
    typeof info.releaseNotes === 'string'
      ? info.releaseNotes
      : Array.isArray(info.releaseNotes)
        ? info.releaseNotes.map((note) => note.note).join('\n\n')
        : '';
  return {
    version: normalizeReleaseTag(info.version),
    title: info.releaseName?.trim() || info.version,
    body: sanitizeReleaseBody(notes),
    publishedAt: info.releaseDate || null,
    prerelease: false
  };
}

function progressFromElectron(info: ProgressInfo): AppUpdateProgress {
  return {
    percent: Number.isFinite(info.percent) ? info.percent : 0,
    transferred: info.transferred,
    total: info.total,
    bytesPerSecond: info.bytesPerSecond
  };
}

async function fetchGithubReleases(): Promise<Array<AppReleaseNote & { draft: boolean; assets: ReleaseAssetInfo[] }>> {
  const response = await fetch(RELEASES_API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Mythra'
    }
  });
  const body = await response.text();
  if (!response.ok) {
    let message = body.trim();
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // Keep raw response text.
    }
    throw new Error(`Release lookup failed (HTTP ${response.status}): ${message || response.statusText}`);
  }
  const parsed = JSON.parse(body) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((release) => normalizeRelease(release as GithubRelease))
    .filter((release): release is AppReleaseNote & { draft: boolean; assets: ReleaseAssetInfo[] } => Boolean(release))
    .filter((release) => !release.draft);
}

export class UpdateService {
  private checking = false;
  private downloading = false;
  private latestUpdate: AppReleaseNote | undefined;
  private updaterConfigReady: Promise<void> | null = null;

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.setFeedURL(UPDATE_FEED);

    autoUpdater.on('checking-for-update', () => {
      this.emit({ status: 'checking' });
    });
    autoUpdater.on('update-available', (info) => {
      this.latestUpdate = releaseFromUpdateInfo(info);
      this.emit({ status: 'available', update: this.latestUpdate });
    });
    autoUpdater.on('update-not-available', (info) => {
      this.emit({
        status: 'not-available',
        currentVersion: app.getVersion(),
        latestVersion: info.version ? normalizeReleaseTag(info.version) : undefined
      });
    });
    autoUpdater.on('download-progress', (progress) => {
      this.emit({ status: 'downloading', update: this.latestUpdate, progress: progressFromElectron(progress) });
    });
    autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      this.downloading = false;
      this.latestUpdate = releaseFromUpdateInfo(event);
      this.emit({ status: 'downloaded', update: this.latestUpdate });
      setTimeout(() => {
        this.emit({ status: 'installing', update: this.latestUpdate });
        /** Windows NSIS updates should run in updater/silent mode, not as the interactive installer UI. */
        autoUpdater.quitAndInstall(process.platform === 'win32', true);
      }, 700);
    });
    autoUpdater.on('error', (error) => {
      this.checking = false;
      this.downloading = false;
      this.emit({ status: 'error', error: error.message || String(error) });
    });
  }

  private async ensureUpdaterConfig() {
    if (!this.updaterConfigReady) {
      this.updaterConfigReady = (async () => {
        const configPath = appUpdateConfigPath();
        await mkdir(app.getPath('userData'), { recursive: true });
        await writeFile(configPath, appUpdateConfigYaml(), 'utf8');
        autoUpdater.updateConfigPath = configPath;
        autoUpdater.setFeedURL(UPDATE_FEED);
      })();
    }
    await this.updaterConfigReady;
  }

  private emit(event: AppUpdateEvent) {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('app:update-event', event);
    }
  }

  async getReleaseNotes(): Promise<ReleaseNotesCache> {
    try {
      const raw = await readFile(releaseNotesCachePath(), 'utf8');
      const parsed = JSON.parse(raw) as ReleaseNotesCache;
      if (!Array.isArray(parsed.releases)) return { fetchedAt: null, releases: [] };
      return parsed;
    } catch {
      return { fetchedAt: null, releases: [] };
    }
  }

  async refreshReleaseNotes(): Promise<ReleaseNotesCache> {
    const releases = await fetchGithubReleases();
    const cache: ReleaseNotesCache = {
      fetchedAt: new Date().toISOString(),
      releases: releases.map(({ assets: _assets, draft: _draft, ...release }) => release)
    };
    await writeFile(releaseNotesCachePath(), JSON.stringify(cache, null, 2), 'utf8');
    return cache;
  }

  refreshReleaseNotesInBackground() {
    void this.refreshReleaseNotes().catch((error) => {
      console.warn(`Could not refresh release notes cache: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async checkForUpdates(currentVersion: string): Promise<AppUpdateCheckResult> {
    if (this.checking) {
      return {
        ok: false,
        currentVersion,
        error: 'An update check is already running.'
      };
    }
    this.checking = true;
    try {
      const releases = await fetchGithubReleases();
      const latest = releases.find((release) => !release.prerelease) ?? releases[0];
      if (!latest) {
        return {
          ok: true,
          currentVersion,
          latestVersion: currentVersion,
          updateAvailable: false,
          assets: []
        };
      }
      const updateAvailable = compareVersions(latest.version, currentVersion) > 0;
      if (updateAvailable) {
        this.latestUpdate = latest;
      }
      return {
        ok: true,
        currentVersion,
        latestVersion: latest.version,
        updateAvailable,
        release: latest,
        assets: latest.assets,
        downloadAsset: chooseDownloadAsset(latest.assets)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        currentVersion,
        error: message
      };
    } finally {
      this.checking = false;
    }
  }

  async downloadAndInstallUpdate(): Promise<{ ok: boolean; error?: string }> {
    if (this.downloading) {
      return { ok: true };
    }
    this.downloading = true;
    try {
      await this.ensureUpdaterConfig();
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        this.downloading = false;
        this.emit({ status: 'not-available', currentVersion: app.getVersion(), latestVersion: result?.updateInfo.version });
        return { ok: false, error: 'No update is available to install.' };
      }
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (error) {
      this.downloading = false;
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ status: 'error', error: message });
      return { ok: false, error: message };
    }
  }
}

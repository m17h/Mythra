import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { app } from 'electron';
import type { AppReleaseNote, AppUpdateCheckResult, ReleaseAssetInfo, ReleaseNotesCache } from '@shared/types';

const RELEASES_API_URL = 'https://api.github.com/repos/m17h/Mythra-Releases/releases?per_page=100';
const RELEASE_NOTES_CACHE_FILE = 'release-notes.json';

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
      return {
        ok: false,
        currentVersion,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

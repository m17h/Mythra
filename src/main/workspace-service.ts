import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { dialog } from 'electron';
import type { OpenFile, WizardDocument, WizardProfile, WizardSetupRequest, WizardSetupResult, WorkspaceChanges, WorkspaceNode } from '@shared/types';
import { sanitizeWizardFolderSegment } from '@shared/wizard-folder';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'out', 'build', 'coverage']);
const MAX_TREE_DEPTH = 10;
const MAX_LIST_DEPTH = 24;
const MAX_TREE_ENTRIES = 2_500;
const MAX_LIST_ENTRIES = 5_000;
const MAX_SEARCH_FILES = 1_500;
const MAX_SEARCH_FILE_BYTES = 500_000;
const execFileAsync = promisify(execFile);
const WIZARD_CORE_DOCS = [
  ['soul.md', 'Soul'],
  ['tools.md', 'Tools'],
  ['memory.md', 'Memory'],
  ['corrections.md', 'Corrections']
] as const;

const WIZARD_DEFAULT_CONTENT: Record<string, (name: string) => string> = {
  'soul.md': (name) =>
    `# ${name}\n\nDescribe this Wizard's identity, tone, principles, strengths, boundaries, and working style here.\n`,
  'tools.md': () =>
    `# Tools\n\nDescribe preferred tools, workflows, commands, project conventions, and when this Wizard should use them.\n`,
  'memory.md': () =>
    `# Memory\n\nDurable notes this Wizard should remember across sessions.\n`,
  'corrections.md': () =>
    `# Corrections\n\nUser corrections, mistakes to avoid, and lessons learned.\n`
};

const normalizeDocName = (name: string) => {
  const base = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  if (!base) return null;
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
};

const isLikelyCloudPath = (root: string) => {
  const normalized = resolve(root);
  const parts = normalized.split(sep).map((part) => part.toLowerCase());
  const lower = normalized.toLowerCase();
  return (
    lower.includes(`${sep}library${sep}mobile documents${sep}`) ||
    lower.includes(`${sep}library${sep}cloudstorage${sep}`) ||
    parts.includes('dropbox') ||
    parts.some((part) => part.startsWith('googledrive')) ||
    parts.some((part) => part.startsWith('onedrive')) ||
    parts.includes('google drive') ||
    parts.includes('icloud drive')
  );
};

const assertLocalWorkspace = (root: string) => {
  if (isLikelyCloudPath(root)) {
    throw new Error('Choose a local folder. Synced cloud folders can cause file conflicts while a Wizard is editing.');
  }
};

const spawnWithInput = (cmd: string, args: string[], cwd: string, input: string) =>
  new Promise<void>((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
    });
    child.stdin.end(input);
  });

const ensureInsideRoot = (root: string, target: string) => {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(resolvedRoot, target);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(prefix)) {
    throw new Error('Target path is outside the active workspace.');
  }

  return resolvedTarget;
};

const sortNodes = (nodes: WorkspaceNode[]) =>
  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

const buildTree = async (root: string, depth = 0, budget = { remaining: MAX_TREE_ENTRIES }): Promise<WorkspaceNode[]> => {
  if (depth > MAX_TREE_DEPTH || budget.remaining <= 0) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const nodes: Array<WorkspaceNode | null> = await Promise.all(
    entries
      .filter((entry) => !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.DS_Store'))
      .map(async (entry) => {
        if (budget.remaining <= 0) {
          return null;
        }
        budget.remaining -= 1;
        const fullPath = resolve(root, entry.name);
        if (entry.isDirectory()) {
          const node: WorkspaceNode = {
            name: entry.name,
            path: fullPath,
            type: 'directory',
            children: await buildTree(fullPath, depth + 1, budget)
          };
          return node;
        }

        const node: WorkspaceNode = {
          name: entry.name,
          path: fullPath,
          type: 'file'
        };
        return node;
      })
  );

  return sortNodes(nodes.filter((node): node is WorkspaceNode => node != null));
};

const walkFiles = async (
  root: string,
  current: string,
  bucket: Array<{ path: string; type: WorkspaceNode['type'] }>,
  depth = 0
) => {
  if (depth > MAX_LIST_DEPTH || bucket.length >= MAX_LIST_ENTRIES) {
    return;
  }

  const entries = await readdir(current, { withFileTypes: true });
  const sorted = entries
    .filter((entry) => !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.DS_Store'))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  for (const entry of sorted) {
    if (bucket.length >= MAX_LIST_ENTRIES) {
      return;
    }
    const fullPath = resolve(current, entry.name);
    const type = entry.isDirectory() ? 'directory' : 'file';
    bucket.push({ path: relative(root, fullPath) || '.', type });
    if (entry.isDirectory()) {
      await walkFiles(root, fullPath, bucket, depth + 1);
    }
  }
};

const RASTER_IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
};

export class WorkspaceService {
  async assertUsableLocalWorkspace(root: string): Promise<string> {
    const resolved = resolve(root);
    assertLocalWorkspace(resolved);
    const st = await stat(resolved);
    if (!st.isDirectory()) {
      throw new Error('Workspace path is not a folder.');
    }
    return resolved;
  }

  async chooseWorkspace(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return this.assertUsableLocalWorkspace(result.filePaths[0]);
  }

  async chooseWizardWorkspace(defaultName: string, preferredDefaultPath?: string): Promise<string | null> {
    let defaultPath = join(process.env.HOME ?? '', 'Desktop', sanitizeWizardFolderSegment(defaultName));
    const trimmed = preferredDefaultPath?.trim();
    if (trimmed) {
      try {
        defaultPath = await this.assertUsableLocalWorkspace(trimmed);
      } catch {
        // Missing or invalid path — fall back to Desktop suggestion.
      }
    }

    const result = await dialog.showOpenDialog({
      buttonLabel: 'Use this folder',
      defaultPath,
      message: 'Choose a local folder for this Wizard.',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    assertLocalWorkspace(result.filePaths[0]);
    return result.filePaths[0];
  }

  /** Pick the folder that will contain one subfolder per Wizard (`<parent>/<sanitized name>/`). */
  async chooseWizardProjectsFolder(preferredDefaultPath?: string): Promise<string | null> {
    let defaultPath = join(process.env.HOME ?? '', 'Desktop');
    const trimmed = preferredDefaultPath?.trim();
    if (trimmed) {
      try {
        defaultPath = await this.assertUsableLocalWorkspace(trimmed);
      } catch {
        // Missing or invalid — fall back to Desktop.
      }
    }

    const result = await dialog.showOpenDialog({
      buttonLabel: 'Use this folder',
      defaultPath,
      message:
        'Choose a folder for Wizard workspaces. Each new Wizard will get its own subfolder inside here (named from the Wizard title).',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return this.assertUsableLocalWorkspace(result.filePaths[0]);
  }

  getRecommendedWizardWorkspace(name: string): string {
    return join(process.env.HOME ?? '', 'Desktop', sanitizeWizardFolderSegment(name));
  }

  async setupWizardWorkspace(request: WizardSetupRequest): Promise<WizardSetupResult> {
    const name = request.name.trim();
    if (!name) {
      throw new Error('Wizard name is required.');
    }
    if (!request.model.trim()) {
      throw new Error('Choose a model for this Wizard.');
    }

    let parentDir: string;
    const ws = request.workspaceRoot?.trim();
    if (ws) {
      parentDir = resolve(ws);
    } else if (request.createOnDesktop) {
      parentDir = resolve(join(process.env.HOME ?? '', 'Desktop'));
    } else {
      throw new Error(
        'Choose the folder where Wizard workspaces live. Each Wizard gets its own subfolder inside it.'
      );
    }

    assertLocalWorkspace(parentDir);
    const parentStat = await stat(parentDir).catch(() => null);
    if (!parentStat?.isDirectory()) {
      throw new Error('Wizard workspaces folder must be an existing local folder.');
    }

    const childSegment = sanitizeWizardFolderSegment(name);
    const root = resolve(join(parentDir, childSegment));

    try {
      await stat(root);
      throw new Error(
        `A Wizard folder "${childSegment}" already exists in that location. Choose a different Wizard name, or delete or rename that folder.`
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('A Wizard folder')) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    await mkdir(root, { recursive: true });

    const documents: WizardDocument[] = [];
    for (const [file, label] of WIZARD_CORE_DOCS) {
      const target = join(root, file);
      try {
        await writeFile(target, WIZARD_DEFAULT_CONTENT[file](name), { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      documents.push({ path: target, label, core: true });
    }

    const seen = new Set(WIZARD_CORE_DOCS.map(([file]) => file.toLowerCase()));
    for (const raw of request.customDocuments ?? []) {
      const file = normalizeDocName(raw);
      if (!file || seen.has(file.toLowerCase())) continue;
      seen.add(file.toLowerCase());
      const target = join(root, file);
      try {
        await writeFile(target, `# ${file.replace(/\.md$/i, '')}\n\n`, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      documents.push({ path: target, label: file.replace(/\.md$/i, ''), core: false });
    }

    const profile: WizardProfile = {
      name,
      workspaceRoot: root,
      provider: request.provider,
      model: request.model,
      systemPrompt: request.systemPrompt,
      documents
    };

    return {
      profile,
      tree: await this.getTree(root)
    };
  }

  /**
   * Renames the wizard workspace directory when its basename does not match the sanitized display name.
   * Keeps the same parent folder; updates `workspaceRoot` and absolute paths in `documents`.
   */
  async ensureWizardWorkspaceFolderMatchesDisplayName(profile: WizardProfile): Promise<WizardProfile> {
    const oldRoot = resolve(profile.workspaceRoot.trim());
    assertLocalWorkspace(oldRoot);
    await stat(oldRoot);

    const parent = dirname(oldRoot);
    const desiredBase = sanitizeWizardFolderSegment(profile.name);
    const newRoot = resolve(join(parent, desiredBase));

    if (newRoot === oldRoot) {
      return profile;
    }

    let destInWay = false;
    try {
      await stat(newRoot);
      destInWay = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (destInWay) {
      throw new Error(
        `Cannot rename workspace folder to "${desiredBase}" — that name is already taken in this location. Use a different Wizard name or remove/rename the conflicting folder.`
      );
    }

    await rename(oldRoot, newRoot);
    return this.remapWizardProfileRoots(profile, oldRoot, newRoot);
  }

  private remapWizardProfileRoots(profile: WizardProfile, oldRoot: string, newRoot: string): WizardProfile {
    const oldR = resolve(oldRoot);
    const newR = resolve(newRoot);
    const prefix = oldR.endsWith(sep) ? oldR : `${oldR}${sep}`;
    return {
      ...profile,
      workspaceRoot: newR,
      documents: profile.documents.map((d) => {
        const abs = resolve(d.path);
        if (abs === oldR || abs.startsWith(prefix)) {
          return { ...d, path: join(newR, relative(oldR, abs)) };
        }
        return d;
      })
    };
  }

  async getTree(root: string): Promise<WorkspaceNode[]> {
    await stat(root);
    return buildTree(root);
  }

  isInsideRoot(root: string, target: string): boolean {
    try {
      ensureInsideRoot(root, target);
      return true;
    } catch {
      return false;
    }
  }

  async openFile(root: string, target: string): Promise<OpenFile> {
    const safePath = ensureInsideRoot(root, target);
    const ext = extname(safePath).toLowerCase();

    if (ext === '.svg') {
      const content = await readFile(safePath, 'utf8');
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
      return {
        path: safePath,
        content,
        imagePreview: { mimeType: 'image/svg+xml', dataUrl }
      };
    }

    const rasterMime = RASTER_IMAGE_EXT[ext];
    if (rasterMime) {
      const buf = await readFile(safePath);
      const dataUrl = `data:${rasterMime};base64,${buf.toString('base64')}`;
      return {
        path: safePath,
        content: '',
        imagePreview: { mimeType: rasterMime, dataUrl }
      };
    }

    const content = await readFile(safePath, 'utf8');
    return { path: safePath, content };
  }

  async saveFile(root: string, target: string, content: string): Promise<OpenFile> {
    const safePath = ensureInsideRoot(root, target);
    await mkdir(dirname(safePath), { recursive: true });
    await writeFile(safePath, content, 'utf8');
    return this.openFile(root, target);
  }

  async replaceInFile(root: string, target: string, search: string, replacement: string, replaceAll: boolean) {
    if (!search) {
      throw new Error('Search text cannot be empty.');
    }
    const safePath = ensureInsideRoot(root, target);
    const content = await readFile(safePath, 'utf8');
    const count = content.split(search).length - 1;
    if (count === 0) {
      throw new Error('Search text was not found.');
    }
    const next = replaceAll ? content.split(search).join(replacement) : content.replace(search, replacement);
    await writeFile(safePath, next, 'utf8');
    return { path: safePath, replacements: replaceAll ? count : 1 };
  }

  async insertAfter(root: string, target: string, anchor: string, text: string) {
    if (!anchor) {
      throw new Error('Anchor text cannot be empty.');
    }
    const safePath = ensureInsideRoot(root, target);
    const content = await readFile(safePath, 'utf8');
    const index = content.indexOf(anchor);
    if (index < 0) {
      throw new Error('Anchor text was not found.');
    }
    const at = index + anchor.length;
    const next = `${content.slice(0, at)}${text}${content.slice(at)}`;
    await writeFile(safePath, next, 'utf8');
    return { path: safePath };
  }

  async renamePath(root: string, from: string, to: string) {
    const safeFrom = ensureInsideRoot(root, from);
    const safeTo = ensureInsideRoot(root, to);
    await mkdir(dirname(safeTo), { recursive: true });
    await rename(safeFrom, safeTo);
    return { from: safeFrom, to: safeTo };
  }

  async deletePath(root: string, target: string): Promise<{ path: string }> {
    const safePath = ensureInsideRoot(root, target);
    await rm(safePath, { recursive: true, force: false });
    return { path: safePath };
  }

  async deleteWorkspaceFolder(root: string): Promise<{ path: string }> {
    const safePath = resolve(root);
    assertLocalWorkspace(safePath);
    await rm(safePath, { recursive: true, force: true });
    return { path: safePath };
  }

  async listFiles(root: string): Promise<Array<{ path: string; type: WorkspaceNode['type'] }>> {
    const files: Array<{ path: string; type: WorkspaceNode['type'] }> = [];
    await stat(root);
    await walkFiles(resolve(root), resolve(root), files);
    return files;
  }

  async getChanges(root: string): Promise<WorkspaceChanges> {
    const cwd = resolve(root);
    try {
      const [status, diff] = await Promise.all([
        execFileAsync('git', ['status', '--short'], { cwd, maxBuffer: 2_000_000 }),
        execFileAsync('git', ['diff', '--', '.'], { cwd, maxBuffer: 8_000_000 })
      ]);
      return { ok: true, root: cwd, status: status.stdout, diff: diff.stdout };
    } catch (error) {
      return {
        ok: false,
        root: cwd,
        status: '',
        diff: '',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async applyPatch(root: string, patch: string) {
    if (!patch.trim()) {
      throw new Error('Patch cannot be empty.');
    }
    const cwd = resolve(root);
    await spawnWithInput('git', ['apply', '--whitespace=nowarn', '-'], cwd, patch);
    return this.getChanges(root);
  }

  async searchSymbols(root: string, query: string, limit = 50) {
    const q = query.trim().toLowerCase();
    if (!q) {
      throw new Error('search_symbols requires a query.');
    }
    const files = (await this.listFiles(root))
      .filter((entry) => entry.type === 'file')
      .slice(0, MAX_SEARCH_FILES);
    const results: Array<{ path: string; line: number; text: string }> = [];
    for (const entry of files) {
      if (results.length >= limit) break;
      const full = ensureInsideRoot(root, entry.path);
      try {
        const s = await stat(full);
        if (s.size > MAX_SEARCH_FILE_BYTES) continue;
        const content = await readFile(full, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && results.length < limit; i += 1) {
          const line = lines[i];
          if (!line.toLowerCase().includes(q)) continue;
          if (!/\b(class|function|const|let|var|interface|type|enum|def|struct|export|import)\b/.test(line)) continue;
          results.push({ path: entry.path, line: i + 1, text: line.trim() });
        }
      } catch {
        // ignore unreadable/binary files
      }
    }
    return results;
  }

  async getFileOutline(root: string, target: string) {
    const safePath = ensureInsideRoot(root, target);
    const content = await readFile(safePath, 'utf8');
    const ext = extname(safePath).toLowerCase();
    const lines = content.split(/\r?\n/);
    const patterns =
      ext === '.py'
        ? [/^\s*(?:async\s+)?def\s+([\w_]+)/, /^\s*class\s+([\w_]+)/]
        : [
            /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([\w$]+)/,
            /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=/,
            /^\s*(?:export\s+)?(?:interface|type|class|enum)\s+([\w$]+)/
          ];
    const outline: Array<{ line: number; name: string; text: string }> = [];
    for (let i = 0; i < lines.length; i += 1) {
      for (const pattern of patterns) {
        const match = pattern.exec(lines[i]);
        if (match?.[1]) {
          outline.push({ line: i + 1, name: match[1], text: lines[i].trim() });
          break;
        }
      }
    }
    return { path: relative(resolve(root), safePath), outline };
  }

  labelForRoot(root: string): string {
    return basename(root);
  }
}

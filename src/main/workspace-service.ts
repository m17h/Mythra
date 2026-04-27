import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { dialog } from 'electron';
import type { OpenFile, WorkspaceNode } from '@shared/types';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'out', 'build', 'coverage']);
const MAX_TREE_DEPTH = 10;
const MAX_LIST_DEPTH = 24;
const MAX_TREE_ENTRIES = 2_500;
const MAX_LIST_ENTRIES = 5_000;

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

export class WorkspaceService {
  async chooseWorkspace(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
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
    const content = await readFile(safePath, 'utf8');
    return { path: safePath, content };
  }

  async saveFile(root: string, target: string, content: string): Promise<OpenFile> {
    const safePath = ensureInsideRoot(root, target);
    await mkdir(dirname(safePath), { recursive: true });
    await writeFile(safePath, content, 'utf8');
    return { path: safePath, content };
  }

  async deletePath(root: string, target: string): Promise<{ path: string }> {
    const safePath = ensureInsideRoot(root, target);
    await rm(safePath, { recursive: true, force: false });
    return { path: safePath };
  }

  async listFiles(root: string): Promise<Array<{ path: string; type: WorkspaceNode['type'] }>> {
    const files: Array<{ path: string; type: WorkspaceNode['type'] }> = [];
    await stat(root);
    await walkFiles(resolve(root), resolve(root), files);
    return files;
  }

  labelForRoot(root: string): string {
    return basename(root);
  }
}

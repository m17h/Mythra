import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { dialog } from 'electron';
import type { OpenFile, WorkspaceNode } from '@shared/types';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'out', 'build']);
const MAX_DEPTH = 4;

const ensureInsideRoot = (root: string, target: string) => {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(resolvedRoot, target);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(prefix)) {
    throw new Error('Target path is outside the active workspace.');
  }

  return resolvedTarget;
};

const flattenNodes = (root: string, nodes: WorkspaceNode[], bucket: Array<{ path: string; type: WorkspaceNode['type'] }>) => {
  for (const node of nodes) {
    bucket.push({
      path: relative(root, node.path) || '.',
      type: node.type
    });

    if (node.children?.length) {
      flattenNodes(root, node.children, bucket);
    }
  }
};

const sortNodes = (nodes: WorkspaceNode[]) =>
  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

const buildTree = async (root: string, depth = 0): Promise<WorkspaceNode[]> => {
  if (depth > MAX_DEPTH) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const nodes = await Promise.all(
    entries
      .filter((entry) => !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.DS_Store'))
      .map(async (entry) => {
        const fullPath = resolve(root, entry.name);
        if (entry.isDirectory()) {
          return {
            name: entry.name,
            path: fullPath,
            type: 'directory' as const,
            children: await buildTree(fullPath, depth + 1)
          };
        }

        return {
          name: entry.name,
          path: fullPath,
          type: 'file' as const
        };
      })
  );

  return sortNodes(nodes);
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
    const tree = await this.getTree(root);
    const files: Array<{ path: string; type: WorkspaceNode['type'] }> = [];
    flattenNodes(root, tree, files);
    return files;
  }

  labelForRoot(root: string): string {
    return basename(root);
  }
}

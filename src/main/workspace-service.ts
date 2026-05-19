import { execFile, spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import { dialog } from 'electron';
import type {
  OpenFile,
  WizardDocument,
  WizardMythwizExportRequest,
  WizardMythwizImportedPayload,
  NexusSetupRequest,
  NexusSetupResult,
  WizardProfile,
  WizardSetupRequest,
  WizardSetupResult,
  WorkspaceChanges,
  WorkspaceNode
} from '@shared/types';
import { sanitizeWizardFolderSegment } from '@shared/wizard-folder';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'out', 'build', 'coverage']);
const MAX_TREE_DEPTH = 10;
const MAX_LIST_DEPTH = 24;
const MAX_TREE_ENTRIES = 2_500;
const MAX_LIST_ENTRIES = 5_000;
const MAX_SEARCH_FILES = 1_500;
const MAX_SEARCH_FILE_BYTES = 500_000;
const MAX_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024;
const MAX_PDF_READ_BYTES = 50 * 1024 * 1024;
const MAX_PDF_TEXT_CHARS = 1_000_000;
const MIN_PDF_TEXT_CHARS_BEFORE_OCR = 120;
const MAX_PDF_OCR_PAGES = 12;
const MAX_PDF_OCR_RENDER_PIXELS = 4_000_000;
const DEFAULT_PDF_RANGE_PAGE_COUNT = 24;
const MAX_MYTHWIZ_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_MYTHWIZ_FILES = 1_000;
const MAX_MYTHWIZ_FILE_CHARS = 5 * 1024 * 1024;
const MAX_MYTHWIZ_TOTAL_CHARS = 25 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const requireFromWorkspaceService = createRequire(import.meta.url);
const WIZARD_CORE_DOCS = [
  ['identity.md', 'Identity'],
  ['personality.md', 'Personality'],
  ['tools.md', 'Tools'],
  ['memory.md', 'Memory'],
  ['corrections.md', 'Corrections']
] as const;
const WIZARD_LEGACY_CORE_DOCS = [['soul.md', 'Soul (legacy)']] as const;

const WIZARD_DEFAULT_CONTENT: Record<string, (name: string) => string> = {
  'identity.md': (name) =>
    `# Identity\n\n- Name: ${name}\n- Role: Describe this Wizard's role, specialty, and purpose here.\n`,
  'personality.md': () =>
    `# Personality\n\nDescribe this Wizard's tone, principles, strengths, boundaries, and working style here.\n`,
  'tools.md': () =>
    `# Tools

## Mythra (this app)

- **Always** call \`read_file\` before editing so file content matches disk.
- **apply_patch**: unified diff only, valid for \`git apply\` from the Wizard workspace root. Context lines (those starting with a space) must match **exactly**—wrong spaces/tabs or stale lines cause \`corrupt patch\`. No markdown around the patch inside the tool JSON.
- If a patch fails, try a smaller hunk, \`replace_in_file\` for one exact match, or \`write_file\` for a full small file.
- Tools expect strict JSON (escaped newlines as \`\\n\` in strings).
- For financial, portfolio, budget, sales, CSV/table, forecast, scenario, or other numerical analysis, use Mythra data embeds when they make the answer clearer: \`mythra-stats\` for KPI cards, \`mythra-table\` for sortable row data, and \`mythra-chart\` for visuals. Always use the Mythra fence names, not plain \`json\` fences. Chart types include bar (single-series or grouped multi-series), line, pie, donut, stacked-bar (only when stacked categories across periods help), and budget (planned vs actual).
- **Default core files** Mythra creates are only identity, personality, tools, memory, and corrections—**not** \`todo.md\`. Add \`todo.md\` or any extra \`.md\` yourself if the user wants tasks, inboxes, or other always-loaded notes.

## Example directions (optional)

Users often dedicate a Wizard to: matching a **writing voice** (samples + personality); a **note system** (linked markdown in this folder); **one codebase or stack** (conventions here); or **research / meetings** (dated notes you maintain).

Describe your preferred stacks, scripts, test commands, and project conventions below.
`,
  'memory.md': () =>
    `# Memory\n\nDurable notes this Wizard should remember across sessions.\n`,
  'corrections.md': () =>
    `# Corrections\n\nUser corrections, mistakes to avoid, and lessons learned.\n`
};

function personalityMarkdownForWizard(personality?: string): string {
  const trimmed = personality?.trim();
  if (trimmed) {
    return `# Personality\n\n${trimmed}\n`;
  }
  return WIZARD_DEFAULT_CONTENT['personality.md']('');
}

function memoryMarkdownForWizard(memory?: string): string {
  const trimmed = memory?.trim();
  if (trimmed) {
    return `# Memory\n\n${trimmed}\n`;
  }
  return WIZARD_DEFAULT_CONTENT['memory.md']('');
}

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

const OUTSIDE_WORKSPACE_HINT =
  'Target path is outside the active workspace. Use paths relative to this workspace, or enable “Allow paths outside workspace” for this Wizard in Wizard settings (Inspector).';

const pathEquals = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

const pathStartsWith = (target: string, root: string) => {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (process.platform === 'win32') {
    return target.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return target.startsWith(prefix);
};

const pathInsideOrEqual = (target: string, root: string) =>
  pathEquals(target, root) || pathStartsWith(target, root);

async function nearestExistingPath(absPath: string): Promise<string> {
  let current = absPath;
  for (;;) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertRealPathInsideRoot(resolvedRoot: string, resolvedTarget: string) {
  const realRoot = await realpath(resolvedRoot);
  const existing = await nearestExistingPath(resolvedTarget);
  const realExisting = await realpath(existing);
  if (!pathInsideOrEqual(realExisting, realRoot)) {
    throw new Error(OUTSIDE_WORKSPACE_HINT);
  }
}

/** Resolve `target` against wizard/normal workspace root; optionally allow paths outside `root`. */
async function resolveWorkspaceTarget(root: string, target: string, allowOutsideWorkspace = false): Promise<string> {
  const resolvedRoot = resolve(root.trim());
  const raw = target.trim();
  if (!raw) {
    throw new Error('Path cannot be empty.');
  }

  const isAbsolute = raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw);
  const resolvedTarget = isAbsolute ? resolve(raw) : resolve(resolvedRoot, raw);

  if (!allowOutsideWorkspace) {
    if (!pathInsideOrEqual(resolvedTarget, resolvedRoot)) {
      throw new Error(OUTSIDE_WORKSPACE_HINT);
    }
    await assertRealPathInsideRoot(resolvedRoot, resolvedTarget);
  }

  assertLocalWorkspace(dirname(resolvedTarget));

  return resolvedTarget;
}

const ensureInsideRoot = (root: string, target: string) => resolveWorkspaceTarget(root, target, false);

function isInsideRootSync(root: string, target: string): boolean {
  try {
    const resolvedRoot = resolve(root.trim());
    const raw = target.trim();
    const isAbsolute = raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw);
    const resolvedTarget = isAbsolute ? resolve(raw) : resolve(resolvedRoot, raw);
    if (!pathInsideOrEqual(resolvedTarget, resolvedRoot)) return false;

    const realRoot = realpathSync(resolvedRoot);
    let current = resolvedTarget;
    for (;;) {
      try {
        statSync(current);
        const realExisting = realpathSync(current);
        return pathInsideOrEqual(realExisting, realRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        const parent = dirname(current);
        if (parent === current) return false;
        current = parent;
      }
    }
  } catch {
    return false;
  }
}

const normalizeWizardExportRelPath = (raw: string): string => {
  const posix = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = posix.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw new Error(`Invalid export path: ${raw}`);
  }
  return segments.join('/');
};

function zipEntryUncompressedSize(entry: JSZip.JSZipObject): number | undefined {
  const data = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data;
  return typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : undefined;
}

function assertMythwizTextBudget(path: string, content: string, totalChars: number) {
  if (content.length > MAX_MYTHWIZ_FILE_CHARS) {
    throw new Error(`Import file is too large: ${path}`);
  }
  if (totalChars + content.length > MAX_MYTHWIZ_TOTAL_CHARS) {
    throw new Error('Import bundle is too large.');
  }
}

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
const AUDIO_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.webm': 'audio/webm'
};
const MAX_BINARY_TOOL_BYTES = 25 * 1024 * 1024;

interface PdfExtractionResult {
  content: string;
  method: 'embedded-text' | 'ocr' | 'embedded-text-with-ocr-fallback';
  ocrApplied: boolean;
}

interface PdfReadOptions {
  startPage?: number;
  pageCount?: number;
  ocr?: 'auto' | 'on' | 'off';
}

interface PdfPageText {
  pageNumber: number;
  text: string;
  charCount: number;
  needsOcr: boolean;
}

function patchPdfCanvasContext(context: any) {
  // pdfjs passes Path2D objects that @napi-rs/canvas rejects on some PDFs; fall back to current-path calls for OCR renders.
  for (const methodName of ['clip', 'fill', 'stroke'] as const) {
    const original = context[methodName].bind(context);
    context[methodName] = (...args: unknown[]) => {
      try {
        return original(...args);
      } catch (error) {
        if (args.length > 0 && typeof args[0] === 'object') {
          return typeof args[1] === 'string' ? original(args[1]) : original();
        }
        throw error;
      }
    };
  }
}

async function renderPdfPageToPng(page: any): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const baseViewport = page.getViewport({ scale: 1 });
  const basePixels = Math.max(1, baseViewport.width * baseViewport.height);
  const scale = Math.min(2, Math.sqrt(MAX_PDF_OCR_RENDER_PIXELS / basePixels));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  patchPdfCanvasContext(context);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return canvas.toBuffer('image/png');
}

async function recognizePdfPage(worker: any, page: any, pageNumber: number): Promise<string> {
  const png = await renderPdfPageToPng(page);
  const tempDir = await mkdtemp(join(tmpdir(), 'mythra-pdf-ocr-'));
  const imagePath = join(tempDir, `page-${pageNumber}.png`);
  try {
    await writeFile(imagePath, png);
    const result = await worker.recognize(imagePath);
    return result.data.text.replace(/[ \t]+/g, ' ').trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function tesseractEnglishLangPath() {
  return `${dirname(requireFromWorkspaceService.resolve('@tesseract.js-data/eng/4.0.0/eng.traineddata.gz'))}${sep}`;
}

async function createOcrWorker() {
  const Tesseract = (await import('tesseract.js')).default;
  return Tesseract.createWorker('eng', 1, {
    cacheMethod: 'none',
    langPath: tesseractEnglishLangPath()
  });
}

function normalizePdfReadOptions(options?: PdfReadOptions): Required<PdfReadOptions> {
  const startPage = Number.isFinite(options?.startPage)
    ? Math.max(1, Math.floor(Number(options?.startPage)))
    : 1;
  const pageCount = Number.isFinite(options?.pageCount)
    ? Math.min(250, Math.max(1, Math.floor(Number(options?.pageCount))))
    : DEFAULT_PDF_RANGE_PAGE_COUNT;
  const ocr = options?.ocr === 'on' || options?.ocr === 'off' ? options.ocr : 'auto';
  return { startPage, pageCount, ocr };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatPdfPage(page: PdfPageText, ocrText?: string) {
  const chunks = [`--- Page ${page.pageNumber} ---`];
  chunks.push(page.text || '[No extractable embedded text]');
  if (page.needsOcr) {
    chunks.push('[OCR suggested: this page has little/no embedded text and may be scanned or image-based.]');
  }
  if (ocrText != null) {
    chunks.push(`--- Page ${page.pageNumber} OCR ---`);
    chunks.push(ocrText || '[No text recognized by OCR]');
  }
  return chunks.join('\n');
}

async function extractPdfText(filePath: string, options?: PdfReadOptions): Promise<PdfExtractionResult> {
  const st = await stat(filePath);
  if (st.size > MAX_PDF_READ_BYTES) {
    throw new Error(`PDF is too large to read (max ${Math.round(MAX_PDF_READ_BYTES / 1024 / 1024)} MB).`);
  }

  const readOptions = normalizePdfReadOptions(options);
  const buf = await readFile(filePath);
  const data = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true
  }).promise;

  const startPage = Math.min(readOptions.startPage, doc.numPages);
  const endPage = Math.min(doc.numPages, startPage + readOptions.pageCount - 1);
  const pageTexts: PdfPageText[] = [];
  try {
    for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item) => ('str' in item ? item.str : ''))
        .filter(Boolean)
        .join(' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
      pageTexts.push({
        pageNumber,
        text,
        charCount: text.length,
        needsOcr: text.length < MIN_PDF_TEXT_CHARS_BEFORE_OCR
      });
    }

    const ocrTargets =
      readOptions.ocr === 'off'
        ? []
        : readOptions.ocr === 'on'
          ? pageTexts
          : pageTexts.filter((page) => page.needsOcr);
    const limitedOcrTargets = ocrTargets.slice(0, MAX_PDF_OCR_PAGES);
    const ocrByPage = new Map<number, string>();

    if (limitedOcrTargets.length > 0) {
      const worker = await createOcrWorker();
      try {
        for (const target of limitedOcrTargets) {
          const page = await doc.getPage(target.pageNumber);
          try {
            ocrByPage.set(target.pageNumber, await recognizePdfPage(worker, page, target.pageNumber));
          } catch (error) {
            ocrByPage.set(target.pageNumber, `[OCR failed for this page: ${errorMessage(error)}]`);
          }
        }
      } finally {
        await worker.terminate();
      }
    }

    const parts = [
      `PDF read: pages ${startPage}-${endPage} of ${doc.numPages}.`,
      readOptions.ocr === 'off'
        ? 'OCR: off for this read.'
        : ocrByPage.size > 0
          ? `OCR: ran on page${ocrByPage.size === 1 ? '' : 's'} ${[...ocrByPage.keys()].join(', ')}.`
          : 'OCR: not needed for this read.'
    ];
    if (ocrTargets.length > limitedOcrTargets.length) {
      parts.push(
        `OCR limit: processed ${limitedOcrTargets.length} of ${ocrTargets.length} requested/suggested pages. Read a narrower page range to OCR more.`
      );
    }
    if (endPage < doc.numPages) {
      parts.push(`More pages available: call read_file with pdf_start_page ${endPage + 1}.`);
    }
    parts.push(...pageTexts.map((page) => formatPdfPage(page, ocrByPage.get(page.pageNumber))));

    const embeddedChars = pageTexts.reduce((sum, page) => sum + page.charCount, 0);
    const content = parts.join('\n\n').slice(0, MAX_PDF_TEXT_CHARS);
    const ocrApplied = ocrByPage.size > 0;
    return {
      content,
      method: ocrApplied ? (embeddedChars > 0 ? 'embedded-text-with-ocr-fallback' : 'ocr') : 'embedded-text',
      ocrApplied
    };
  } finally {
    await doc.destroy();
  }
}

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

  async chooseNexusWorkspace(preferredDefaultPath?: string): Promise<string | null> {
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
        'Choose a folder for Nexus project workspaces. Each new Nexus project will get its own subfolder inside here (named from the project title).',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return this.assertUsableLocalWorkspace(result.filePaths[0]);
  }

  async setupNexusWorkspace(request: NexusSetupRequest): Promise<NexusSetupResult> {
    const name = request.name.trim();
    if (!name) {
      throw new Error('Nexus project name is required.');
    }

    const parentDir = resolve(request.workspaceRoot.trim());
    assertLocalWorkspace(parentDir);
    const parentStat = await stat(parentDir).catch(() => null);
    if (!parentStat?.isDirectory()) {
      throw new Error('Nexus projects folder must be an existing local folder.');
    }

    const childSegment = sanitizeWizardFolderSegment(name);
    const root = resolve(join(parentDir, childSegment));

    try {
      await stat(root);
      throw new Error(
        `A Nexus project folder "${childSegment}" already exists in that location. Choose a different project name, or delete or rename that folder.`
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('A Nexus project folder')) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    await mkdir(root, { recursive: true });
    return {
      workspaceRoot: root,
      tree: await this.getTree(root)
    };
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

    for (const [file] of WIZARD_CORE_DOCS) {
      const target = join(root, file);
      const initialBody =
        file === 'personality.md'
          ? personalityMarkdownForWizard(request.wizardPersonality)
          : file === 'memory.md'
            ? memoryMarkdownForWizard(request.wizardMemory)
            : WIZARD_DEFAULT_CONTENT[file](name);
      try {
        await writeFile(target, initialBody, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
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
    }

    if (request.mythwizWorkspaceFiles?.length) {
      if (request.mythwizWorkspaceFiles.length > MAX_MYTHWIZ_FILES) {
        throw new Error(`Import bundle has too many files (max ${MAX_MYTHWIZ_FILES}).`);
      }
      let importedChars = 0;
      for (const { relativePath, content } of request.mythwizWorkspaceFiles) {
        const safe = normalizeWizardExportRelPath(relativePath);
        assertMythwizTextBudget(safe, content, importedChars);
        importedChars += content.length;
        const abs = await ensureInsideRoot(root, safe);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf8');
      }
    }

    const documents = await this.listWizardWorkspaceDocuments(root);

    const profile: WizardProfile = {
      name,
      workspaceRoot: root,
      provider: request.provider,
      model: request.model,
      systemPrompt: request.systemPrompt,
      documents,
      fullAccess: false
    };

    return {
      profile,
      tree: await this.getTree(root)
    };
  }

  /**
   * All `.md` files under the Wizard workspace (recursive; skips ignored dirs like node_modules).
   * Core scaffold filenames first (in fixed order), then every other Markdown path sorted lexically.
   */
  async listWizardWorkspaceDocuments(workspaceRoot: string): Promise<WizardDocument[]> {
    const resolved = resolve(workspaceRoot.trim());
    try {
      const st = await stat(resolved);
      if (!st.isDirectory()) throw new Error('Not a directory');
    } catch {
      throw new Error('Wizard workspace is not available.');
    }

    const bucket: Array<{ path: string; type: WorkspaceNode['type'] }> = [];
    await walkFiles(resolved, resolved, bucket);

    const displayCoreDocs = [...WIZARD_CORE_DOCS, ...WIZARD_LEGACY_CORE_DOCS] as const;
    const coreMap = new Map(displayCoreDocs.map(([f, label]) => [f.toLowerCase(), label]));
    const coreOrder = displayCoreDocs.map(([f]) => f.toLowerCase());

    const mdRelPaths = bucket
      .filter((x) => x.type === 'file' && /\.md$/i.test(x.path))
      .map((x) => x.path.replace(/\\/g, '/'));

    mdRelPaths.sort((a, b) => {
      const ba = basename(a).toLowerCase();
      const bb = basename(b).toLowerCase();
      const ia = coreOrder.indexOf(ba);
      const ib = coreOrder.indexOf(bb);
      if (ia !== -1 || ib !== -1) {
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        if (ia !== ib) return ia - ib;
        return a.localeCompare(b);
      }
      return a.localeCompare(b);
    });

    return mdRelPaths.map((rel) => {
      const abs = resolve(resolved, rel);
      const lower = basename(rel).toLowerCase();
      const label = coreMap.get(lower) ?? rel.replace(/\.md$/i, '');
      return {
        path: abs,
        label,
        core: coreMap.has(lower)
      };
    });
  }

  /** Relative POSIX paths of files under this Wizard workspace (for export UI). Ignores dotfiles and heavy dirs like node_modules. */
  async listWizardExportRelativeFiles(workspaceRoot: string): Promise<string[]> {
    const resolved = resolve(workspaceRoot.trim());
    assertLocalWorkspace(resolved);
    await stat(resolved);
    const bucket: Array<{ path: string; type: WorkspaceNode['type'] }> = [];
    await walkFiles(resolved, resolved, bucket);
    return bucket
      .filter((x) => x.type === 'file')
      .map((x) => (x.path === '.' ? '' : x.path.replace(/\\/g, '/')))
      .filter((p) => p.length > 0)
      .sort((a, b) => a.localeCompare(b));
  }

  async buildWizardMythwizArchive(req: WizardMythwizExportRequest): Promise<Buffer> {
    const root = resolve(req.workspaceRoot.trim());
    assertLocalWorkspace(root);
    await stat(root);

    let normalizedPaths: string[];
    try {
      normalizedPaths = [...new Set(req.workspaceRelativePaths.map(normalizeWizardExportRelPath))];
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }

    if (!req.includeSystemPromptFile && normalizedPaths.length === 0) {
      throw new Error('Select at least one item to export.');
    }

    const zip = new JSZip();
    const exportedAt = new Date().toISOString();
    const missingFromDisk: string[] = [];
    const workspaceWritten: string[] = [];

    for (const rel of normalizedPaths) {
      try {
        const abs = await ensureInsideRoot(root, rel);
        await stat(abs);
        const buf = await readFile(abs);
        zip.file(`workspace/${rel}`, buf);
        workspaceWritten.push(rel);
      } catch {
        missingFromDisk.push(rel);
      }
    }

    if (missingFromDisk.length > 0) {
      throw new Error(`Could not read on disk: ${missingFromDisk.join(', ')}`);
    }

    if (req.includeSystemPromptFile) {
      zip.file('system_prompt.md', req.systemPrompt ?? '', { createFolders: false });
    }

    const manifest = {
      format: 'mythwiz',
      version: 1,
      exportedAt,
      wizardDisplayName: req.wizardDisplayName,
      includesSystemPromptFile: Boolean(req.includeSystemPromptFile),
      workspacePaths: workspaceWritten
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    const nodeBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return Buffer.from(nodeBuf);
  }

  /** Read a `.mythwiz` ZIP produced by Mythra export (manifest, optional system_prompt.md, and workspace/ files). */
  async parseWizardMythwizBuffer(buffer: Buffer): Promise<WizardMythwizImportedPayload> {
    if (buffer.length > MAX_MYTHWIZ_ARCHIVE_BYTES) {
      throw new Error(`Import bundle is too large (max ${Math.round(MAX_MYTHWIZ_ARCHIVE_BYTES / 1024 / 1024)} MB).`);
    }

    const zip = await JSZip.loadAsync(buffer);
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) {
      throw new Error('This file has no manifest.json — pick a Mythra .mythwiz export.');
    }
    const manifestSize = zipEntryUncompressedSize(manifestFile);
    if (manifestSize != null && manifestSize > MAX_MYTHWIZ_FILE_CHARS) {
      throw new Error('manifest.json is too large.');
    }
    let manifest: { format?: string; version?: number; wizardDisplayName?: string };
    try {
      manifest = JSON.parse(await manifestFile.async('string')) as typeof manifest;
    } catch {
      throw new Error('Could not parse manifest.json in this bundle.');
    }
    if (manifest.format !== 'mythwiz') {
      throw new Error('This file is not a Mythra Wizard bundle.');
    }
    if (manifest.version !== 1) {
      throw new Error(`Unsupported mythwiz format version (${String(manifest.version)}).`);
    }

    let systemPrompt = '';
    const spFile = zip.file('system_prompt.md');
    if (spFile) {
      const systemPromptSize = zipEntryUncompressedSize(spFile);
      if (systemPromptSize != null && systemPromptSize > MAX_MYTHWIZ_FILE_CHARS) {
        throw new Error('system_prompt.md is too large.');
      }
      systemPrompt = await spFile.async('string');
      assertMythwizTextBudget('system_prompt.md', systemPrompt, 0);
    }

    const workspaceFiles: WizardMythwizImportedPayload['workspaceFiles'] = [];
    const prefix = 'workspace/';
    let totalChars = systemPrompt.length;
    for (const [fullPath, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const normalizedZipPath = fullPath.replace(/\\/g, '/');
      if (!normalizedZipPath.startsWith(prefix)) continue;
      if (workspaceFiles.length >= MAX_MYTHWIZ_FILES) {
        throw new Error(`Import bundle has too many files (max ${MAX_MYTHWIZ_FILES}).`);
      }
      const inner = normalizedZipPath.slice(prefix.length);
      if (!inner) continue;
      let safeInner: string;
      try {
        safeInner = normalizeWizardExportRelPath(inner);
      } catch {
        continue;
      }
      const entrySize = zipEntryUncompressedSize(entry);
      if (entrySize != null && entrySize > MAX_MYTHWIZ_FILE_CHARS) {
        throw new Error(`Import file is too large: ${safeInner}`);
      }
      const text = await entry.async('string');
      assertMythwizTextBudget(safeInner, text, totalChars);
      totalChars += text.length;
      workspaceFiles.push({ relativePath: safeInner, content: text });
    }

    workspaceFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    return {
      wizardDisplayName: (manifest.wizardDisplayName ?? '').trim() || 'Imported Wizard',
      systemPrompt,
      workspaceFiles
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
    return isInsideRootSync(root, target);
  }

  async openFile(
    root: string,
    target: string,
    allowOutsideWorkspace = false,
    options?: { pdf?: PdfReadOptions }
  ): Promise<OpenFile> {
    const safePath = await resolveWorkspaceTarget(root, target, allowOutsideWorkspace);
    const ext = extname(safePath).toLowerCase();

    if (ext === '.svg') {
      const st = await stat(safePath);
      if (st.size > MAX_IMAGE_PREVIEW_BYTES) {
        throw new Error(`Image preview is too large (max ${Math.round(MAX_IMAGE_PREVIEW_BYTES / 1024 / 1024)} MB).`);
      }
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
      const st = await stat(safePath);
      if (st.size > MAX_IMAGE_PREVIEW_BYTES) {
        throw new Error(`Image preview is too large (max ${Math.round(MAX_IMAGE_PREVIEW_BYTES / 1024 / 1024)} MB).`);
      }
      const buf = await readFile(safePath);
      const dataUrl = `data:${rasterMime};base64,${buf.toString('base64')}`;
      return {
        path: safePath,
        content: '',
        imagePreview: { mimeType: rasterMime, dataUrl }
      };
    }

    if (ext === '.pdf') {
      const extraction = await extractPdfText(safePath, options?.pdf);
      const methodLabel =
        extraction.method === 'ocr'
          ? 'OCR text was extracted from scanned PDF pages.'
          : extraction.method === 'embedded-text-with-ocr-fallback'
            ? 'PDF text was extracted with OCR fallback for scanned/low-text pages.'
            : 'PDF text is extracted for reading only.';
      return {
        path: safePath,
        kind: 'pdf',
        content: extraction.content,
        readOnly: true,
        readOnlyReason: methodLabel
      };
    }

    const content = await readFile(safePath, 'utf8');
    return { path: safePath, content };
  }

  async saveFile(root: string, target: string, content: string, allowOutsideWorkspace = false): Promise<OpenFile> {
    const safePath = await resolveWorkspaceTarget(root, target, allowOutsideWorkspace);
    await mkdir(dirname(safePath), { recursive: true });
    await writeFile(safePath, content, 'utf8');
    return this.openFile(root, target, allowOutsideWorkspace);
  }

  async replaceInFile(
    root: string,
    target: string,
    search: string,
    replacement: string,
    replaceAll: boolean,
    allowOutsideWorkspace = false
  ) {
    if (!search) {
      throw new Error('Search text cannot be empty.');
    }
    const safePath = await resolveWorkspaceTarget(root, target, allowOutsideWorkspace);
    const content = await readFile(safePath, 'utf8');
    const count = content.split(search).length - 1;
    if (count === 0) {
      throw new Error('Search text was not found.');
    }
    const next = replaceAll ? content.split(search).join(replacement) : content.replace(search, replacement);
    await writeFile(safePath, next, 'utf8');
    return { path: safePath, replacements: replaceAll ? count : 1 };
  }

  async insertAfter(root: string, target: string, anchor: string, text: string, allowOutsideWorkspace = false) {
    if (!anchor) {
      throw new Error('Anchor text cannot be empty.');
    }
    const safePath = await resolveWorkspaceTarget(root, target, allowOutsideWorkspace);
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

  async renamePath(root: string, from: string, to: string, allowOutsideWorkspace = false) {
    const safeFrom = await resolveWorkspaceTarget(root, from, allowOutsideWorkspace);
    const safeTo = await resolveWorkspaceTarget(root, to, allowOutsideWorkspace);
    await mkdir(dirname(safeTo), { recursive: true });
    await rename(safeFrom, safeTo);
    return { from: safeFrom, to: safeTo };
  }

  async deletePath(root: string, target: string, allowOutsideWorkspace = false): Promise<{ path: string }> {
    const safePath = await resolveWorkspaceTarget(root, target, allowOutsideWorkspace);
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

  async listRecentFiles(root: string, limit = 25): Promise<Array<{ path: string; bytes: number; modifiedAt: string }>> {
    const resolvedRoot = resolve(root);
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const files = (await this.listFiles(resolvedRoot)).filter((entry) => entry.type === 'file');
    const rows: Array<{ path: string; bytes: number; modifiedAt: string; mtimeMs: number }> = [];
    for (const entry of files) {
      try {
        const full = await ensureInsideRoot(resolvedRoot, entry.path);
        const st = await stat(full);
        rows.push({
          path: entry.path,
          bytes: st.size,
          modifiedAt: st.mtime.toISOString(),
          mtimeMs: st.mtimeMs
        });
      } catch {
        // ignore files that disappear while listing
      }
    }
    return rows
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, boundedLimit)
      .map(({ mtimeMs: _mtimeMs, ...row }) => row);
  }

  async readBinaryFile(root: string, target: string, allowOutsideWorkspace = false) {
    const safePath = await resolveWorkspaceTarget(root, target, allowOutsideWorkspace);
    const st = await stat(safePath);
    if (st.size > MAX_BINARY_TOOL_BYTES) {
      throw new Error(`File is too large for this tool (max ${Math.round(MAX_BINARY_TOOL_BYTES / 1024 / 1024)} MB).`);
    }
    const ext = extname(safePath).toLowerCase();
    const mimeType = RASTER_IMAGE_EXT[ext] ?? AUDIO_EXT[ext] ?? 'application/octet-stream';
    const bytes = await readFile(safePath);
    return {
      path: safePath,
      mimeType,
      bytes,
      dataBase64: bytes.toString('base64')
    };
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
    const applyHint =
      '\n\nHow to recover (Mythra uses `git apply` here): re-read the file with read_file; make every context line in the patch match the file exactly (including spaces/tabs); check @@ old/new line counts; keep paths as `a/rel/path` and `b/rel/path` under this folder; do not wrap the patch in markdown inside JSON. For one exact replacement use replace_in_file, or rewrite a small file with write_file.';
    try {
      await spawnWithInput('git', ['apply', '--whitespace=nowarn', '-'], cwd, patch);
    } catch (error) {
      const stderr = error instanceof Error ? error.message : String(error);
      if (/corrupt patch|does not apply|patch failed|unrecognized input|bogus|empty ident/i.test(stderr)) {
        throw new Error(`${stderr}${applyHint}`);
      }
      throw error instanceof Error ? new Error(`${stderr}${applyHint}`) : error;
    }
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
      const full = await ensureInsideRoot(root, entry.path);
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

  async getFileOutline(root: string, target: string, allowOutsideWorkspace = false) {
    const safePath = await resolveWorkspaceTarget(root, target, allowOutsideWorkspace);
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

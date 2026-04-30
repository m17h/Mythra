import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
/** Project-root asset (capital M): single source for window + dock icon. */
import appIconPath from '../../Mythra_icon.png?asset';
import { ChatStore } from './chat-store';
import { CommandService } from './command-service';
import { ModelService } from './model-service';
import { SettingsStore } from './settings-store';
import { WorkspaceService } from './workspace-service';
import { WorkspaceWatchController } from './workspace-watch';
import {
  buildSemanticCustomThemeTokens,
  CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY,
  flattenMergeThemeToolArgs,
  getThemeName,
  isLikelyLightCssBackground,
  isPresetThemeId,
  isSemanticCustomThemePaletteId,
  isThemeId,
  MERGE_THEME_PALETTE_IDS,
  PRESET_THEME_IDS,
  resolveCustomThemeFallback,
  sanitizeCustomThemeTokens,
  shouldReplaceFullCustomPalette,
  type MergeThemePaletteId,
  type ThemeId
} from '@shared/themes';
import {
  defaultSettings,
  type AppSettings,
  type ChatMessage,
  type SavedChat,
  type ToolApprovalRequest,
  type WizardMythwizExportRequest,
  type WizardProfile,
  type WizardPromptApprovalRequest,
  type WizardSetupRequest
} from '@shared/types';
import { sanitizeWizardFolderSegment } from '@shared/wizard-folder';

const settingsStore = new SettingsStore();
const chatStore = new ChatStore();
const workspaceService = new WorkspaceService();
const commandService = new CommandService();

let mainWindow: BrowserWindow | null = null;
let activeWorkspaceRoot: string | undefined;
const workspaceWatch = new WorkspaceWatchController(() => {
  const w = mainWindow;
  return w && !w.isDestroyed() ? w : null;
});
let currentSettings: AppSettings = defaultSettings;
/** Last theme before the most recent change (Settings or tool); used for revert_app_theme. */
let previousThemeId: ThemeId | undefined;
const pendingWizardPromptApprovals = new Map<string, (approved: boolean) => void>();
const pendingToolApprovals = new Map<string, (approved: boolean) => void>();

const recordThemeTransition = (from: ThemeId, to: ThemeId) => {
  if (from !== to) {
    previousThemeId = from;
  }
};

const applyAppTheme = async (rawId: string) => {
  if (!isThemeId(rawId)) {
    return JSON.stringify({
      ok: false,
      error: `Invalid theme_id. Presets: ${PRESET_THEME_IDS.join(', ')}. "custom" applies only when restoring the previous theme via revert_app_theme.`
    });
  }

  recordThemeTransition(currentSettings.ui.themeId, rawId);

  const nextUi = {
    ...currentSettings.ui,
    themeId: rawId,
    customThemeTokens: isPresetThemeId(rawId) ? undefined : currentSettings.ui.customThemeTokens
  };

  currentSettings = await settingsStore.save({
    ...currentSettings,
    ui: nextUi
  });
  mainWindow?.webContents.send('settings:updated', currentSettings);
  const displayName = getThemeName(rawId);
  return JSON.stringify({
    ok: true,
    themeId: rawId,
    displayName,
    message:
      rawId === 'custom'
        ? 'Theme set to Custom.'
        : `Theme set to ${displayName}.`
  });
};

const mergeCustomThemeTokens = async (incoming: Record<string, unknown>) => {
  const paletteHint = typeof incoming['palette'] === 'string' ? incoming['palette'].trim() : undefined;
  const modeHint = typeof incoming['mode'] === 'string' ? incoming['mode'].trim() : undefined;
  const descriptionHint = typeof incoming['description'] === 'string' ? incoming['description'].trim() : undefined;

  const flat = flattenMergeThemeToolArgs(incoming);
  let partial = sanitizeCustomThemeTokens(flat);
  const hadUserTokens = Object.keys(partial).length > 0;

  let resolvedPaletteId: MergeThemePaletteId | undefined;
  let semanticPaletteId: string | undefined;

  if (!hadUserTokens) {
    const paletteIsMergeFallback = paletteHint
      ? (MERGE_THEME_PALETTE_IDS as readonly string[]).includes(paletteHint)
      : false;
    if (paletteHint && !paletteIsMergeFallback && isSemanticCustomThemePaletteId(paletteHint)) {
      const semantic = buildSemanticCustomThemeTokens({
        palette: paletteHint,
        mode: modeHint,
        description: descriptionHint
      });
      const targetText = `${descriptionHint ?? ''} ${Object.keys(incoming).join(' ')}`.toLowerCase();
      const targetBubbles = /\b(chat\s*)?bubbles?\b|\b(user|assistant)\s*messages?\b/.test(targetText);
      partial = targetBubbles
        ? {
            '--chat-assistant-bg': semantic.tokens['--accent-subtle'],
            '--chat-user-bg': semantic.tokens['--accent-2-subtle'] ?? semantic.tokens['--accent-subtle']
          }
        : { ...semantic.tokens };
      semanticPaletteId = semantic.palette;
    } else {
      const resolved = resolveCustomThemeFallback(paletteHint);
      partial = { ...resolved.tokens };
      resolvedPaletteId = resolved.id;
    }
  }

  const prev = currentSettings.ui.themeId;
  if (prev !== 'custom') {
    recordThemeTransition(prev, 'custom');
  }

  const existing = currentSettings.ui.customThemeTokens ?? {};

  /** Full light baseline + user overrides — avoids leftover dark `--bg-*` bleeding through. */
  const userWantsLightPaper =
    paletteHint === 'light_paper_gray' ||
    paletteHint?.toLowerCase().includes('light_paper_gray') ||
    (hadUserTokens && partial['--bg-0'] && isLikelyLightCssBackground(partial['--bg-0']));

  let merged: Record<string, string>;
  if (hadUserTokens && userWantsLightPaper) {
    merged = { ...CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY, ...partial };
    resolvedPaletteId = resolvedPaletteId ?? 'light_paper_gray';
  } else if (
    shouldReplaceFullCustomPalette(hadUserTokens, partial, resolvedPaletteId, partial['--bg-0'])
  ) {
    merged =
      resolvedPaletteId === 'light_paper_gray' ? { ...partial } : { ...existing, ...partial };
  } else {
    merged = { ...existing, ...partial };
  }

  currentSettings = await settingsStore.save({
    ...currentSettings,
    ui: {
      ...currentSettings.ui,
      themeId: 'custom',
      customThemeTokens: merged
    }
  });
  mainWindow?.webContents.send('settings:updated', currentSettings);

  const message =
    hadUserTokens && userWantsLightPaper
      ? `Applied light paper + gray accent base with ${Object.keys(partial).length} token override(s).`
      : hadUserTokens
        ? `Applied ${Object.keys(partial).length} custom color override(s); theme set to Custom.`
        : semanticPaletteId
          ? `Applied semantic "${semanticPaletteId}" custom color fallback.`
          : `Applied built-in "${resolvedPaletteId}" palette (${paletteHint ? `hint: "${paletteHint}"` : 'no palette hint'}).`;

  return JSON.stringify({
    ok: true,
    themeId: 'custom',
    displayName: getThemeName('custom'),
    customThemeTokens: merged,
    usedFallbackPalette: !hadUserTokens,
    mergePaletteId: resolvedPaletteId,
    semanticPaletteId,
    message
  });
};

const setCustomTheme = async (incoming: Record<string, unknown>) => {
  const { tokens, palette, mode } = buildSemanticCustomThemeTokens({
    palette: typeof incoming.palette === 'string' ? incoming.palette : undefined,
    mode: typeof incoming.mode === 'string' ? incoming.mode : undefined,
    description: typeof incoming.description === 'string' ? incoming.description : undefined,
    intensity: typeof incoming.intensity === 'string' ? incoming.intensity : undefined
  });

  const prev = currentSettings.ui.themeId;
  if (prev !== 'custom') {
    recordThemeTransition(prev, 'custom');
  }

  currentSettings = await settingsStore.save({
    ...currentSettings,
    ui: {
      ...currentSettings.ui,
      themeId: 'custom',
      customThemeTokens: tokens
    }
  });
  mainWindow?.webContents.send('settings:updated', currentSettings);

  return JSON.stringify({
    ok: true,
    themeId: 'custom',
    displayName: getThemeName('custom'),
    customThemeTokens: tokens,
    semanticPalette: palette,
    semanticMode: mode,
    message: `Applied full custom ${mode} ${palette} theme.`
  });
};

const getAppThemeState = () => {
  const cur = currentSettings.ui.themeId;
  const prev = previousThemeId;
  const canRevert = prev != null && isThemeId(prev);
  return JSON.stringify({
    ok: true,
    themeId: cur,
    displayName: getThemeName(cur),
    previousThemeId: prev ?? null,
    previousDisplayName: prev != null ? getThemeName(prev) : null,
    canRevert
  });
};

const requestWizardPromptApproval = async (
  window: BrowserWindow,
  wizardName: string,
  before: string,
  after: string
) => {
  const id = randomUUID();
  const payload: WizardPromptApprovalRequest = {
    id,
    title: `Approve ${wizardName} prompt change`,
    wizardName,
    before,
    after
  };
  const approved = await new Promise<boolean>((resolveApproval) => {
    pendingWizardPromptApprovals.set(id, resolveApproval);
    window.webContents.send('wizard:prompt-approval-request', payload);
  });
  if (!approved) {
    throw new Error('Wizard system prompt change was denied by the user.');
  }
};

const requestToolApproval = async (
  window: BrowserWindow,
  title: string,
  detail: string,
  diff?: { before: string; after: string }
) => {
  const id = randomUUID();
  const payload: ToolApprovalRequest = {
    id,
    title,
    detail,
    ...(diff ? { diffBefore: diff.before, diffAfter: diff.after } : {})
  };
  const approved = await new Promise<boolean>((resolveApproval) => {
    pendingToolApprovals.set(id, resolveApproval);
    window.webContents.send('tool:approval-request', payload);
  });
  if (!approved) {
    throw new Error(`${title} was denied by the user.`);
  }
};

const modelService = new ModelService(
  workspaceService,
  commandService,
  applyAppTheme,
  getAppThemeState,
  mergeCustomThemeTokens,
  setCustomTheme,
  async (updater) => {
    const next = updater(structuredClone(currentSettings));
    currentSettings = await settingsStore.save(next);
    mainWindow?.webContents.send('settings:updated', currentSettings);
    return currentSettings;
  },
  async (wizardId, systemPrompt) => {
    const chat = await chatStore.loadChat(wizardId);
    if (!chat || chat.kind !== 'wizard' || !chat.wizard) {
      throw new Error('Wizard not found.');
    }
    await chatStore.saveChat({
      ...chat,
      updatedAt: Date.now(),
      wizard: {
        ...chat.wizard,
        systemPrompt
      }
    });
  },
  async (wizardId, displayName) => {
    const trimmed = displayName.trim();
    if (!trimmed || trimmed.length > 120) {
      throw new Error('Invalid Wizard display name.');
    }
    const chat = await chatStore.loadChat(wizardId);
    if (!chat || chat.kind !== 'wizard' || !chat.wizard) {
      throw new Error('Wizard not found.');
    }
    const prevRoot = chat.wizard.workspaceRoot;
    const wizard = await workspaceService.ensureWizardWorkspaceFolderMatchesDisplayName({
      ...chat.wizard,
      name: trimmed
    });
    await chatStore.saveChat({
      ...chat,
      title: trimmed,
      titleOverride: trimmed,
      updatedAt: Date.now(),
      wizard
    });
    if (activeWorkspaceRoot && resolve(activeWorkspaceRoot) === resolve(prevRoot)) {
      activeWorkspaceRoot = wizard.workspaceRoot;
      workspaceWatch.setRoot(wizard.workspaceRoot);
    }
    const ls = currentSettings.lastWorkspaceRoot?.trim();
    if (ls && resolve(ls) === resolve(prevRoot)) {
      currentSettings = await settingsStore.save({
        ...currentSettings,
        lastWorkspaceRoot: wizard.workspaceRoot
      });
      mainWindow?.webContents.send('settings:updated', currentSettings);
    }
    mainWindow?.webContents.send('chats:updated');
    return wizard;
  },
  requestWizardPromptApproval,
  requestToolApproval
);

const assertActiveWorkspace = (root: string | undefined) => {
  if (!root) {
    throw new Error('No workspace is active.');
  }
  if (!activeWorkspaceRoot || resolve(root) !== resolve(activeWorkspaceRoot)) {
    throw new Error('Workspace is not active.');
  }
};

const sanitizeRuntime = (runtime: {
  workspaceRoot?: string;
  activeFilePath?: string;
  conversationId?: string;
  wizardId?: string;
  wizardName?: string;
  wizardSystemPrompt?: string;
  wizardFullAccess?: boolean;
  wizardAllowOutsideWorkspace?: boolean;
}) => {
  const workspaceRoot =
    runtime.workspaceRoot && activeWorkspaceRoot && resolve(runtime.workspaceRoot) === resolve(activeWorkspaceRoot)
      ? activeWorkspaceRoot
      : undefined;

  const activeFilePath =
    workspaceRoot && runtime.activeFilePath && workspaceService.isInsideRoot(workspaceRoot, runtime.activeFilePath)
      ? runtime.activeFilePath
      : undefined;

  return {
    workspaceRoot,
    activeFilePath,
    conversationId: runtime.conversationId,
    wizardId: typeof runtime.wizardId === 'string' ? runtime.wizardId : undefined,
    wizardName: typeof runtime.wizardName === 'string' ? runtime.wizardName : undefined,
    wizardSystemPrompt: typeof runtime.wizardSystemPrompt === 'string' ? runtime.wizardSystemPrompt : undefined,
    wizardFullAccess: typeof runtime.wizardFullAccess === 'boolean' ? runtime.wizardFullAccess : undefined,
    wizardAllowOutsideWorkspace:
      typeof runtime.wizardAllowOutsideWorkspace === 'boolean' ? runtime.wizardAllowOutsideWorkspace : undefined
  };
};

const sanitizeChatSettings = (requested: AppSettings): AppSettings => ({
  ...requested,
  search: currentSettings.search,
  /** Use the renderer’s Tool access toggles so changes apply on the next message even before Save (disk is updated on Save). */
  tools: requested.tools,
  agent: currentSettings.agent,
  ui: {
    ...requested.ui,
    themeId: currentSettings.ui.themeId,
    customThemeTokens: currentSettings.ui.customThemeTokens,
    /** User toggles in the renderer header; trusting requested avoids a race vs main IPC. */
    favoriteModels: currentSettings.ui.favoriteModels
  }
});

const createWindow = async () => {
  const windowIcon = nativeImage.createFromPath(appIconPath);

  mainWindow = new BrowserWindow({
    width: 1580,
    height: 980,
    minWidth: 1280,
    minHeight: 760,
    title: 'Mythra',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#04111f',
    icon: windowIcon,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.mjs', import.meta.url)),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    await mainWindow.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
  }
};

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(appIconPath);
  }

  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  workspaceWatch.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('settings:load', async () => {
  currentSettings = await settingsStore.load();
  return currentSettings;
});
ipcMain.handle('settings:save', async (_event, settings: AppSettings) => {
  const safe: AppSettings = isPresetThemeId(settings.ui.themeId)
    ? { ...settings, ui: { ...settings.ui, customThemeTokens: undefined } }
    : settings;
  const from = currentSettings.ui.themeId;
  const to = safe.ui.themeId;
  if (from !== to) {
    recordThemeTransition(from, to);
  }
  currentSettings = await settingsStore.save(safe);
  return currentSettings;
});

ipcMain.handle('workspace:choose', async () => {
  const root = await workspaceService.chooseWorkspace();
  if (!root) {
    return null;
  }
  activeWorkspaceRoot = root;
  workspaceWatch.setRoot(root);

  currentSettings = await settingsStore.save({
    ...currentSettings,
    lastWorkspaceRoot: root
  });
  mainWindow?.webContents.send('settings:updated', currentSettings);

  return {
    root,
    label: basename(root),
    tree: await workspaceService.getTree(root)
  };
});

ipcMain.handle('workspace:open-last', async () => {
  const candidate = currentSettings.lastWorkspaceRoot?.trim();
  if (!candidate) {
    return null;
  }
  try {
    const st = await stat(candidate);
    if (!st.isDirectory()) {
      throw new Error('Not a directory');
    }
  } catch {
    currentSettings = await settingsStore.save({
      ...currentSettings,
      lastWorkspaceRoot: null
    });
    mainWindow?.webContents.send('settings:updated', currentSettings);
    return null;
  }

  activeWorkspaceRoot = candidate;
  workspaceWatch.setRoot(candidate);

  return {
    root: candidate,
    label: basename(candidate),
    tree: await workspaceService.getTree(candidate)
  };
});

/** Resolved path if Settings → last workspace still exists (does not activate or change sidebar workspace). */
ipcMain.handle('workspace:last-valid-root', async () => {
  const candidate = currentSettings.lastWorkspaceRoot?.trim();
  if (!candidate) {
    return null;
  }
  try {
    return await workspaceService.assertUsableLocalWorkspace(candidate);
  } catch {
    return null;
  }
});

ipcMain.handle('workspace:activate', async (_event, root: string) => {
  const resolved = await workspaceService.assertUsableLocalWorkspace(root);
  activeWorkspaceRoot = resolved;
  workspaceWatch.setRoot(resolved);
  return {
    root: resolved,
    label: basename(resolved),
    tree: await workspaceService.getTree(resolved)
  };
});

ipcMain.handle('workspace:tree', async (_event, root: string) => {
  assertActiveWorkspace(root);
  return workspaceService.getTree(root);
});
ipcMain.handle('workspace:detach', async () => {
  workspaceWatch.stop();
  activeWorkspaceRoot = undefined;
});
ipcMain.handle('workspace:open-file', async (_event, root: string, target: string) => {
  assertActiveWorkspace(root);
  return workspaceService.openFile(root, target);
});
ipcMain.handle('workspace:save-file', async (_event, root: string, target: string, content: string) => {
  assertActiveWorkspace(root);
  return workspaceService.saveFile(root, target, content);
});
ipcMain.handle('workspace:changes', async (_event, root: string) => {
  assertActiveWorkspace(root);
  return workspaceService.getChanges(root);
});

ipcMain.handle('wizard:recommended-workspace', async (_event, name: string) =>
  workspaceService.getRecommendedWizardWorkspace(name)
);

ipcMain.handle('wizard:choose-workspace', async (_event, name: string, preferredDefaultPath?: string) =>
  workspaceService.chooseWizardWorkspace(name, preferredDefaultPath)
);

ipcMain.handle('wizard:choose-projects-folder', async (_event, preferredDefaultPath?: string) =>
  workspaceService.chooseWizardProjectsFolder(preferredDefaultPath)
);

ipcMain.handle('wizard:setup', async (_event, request: WizardSetupRequest) => {
  const result = await workspaceService.setupWizardWorkspace(request);
  activeWorkspaceRoot = result.profile.workspaceRoot;
  workspaceWatch.setRoot(result.profile.workspaceRoot);
  return result;
});

ipcMain.handle('wizard:sync-workspace-folder', async (_event, profile: WizardProfile) => {
  const prevRoot = resolve(profile.workspaceRoot.trim());
  const updated = await workspaceService.ensureWizardWorkspaceFolderMatchesDisplayName(profile);
  if (resolve(prevRoot) !== resolve(updated.workspaceRoot)) {
    if (activeWorkspaceRoot && resolve(activeWorkspaceRoot) === prevRoot) {
      activeWorkspaceRoot = updated.workspaceRoot;
      workspaceWatch.setRoot(updated.workspaceRoot);
    }
    const ls = currentSettings.lastWorkspaceRoot?.trim();
    if (ls && resolve(ls) === prevRoot) {
      currentSettings = await settingsStore.save({
        ...currentSettings,
        lastWorkspaceRoot: updated.workspaceRoot
      });
      mainWindow?.webContents.send('settings:updated', currentSettings);
    }
  }
  return updated;
});

ipcMain.handle('wizard:delete-workspace', async (_event, root: string) => {
  const deleted = await workspaceService.deleteWorkspaceFolder(root);
  if (activeWorkspaceRoot && resolve(activeWorkspaceRoot) === resolve(deleted.path)) {
    activeWorkspaceRoot = undefined;
    workspaceWatch.stop();
  }
  return deleted;
});

ipcMain.handle('wizard:prompt-approval-response', async (_event, id: string, approved: boolean) => {
  const resolveApproval = pendingWizardPromptApprovals.get(id);
  if (!resolveApproval) return;
  pendingWizardPromptApprovals.delete(id);
  resolveApproval(Boolean(approved));
});

ipcMain.handle('tool:approval-response', async (_event, id: string, approved: boolean) => {
  const resolveApproval = pendingToolApprovals.get(id);
  if (!resolveApproval) return;
  pendingToolApprovals.delete(id);
  resolveApproval(Boolean(approved));
});

ipcMain.handle('wizard:list-documents', async (_event, root: string) => workspaceService.listWizardWorkspaceDocuments(root));

ipcMain.handle('wizard:list-export-files', async (_event, root: string) =>
  workspaceService.listWizardExportRelativeFiles(root)
);

ipcMain.handle('wizard:export-mythwiz', async (event, req: WizardMythwizExportRequest) => {
  const winSafe = BrowserWindow.fromWebContents(event.sender);
  const baseName = sanitizeWizardFolderSegment(req.wizardDisplayName.trim() || 'wizard');
  const opts = {
    title: 'Export Wizard',
    defaultPath: `${baseName}.mythwiz`,
    filters: [{ name: 'Mythra Wizard bundle', extensions: ['mythwiz'] }]
  };
  const { canceled, filePath } =
    winSafe && !winSafe.isDestroyed()
      ? await dialog.showSaveDialog(winSafe, opts)
      : await dialog.showSaveDialog(opts);
  if (canceled || !filePath) {
    return { ok: false as const, cancelled: true };
  }
  try {
    const buf = await workspaceService.buildWizardMythwizArchive(req);
    await writeFile(filePath, buf);
    return { ok: true as const, path: filePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false as const, error: message };
  }
});

ipcMain.handle('wizard:choose-import-mythwiz', async (event) => {
  const winSafe = BrowserWindow.fromWebContents(event.sender);
  const opts = {
    title: 'Import Wizard bundle',
    properties: ['openFile'] as const,
    filters: [{ name: 'Mythra Wizard bundle', extensions: ['mythwiz'] }]
  };
  const pick =
    winSafe && !winSafe.isDestroyed()
      ? await dialog.showOpenDialog(winSafe, opts)
      : await dialog.showOpenDialog(opts);
  if (pick.canceled || pick.filePaths.length === 0) {
    return { ok: false as const, cancelled: true };
  }
  try {
    const buf = await readFile(pick.filePaths[0]);
    const data = await workspaceService.parseWizardMythwizBuffer(buf);
    return { ok: true as const, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false as const, error: message };
  }
});

ipcMain.handle('shell:open-external', async (_event, rawUrl: unknown) => {
  if (typeof rawUrl !== 'string') return;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
  await shell.openExternal(parsed.href);
});

ipcMain.handle('models:list', async (_event, settings: AppSettings, providerKind?: 'lmstudio' | 'openrouter') =>
  modelService.listModels(settings, providerKind)
);

ipcMain.handle(
  'chat:stream',
  async (
    event,
    requestId: string,
    settings: AppSettings,
    messages: ChatMessage[],
    runtime: {
      workspaceRoot?: string;
      activeFilePath?: string;
      conversationId?: string;
      wizardId?: string;
      wizardName?: string;
      wizardSystemPrompt?: string;
      wizardFullAccess?: boolean;
      wizardAllowOutsideWorkspace?: boolean;
    }
  ) => {
    if (!mainWindow) {
      throw new Error('Main window is unavailable.');
    }

    try {
      await modelService.streamChat(event, mainWindow, requestId, sanitizeChatSettings(settings), messages, sanitizeRuntime(runtime));
      return { ok: true };
    } catch (error) {
      modelService.sendError(mainWindow, requestId, error);
      return { ok: false };
    }
  }
);

ipcMain.handle('chat:stop', async (_event, requestId: string) => modelService.stopRequest(requestId));

ipcMain.handle('commands:run', async (_event, command: string, cwd?: string) => {
  if (!mainWindow) {
    throw new Error('Main window is unavailable.');
  }
  if (cwd != null) {
    assertActiveWorkspace(cwd);
  }

  return commandService.run(mainWindow, command, cwd);
});

ipcMain.handle('commands:kill', async (_event, jobId: string) => commandService.kill(jobId));

ipcMain.handle('chats:list', async () => chatStore.listChats());
ipcMain.handle('chats:load', async (_event, id: string) => chatStore.loadChat(id));
ipcMain.handle('chats:save', async (_event, chat: SavedChat) => chatStore.saveChat(chat));
ipcMain.handle('chats:delete', async (_event, id: string) => chatStore.deleteChat(id));

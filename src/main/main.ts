import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, type OpenDialogOptions, type SaveDialogOptions } from 'electron';
/** Single source for BrowserWindow + macOS dock icon (bundled via ?asset). */
import appIconPath from '../../Images/app_icon.png?asset';
import mythraBgMysticNeon from '../../Images/backgrounds/1/mythra_background1_neon.png?asset';
import mythraBgMysticSunset from '../../Images/backgrounds/1/mythra_background1_sunset.png?asset';
import mythraBgMysticIce from '../../Images/backgrounds/1/mythra_background1_ice.png?asset';
import mythraBgMysticKiwi from '../../Images/backgrounds/1/mythra_background1_kiwi.png?asset';
import { ChatStore } from './chat-store';
import { CommandService } from './command-service';
import { ModelService } from './model-service';
import { SettingsStore } from './settings-store';
import { UpdateService } from './update-service';
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
  type ModelListOptions,
  type SavedChat,
  type ProviderKind,
  type ToolApprovalRequest,
  type WizardMythwizExportRequest,
  type WizardProfile,
  type WizardPromptApprovalRequest,
  type OpenRouterCreditsResult,
  type ReadChatThreadBackgroundRequest,
  type NexusSetupRequest,
  type WizardSetupRequest
} from '@shared/types';
import { sanitizeWizardFolderSegment } from '@shared/wizard-folder';
import { mysticVariantForTheme } from '@shared/chat-thread-backgrounds';

const CHAT_THREAD_BG_DIR = 'chat-thread-backgrounds';
const GENERATED_MEDIA_DIR = 'generated-media';
const MAX_CHAT_THREAD_BG_BYTES = 20 * 1024 * 1024;
const PENDING_WORKSPACE_DELETE_MS = 5 * 60 * 1000;

function chatThreadBackgroundStoreRoot(): string {
  return join(app.getPath('userData'), CHAT_THREAD_BG_DIR);
}

function isPathInsideChatThreadBackgroundStore(absPath: string): boolean {
  let root: string;
  let target: string;
  try {
    root = realpathSync(chatThreadBackgroundStoreRoot());
    target = realpathSync(resolve(absPath.trim()));
  } catch {
    root = resolve(chatThreadBackgroundStoreRoot());
    target = resolve(absPath.trim());
  }
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (process.platform === 'win32') {
    const t = target.toLowerCase();
    const p = prefix.toLowerCase();
    return t === root.toLowerCase() || t.startsWith(p);
  }
  return target === root || target.startsWith(prefix);
}

function isPathInsideGeneratedMediaStore(absPath: string): boolean {
  const root = resolve(join(app.getPath('userData'), GENERATED_MEDIA_DIR));
  const target = resolve(absPath.trim());
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (process.platform === 'win32') {
    const t = target.toLowerCase();
    const p = prefix.toLowerCase();
    return t === root.toLowerCase() || t.startsWith(p);
  }
  return target === root || target.startsWith(prefix);
}

const MYSTIC_BUNDLED_PATHS = {
  neon: mythraBgMysticNeon,
  sunset: mythraBgMysticSunset,
  ice: mythraBgMysticIce,
  kiwi: mythraBgMysticKiwi
} as const;

function resolveReadChatThreadBackgroundFile(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const p = resolve(raw.trim());
    if (!isPathInsideChatThreadBackgroundStore(p)) return null;
    return p;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as ReadChatThreadBackgroundRequest;
  if (o.source === 'userFile') {
    const p = resolve(String(o.path).trim());
    if (!isPathInsideChatThreadBackgroundStore(p)) return null;
    return p;
  }
  if (o.source === 'builtin' && o.presetId === 'mystic') {
    if (!isThemeId(o.themeId)) return null;
    const variant = mysticVariantForTheme(o.themeId, o.customThemeLight);
    return MYSTIC_BUNDLED_PATHS[variant];
  }
  return null;
}

function imageMimeFromFilename(filename: string): string {
  const ext = basename(filename).split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'jpg':
    case 'jpeg':
    default:
      return 'image/jpeg';
  }
}

const settingsStore = new SettingsStore();
const chatStore = new ChatStore();
const workspaceService = new WorkspaceService();
const commandService = new CommandService();
let mainWindow: BrowserWindow | null = null;
const updateService = new UpdateService(() => {
  const w = mainWindow;
  return w && !w.isDestroyed() ? w : null;
});
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
const trustedWorkspaceRoots = new Set<string>();
const pendingWorkspaceDeleteRoots = new Map<string, ReturnType<typeof setTimeout>>();

const workspaceRootKey = async (root: string) => {
  const resolved = resolve(root.trim());
  const real = await realpath(resolved);
  return process.platform === 'win32' ? real.toLowerCase() : real;
};

const trustWorkspaceRoot = async (root: string) => {
  const usable = await workspaceService.assertUsableLocalWorkspace(root);
  trustedWorkspaceRoots.add(await workspaceRootKey(usable));
  return usable;
};

const registerPendingWorkspaceDeleteRoot = async (root: string | undefined | null) => {
  if (!root?.trim()) return;
  let key: string;
  try {
    key = await workspaceRootKey(root);
  } catch {
    return;
  }
  const existing = pendingWorkspaceDeleteRoots.get(key);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    pendingWorkspaceDeleteRoots.delete(key);
  }, PENDING_WORKSPACE_DELETE_MS);
  timeout.unref?.();
  pendingWorkspaceDeleteRoots.set(key, timeout);
};

const registeredWorkspaceRootKeys = async () => {
  const roots: string[] = [];
  for (const chat of await chatStore.listChats()) {
    if (chat.kind === 'wizard' && chat.wizard?.workspaceRoot) {
      roots.push(chat.wizard.workspaceRoot);
    }
    if (chat.kind === 'nexus' && chat.nexus?.workspaceRoot) {
      roots.push(chat.nexus.workspaceRoot);
    }
  }
  const keys = new Set<string>();
  for (const root of roots) {
    try {
      keys.add(await workspaceRootKey(root));
    } catch {
      // Missing saved workspaces are handled by callers that stat/open them.
    }
  }
  return keys;
};

const assertTrustedWorkspaceRoot = async (root: string) => {
  const usable = await workspaceService.assertUsableLocalWorkspace(root);
  const key = await workspaceRootKey(usable);
  if (trustedWorkspaceRoots.has(key)) return usable;

  const savedLast = currentSettings.lastWorkspaceRoot?.trim();
  if (savedLast) {
    try {
      if ((await workspaceRootKey(savedLast)) === key) return usable;
    } catch {
      // Ignore stale last workspace path.
    }
  }

  if ((await registeredWorkspaceRootKeys()).has(key)) return usable;

  throw new Error('Workspace is not trusted. Use Open workspace or a saved Wizard/Nexus workspace to attach it.');
};

const assertRegisteredOrPendingDeleteRoot = async (root: string) => {
  const usable = await workspaceService.assertUsableLocalWorkspace(root);
  const key = await workspaceRootKey(usable);
  if ((await registeredWorkspaceRootKeys()).has(key) || pendingWorkspaceDeleteRoots.has(key)) {
    return { usable, key };
  }
  throw new Error('Workspace folder is not registered for deletion.');
};

const sameWorkspaceRoot = async (a: string | undefined | null, b: string | undefined | null) => {
  if (!a?.trim() || !b?.trim()) return false;
  try {
    return (await workspaceRootKey(a)) === (await workspaceRootKey(b));
  } catch {
    return false;
  }
};

const assertSavedChatWorkspaceRootsAreTrusted = async (chat: SavedChat) => {
  const previous = await chatStore.loadChat(chat.id);
  if (chat.kind === 'wizard' && chat.wizard?.workspaceRoot) {
    if (!(await sameWorkspaceRoot(previous?.wizard?.workspaceRoot, chat.wizard.workspaceRoot))) {
      await assertTrustedWorkspaceRoot(chat.wizard.workspaceRoot);
    }
  }
  if (chat.kind === 'nexus' && chat.nexus?.workspaceRoot) {
    if (!(await sameWorkspaceRoot(previous?.nexus?.workspaceRoot, chat.nexus.workspaceRoot))) {
      await assertTrustedWorkspaceRoot(chat.nexus.workspaceRoot);
    }
  }
};

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
  nexusTeamFullAccess?: boolean;
  nexusLeaderApprovesTools?: boolean;
  nexusLeaderProvider?: AppSettings['selectedProvider'];
  nexusLeaderModel?: string;
  nexusLeaderName?: string;
  mediaGenerationKind?: 'music' | 'video' | 'image';
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
      typeof runtime.wizardAllowOutsideWorkspace === 'boolean' ? runtime.wizardAllowOutsideWorkspace : undefined,
    nexusTeamFullAccess: typeof runtime.nexusTeamFullAccess === 'boolean' ? runtime.nexusTeamFullAccess : undefined,
    nexusLeaderApprovesTools:
      typeof runtime.nexusLeaderApprovesTools === 'boolean' ? runtime.nexusLeaderApprovesTools : undefined,
    nexusLeaderProvider:
      runtime.nexusLeaderProvider === 'lmstudio' ||
      runtime.nexusLeaderProvider === 'openrouter' ||
      runtime.nexusLeaderProvider === 'ollama'
        ? runtime.nexusLeaderProvider
        : undefined,
    nexusLeaderModel: typeof runtime.nexusLeaderModel === 'string' ? runtime.nexusLeaderModel : undefined,
    nexusLeaderName: typeof runtime.nexusLeaderName === 'string' ? runtime.nexusLeaderName : undefined,
    mediaGenerationKind:
      runtime.mediaGenerationKind === 'music' ||
      runtime.mediaGenerationKind === 'video' ||
      runtime.mediaGenerationKind === 'image'
        ? runtime.mediaGenerationKind
        : undefined
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
  updateService.refreshReleaseNotesInBackground();

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
    ? { ...settings, lastWorkspaceRoot: currentSettings.lastWorkspaceRoot, ui: { ...settings.ui, customThemeTokens: undefined } }
    : { ...settings, lastWorkspaceRoot: currentSettings.lastWorkspaceRoot };
  const from = currentSettings.ui.themeId;
  const to = safe.ui.themeId;
  if (from !== to) {
    recordThemeTransition(from, to);
  }
  currentSettings = await settingsStore.save(safe);
  return currentSettings;
});

ipcMain.handle('app:update-check', async () => updateService.checkForUpdates(app.getVersion()));

ipcMain.handle('app:update-download', async () => updateService.downloadAndInstallUpdate());

ipcMain.handle('app:release-notes:get', async () => updateService.getReleaseNotes());

ipcMain.handle('app:release-notes:refresh', async () => updateService.refreshReleaseNotes());

ipcMain.handle('workspace:choose', async () => {
  const root = await workspaceService.chooseWorkspace();
  if (!root) {
    return null;
  }
  await trustWorkspaceRoot(root);
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
  let root: string;
  try {
    root = await trustWorkspaceRoot(candidate);
  } catch {
    currentSettings = await settingsStore.save({
      ...currentSettings,
      lastWorkspaceRoot: null
    });
    mainWindow?.webContents.send('settings:updated', currentSettings);
    return null;
  }

  activeWorkspaceRoot = root;
  workspaceWatch.setRoot(root);

  return {
    root,
    label: basename(root),
    tree: await workspaceService.getTree(root)
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
  const resolved = await assertTrustedWorkspaceRoot(root);
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
ipcMain.handle('workspace:open-folder', async (_event, root: string) => {
  assertActiveWorkspace(root);
  const error = await shell.openPath(resolve(root));
  if (error) {
    throw new Error(error);
  }
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

ipcMain.handle('wizard:choose-workspace', async (_event, name: string, preferredDefaultPath?: string) => {
  const root = await workspaceService.chooseWizardWorkspace(name, preferredDefaultPath);
  if (root) await trustWorkspaceRoot(root);
  return root;
});

ipcMain.handle('wizard:choose-projects-folder', async (_event, preferredDefaultPath?: string) => {
  const root = await workspaceService.chooseWizardProjectsFolder(preferredDefaultPath);
  if (root) await trustWorkspaceRoot(root);
  return root;
});

ipcMain.handle('nexus:choose-workspace', async (_event, preferredDefaultPath?: string) => {
  const root = await workspaceService.chooseNexusWorkspace(preferredDefaultPath);
  if (root) await trustWorkspaceRoot(root);
  return root;
});

ipcMain.handle('nexus:setup', async (_event, request: NexusSetupRequest) => {
  const result = await workspaceService.setupNexusWorkspace(request);
  await trustWorkspaceRoot(result.workspaceRoot);
  activeWorkspaceRoot = result.workspaceRoot;
  workspaceWatch.setRoot(result.workspaceRoot);
  return result;
});

ipcMain.handle('wizard:setup', async (_event, request: WizardSetupRequest) => {
  const result = await workspaceService.setupWizardWorkspace(request);
  await trustWorkspaceRoot(result.profile.workspaceRoot);
  activeWorkspaceRoot = result.profile.workspaceRoot;
  workspaceWatch.setRoot(result.profile.workspaceRoot);
  return result;
});

ipcMain.handle('wizard:sync-workspace-folder', async (_event, profile: WizardProfile) => {
  const prevRoot = resolve(profile.workspaceRoot.trim());
  const updated = await workspaceService.ensureWizardWorkspaceFolderMatchesDisplayName(profile);
  await trustWorkspaceRoot(updated.workspaceRoot);
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
  const { usable, key } = await assertRegisteredOrPendingDeleteRoot(root);
  pendingWorkspaceDeleteRoots.delete(key);
  const deleted = await workspaceService.deleteWorkspaceFolder(usable);
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

ipcMain.handle('wizard:read-document', async (_event, root: string, target: string) => {
  const resolvedRoot = resolve(root.trim());
  const chats = await chatStore.listChats();
  const normalizedRoot = resolvedRoot.toLowerCase();
  const isKnownWizardRoot = chats.some(
    (chat) => {
      if (chat.kind !== 'wizard' || !chat.wizard) return false;
      if (chat.wizard.workspaceRoot && resolve(chat.wizard.workspaceRoot) === resolvedRoot) return true;
      const expectedFolder = sanitizeWizardFolderSegment(chat.wizard.name).toLowerCase();
      return (chat.wizard.documents ?? []).some((doc) => {
        let dir = dirname(resolve(doc.path));
        for (let depth = 0; depth < 16; depth += 1) {
          if (resolve(dir) === resolvedRoot && basename(dir).toLowerCase() === expectedFolder) return true;
          const parent = dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        return false;
      });
    }
  );
  if (!isKnownWizardRoot || normalizedRoot.includes('/library/cloudstorage/')) {
    throw new Error('Wizard workspace is not registered.');
  }
  return workspaceService.openFile(resolvedRoot, target, false);
});

ipcMain.handle('wizard:list-export-files', async (_event, root: string) =>
  workspaceService.listWizardExportRelativeFiles(root)
);

ipcMain.handle('wizard:export-mythwiz', async (event, req: WizardMythwizExportRequest) => {
  const winSafe = BrowserWindow.fromWebContents(event.sender);
  const baseName = sanitizeWizardFolderSegment(req.wizardDisplayName.trim() || 'wizard');
  const opts: SaveDialogOptions = {
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
  const opts: OpenDialogOptions = {
    title: 'Import Wizard bundle',
    properties: ['openFile'],
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
    const st = await stat(pick.filePaths[0]);
    if (st.size > 50 * 1024 * 1024) {
      return { ok: false as const, error: 'Import bundle is too large.' };
    }
    const buf = await readFile(pick.filePaths[0]);
    const data = await workspaceService.parseWizardMythwizBuffer(buf);
    return { ok: true as const, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false as const, error: message };
  }
});

ipcMain.handle('ui:choose-chat-thread-background', async (event) => {
  const winSafe = BrowserWindow.fromWebContents(event.sender);
  const opts: OpenDialogOptions = {
    title: 'Chat thread background',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }]
  };
  const pick =
    winSafe && !winSafe.isDestroyed()
      ? await dialog.showOpenDialog(winSafe, opts)
      : await dialog.showOpenDialog(opts);
  if (pick.canceled || pick.filePaths.length === 0) {
    return { ok: false as const, cancelled: true as const };
  }
  const src = pick.filePaths[0];
  try {
    const st = await stat(src);
    if (!st.isFile()) {
      return { ok: false as const, error: 'Not a file.' };
    }
    if (st.size > MAX_CHAT_THREAD_BG_BYTES) {
      return { ok: false as const, error: `Image is too large (max ${Math.round(MAX_CHAT_THREAD_BG_BYTES / 1024 / 1024)} MB).` };
    }
    const safeBase = basename(src).replace(/[^a-zA-Z0-9._-]/g, '_') || 'background';
    const destName = `${randomUUID()}-${safeBase}`;
    const destDir = chatThreadBackgroundStoreRoot();
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, destName);
    await copyFile(src, dest);
    return { ok: true as const, path: dest };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false as const, error: message };
  }
});

ipcMain.handle('ui:read-chat-thread-background', async (_event, raw: unknown) => {
  const p = resolveReadChatThreadBackgroundFile(raw);
  if (!p) return { ok: false as const };
  try {
    const st = await stat(p);
    if (st.size > MAX_CHAT_THREAD_BG_BYTES) {
      return { ok: false as const };
    }
    const buf = await readFile(p);
    return {
      ok: true as const,
      mime: imageMimeFromFilename(p),
      dataBase64: buf.toString('base64')
    };
  } catch {
    return { ok: false as const };
  }
});

ipcMain.handle('generated-media:save', async (event, dataUrl: unknown, fileName: unknown, backingFilePath: unknown) => {
  if (typeof dataUrl !== 'string' || typeof fileName !== 'string') {
    return { ok: false as const, error: 'Invalid media save request.' };
  }
  let sourcePath: string | null = null;
  let dataBytes: Buffer | null = null;
  if (typeof backingFilePath === 'string' && backingFilePath.trim()) {
    const p = resolve(backingFilePath.trim());
    if (!isPathInsideGeneratedMediaStore(p)) {
      return { ok: false as const, error: 'Media file is outside Mythra generated media storage.' };
    }
    sourcePath = p;
  } else if (dataUrl.startsWith('file:')) {
    try {
      const p = fileURLToPath(dataUrl);
      if (!isPathInsideGeneratedMediaStore(p)) {
        return { ok: false as const, error: 'Media file is outside Mythra generated media storage.' };
      }
      sourcePath = p;
    } catch {
      return { ok: false as const, error: 'Invalid media file URL.' };
    }
  } else {
    const match = /^data:[^;,]+;base64,(.+)$/i.exec(dataUrl);
    if (!match) {
      return { ok: false as const, error: 'Unsupported media URL.' };
    }
    dataBytes = Buffer.from(match[1] ?? '', 'base64');
  }

  const safeName = basename(fileName).replace(/[^a-zA-Z0-9._ -]/g, '_') || 'generated-media';
  const opts: SaveDialogOptions = { title: 'Save generated media', defaultPath: safeName };
  const winSafe = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } =
    winSafe && !winSafe.isDestroyed()
      ? await dialog.showSaveDialog(winSafe, opts)
      : await dialog.showSaveDialog(opts);
  if (canceled || !filePath) {
    return { ok: false as const, cancelled: true as const };
  }
  try {
    if (sourcePath) await copyFile(sourcePath, filePath);
    else if (dataBytes) await writeFile(filePath, dataBytes);
    return { ok: true as const, path: filePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false as const, error: message };
  }
});

ipcMain.handle('generated-media:open-image', async (_event, dataUrl: unknown, fileName: unknown, mimeType: unknown, backingFilePath: unknown) => {
  if (typeof dataUrl !== 'string' || typeof fileName !== 'string' || typeof mimeType !== 'string') {
    return { ok: false as const, error: 'Invalid image preview request.' };
  }
  if (!mimeType.startsWith('image/')) {
    return { ok: false as const, error: 'Generated media is not an image.' };
  }

  let imageUrl = '';
  let imageSize: { width: number; height: number } | null = null;
  if (typeof backingFilePath === 'string' && backingFilePath.trim()) {
    const p = resolve(backingFilePath.trim());
    if (!isPathInsideGeneratedMediaStore(p)) {
      return { ok: false as const, error: 'Image file is outside Mythra generated media storage.' };
    }
    const bytes = await readFile(p);
    imageUrl = `data:${imageMimeFromFilename(p)};base64,${bytes.toString('base64')}`;
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      imageSize = img.getSize();
    }
  } else if (dataUrl.startsWith('data:image/')) {
    imageUrl = dataUrl;
  } else {
    return { ok: false as const, error: 'Unsupported image URL.' };
  }

  const display = imageSize
    ? {
        width: Math.min(1400, Math.max(640, imageSize.width)),
        height: Math.min(1000, Math.max(480, imageSize.height))
      }
    : { width: 1000, height: 760 };
  const safeTitle = basename(fileName).replace(/[<>]/g, '') || 'Generated image';
  const previewWindow = new BrowserWindow({
    width: display.width,
    height: display.height,
    minWidth: 420,
    minHeight: 320,
    title: safeTitle,
    backgroundColor: '#0b1020',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${safeTitle.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: #080d19; }
    body { display: grid; place-items: center; overflow: auto; }
    img { max-width: 100vw; max-height: 100vh; width: auto; height: auto; object-fit: contain; }
  </style>
</head>
<body>
  <img src="${imageUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" alt="${safeTitle.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" />
</body>
</html>`;
  await previewWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return { ok: true as const };
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

ipcMain.handle('models:list', async (_event, settings: AppSettings, providerKind?: ProviderKind, options?: ModelListOptions) =>
  modelService.listModels(settings, providerKind, options)
);

ipcMain.handle('openrouter:credits', async (_event, settings: AppSettings): Promise<OpenRouterCreditsResult> => {
  const provider = settings.providers.openrouter;
  const apiKey = provider.apiKey.trim();
  if (!apiKey) {
    return { ok: false, error: 'Add an OpenRouter API key first.' };
  }

  const baseUrl = (provider.baseUrl || defaultSettings.providers.openrouter.baseUrl).trim().replace(/\/+$/, '');
  try {
    const response = await fetch(`${baseUrl}/credits`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': provider.appUrl || defaultSettings.providers.openrouter.appUrl,
        'X-OpenRouter-Title': provider.appName || defaultSettings.providers.openrouter.appName
      }
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          status: response.status,
          error: 'This OpenRouter key cannot read credits. Use an OpenRouter key with credits access.'
        };
      }
      return {
        ok: false,
        status: response.status,
        error: `OpenRouter credits request failed (${response.status}).`
      };
    }

    const body = (await response.json()) as {
      data?: { total_credits?: unknown; total_usage?: unknown };
    };
    const totalCredits = Number(body.data?.total_credits);
    const totalUsage = Number(body.data?.total_usage);
    if (!Number.isFinite(totalCredits) || !Number.isFinite(totalUsage)) {
      return { ok: false, error: 'OpenRouter returned an unexpected credits response.' };
    }

    return {
      ok: true,
      totalCredits,
      totalUsage,
      remainingCredits: Math.max(0, totalCredits - totalUsage)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not load OpenRouter credits.'
    };
  }
});

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
      nexusTeamFullAccess?: boolean;
      nexusLeaderApprovesTools?: boolean;
      nexusLeaderProvider?: AppSettings['selectedProvider'];
      nexusLeaderModel?: string;
      nexusLeaderName?: string;
      mediaGenerationKind?: 'music' | 'video' | 'image';
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
ipcMain.handle('chats:save', async (_event, chat: SavedChat) => {
  await assertSavedChatWorkspaceRootsAreTrusted(chat);
  return chatStore.saveChat(chat);
});
ipcMain.handle('chats:delete', async (_event, id: string) => {
  const chat = await chatStore.loadChat(id);
  if (chat?.kind === 'wizard') {
    await registerPendingWorkspaceDeleteRoot(chat.wizard?.workspaceRoot);
  }
  if (chat?.kind === 'nexus') {
    await registerPendingWorkspaceDeleteRoot(chat.nexus?.workspaceRoot);
  }
  return chatStore.deleteChat(id);
});

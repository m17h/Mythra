import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import appIconPath from './openkiwi_icon.png?asset';
import { ChatStore } from './chat-store';
import { CommandService } from './command-service';
import { ModelService } from './model-service';
import { SettingsStore } from './settings-store';
import { WorkspaceService } from './workspace-service';
import { defaultSettings, type AppSettings, type ChatMessage, type SavedChat } from '@shared/types';

const settingsStore = new SettingsStore();
const chatStore = new ChatStore();
const workspaceService = new WorkspaceService();
const commandService = new CommandService();
const modelService = new ModelService(workspaceService, commandService);

let mainWindow: BrowserWindow | null = null;
let activeWorkspaceRoot: string | undefined;
let currentSettings: AppSettings = defaultSettings;

const assertActiveWorkspace = (root: string | undefined) => {
  if (!root) {
    throw new Error('No workspace is active.');
  }
  if (!activeWorkspaceRoot || resolve(root) !== resolve(activeWorkspaceRoot)) {
    throw new Error('Workspace is not active.');
  }
};

const sanitizeRuntime = (runtime: { workspaceRoot?: string; activeFilePath?: string; conversationId?: string }) => {
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
    conversationId: runtime.conversationId
  };
};

const sanitizeChatSettings = (requested: AppSettings): AppSettings => ({
  ...requested,
  tools: currentSettings.tools,
  agent: currentSettings.agent,
  ui: {
    ...requested.ui,
    sessionMode: currentSettings.ui.sessionMode,
    webSearch: currentSettings.ui.webSearch,
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
    title: 'OpenKiwi',
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
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('settings:load', async () => {
  currentSettings = await settingsStore.load();
  return currentSettings;
});
ipcMain.handle('settings:save', async (_event, settings: AppSettings) => {
  currentSettings = await settingsStore.save(settings);
  return currentSettings;
});

ipcMain.handle('workspace:choose', async () => {
  const root = await workspaceService.chooseWorkspace();
  if (!root) {
    return null;
  }
  activeWorkspaceRoot = root;

  return {
    root,
    label: basename(root),
    tree: await workspaceService.getTree(root)
  };
});

ipcMain.handle('workspace:tree', async (_event, root: string) => {
  assertActiveWorkspace(root);
  return workspaceService.getTree(root);
});
ipcMain.handle('workspace:open-file', async (_event, root: string, target: string) => {
  assertActiveWorkspace(root);
  return workspaceService.openFile(root, target);
});
ipcMain.handle('workspace:save-file', async (_event, root: string, target: string, content: string) => {
  assertActiveWorkspace(root);
  return workspaceService.saveFile(root, target, content);
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
    runtime: { workspaceRoot?: string; activeFilePath?: string; conversationId?: string }
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

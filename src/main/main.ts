import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import appIconPath from './openkiwi_icon.png?asset';
import { ChatStore } from './chat-store';
import { CommandService } from './command-service';
import { ModelService } from './model-service';
import { SettingsStore } from './settings-store';
import { WorkspaceService } from './workspace-service';
import type { AppSettings, ChatMessage, SavedChat } from '@shared/types';

const settingsStore = new SettingsStore();
const chatStore = new ChatStore();
const workspaceService = new WorkspaceService();
const commandService = new CommandService();
const modelService = new ModelService(workspaceService, commandService);

let mainWindow: BrowserWindow | null = null;

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

ipcMain.handle('settings:load', async () => settingsStore.load());
ipcMain.handle('settings:save', async (_event, settings: AppSettings) => settingsStore.save(settings));

ipcMain.handle('workspace:choose', async () => {
  const root = await workspaceService.chooseWorkspace();
  if (!root) {
    return null;
  }

  return {
    root,
    label: basename(root),
    tree: await workspaceService.getTree(root)
  };
});

ipcMain.handle('workspace:tree', async (_event, root: string) => workspaceService.getTree(root));
ipcMain.handle('workspace:open-file', async (_event, root: string, target: string) => workspaceService.openFile(root, target));
ipcMain.handle('workspace:save-file', async (_event, root: string, target: string, content: string) =>
  workspaceService.saveFile(root, target, content)
);

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
      await modelService.streamChat(event, mainWindow, requestId, settings, messages, runtime);
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

  return commandService.run(mainWindow, command, cwd);
});

ipcMain.handle('commands:kill', async (_event, jobId: string) => commandService.kill(jobId));

ipcMain.handle('chats:list', async () => chatStore.listChats());
ipcMain.handle('chats:load', async (_event, id: string) => chatStore.loadChat(id));
ipcMain.handle('chats:save', async (_event, chat: SavedChat) => chatStore.saveChat(chat));
ipcMain.handle('chats:delete', async (_event, id: string) => chatStore.deleteChat(id));

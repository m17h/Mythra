import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  ChatActivity,
  ChatMessage,
  ChatStreamDelta,
  ChatStreamDone,
  ChatStreamError,
  CommandChunk,
  CommandResult,
  ModelInfo,
  OpenFile,
  SavedChat,
  SavedChatMeta,
  WorkspaceChanged,
  WorkspaceChanges,
  WorkspaceNode
} from '@shared/types';

const electronAPI = {
  platform: process.platform,
  loadSettings: () => ipcRenderer.invoke('settings:load') as Promise<AppSettings>,
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke('settings:save', settings) as Promise<AppSettings>,
  chooseWorkspace: () =>
    ipcRenderer.invoke('workspace:choose') as Promise<{ root: string; label: string; tree: WorkspaceNode[] } | null>,
  getWorkspaceTree: (root: string) => ipcRenderer.invoke('workspace:tree', root) as Promise<WorkspaceNode[]>,
  detachWorkspace: () => ipcRenderer.invoke('workspace:detach') as Promise<void>,
  openFile: (root: string, target: string) =>
    ipcRenderer.invoke('workspace:open-file', root, target) as Promise<OpenFile>,
  saveFile: (root: string, target: string, content: string) =>
    ipcRenderer.invoke('workspace:save-file', root, target, content) as Promise<OpenFile>,
  getWorkspaceChanges: (root: string) =>
    ipcRenderer.invoke('workspace:changes', root) as Promise<WorkspaceChanges>,
  openExternalUrl: (url: string) => ipcRenderer.invoke('shell:open-external', url) as Promise<void>,
  listModels: (settings: AppSettings, providerKind?: 'lmstudio' | 'openrouter') =>
    ipcRenderer.invoke('models:list', settings, providerKind) as Promise<ModelInfo[]>,
  streamChat: (
    requestId: string,
    settings: AppSettings,
    messages: ChatMessage[],
    runtime: { workspaceRoot?: string; activeFilePath?: string; conversationId?: string }
  ) => ipcRenderer.invoke('chat:stream', requestId, settings, messages, runtime) as Promise<{ ok: boolean }>,
  stopChat: (requestId: string) => ipcRenderer.invoke('chat:stop', requestId) as Promise<boolean>,
  runCommand: (command: string, cwd?: string) =>
    ipcRenderer.invoke('commands:run', command, cwd) as Promise<{ jobId: string }>,
  killCommand: (jobId: string) => ipcRenderer.invoke('commands:kill', jobId) as Promise<boolean>,
  onCommandChunk: (callback: (payload: CommandChunk) => void) => {
    const listener = (_event: unknown, payload: CommandChunk) => callback(payload);
    ipcRenderer.on('commands:chunk', listener);
    return () => ipcRenderer.removeListener('commands:chunk', listener);
  },
  onCommandDone: (callback: (payload: CommandResult) => void) => {
    const listener = (_event: unknown, payload: CommandResult) => callback(payload);
    ipcRenderer.on('commands:done', listener);
    return () => ipcRenderer.removeListener('commands:done', listener);
  },
  onChatDelta: (callback: (payload: ChatStreamDelta) => void) => {
    const listener = (_event: unknown, payload: ChatStreamDelta) => callback(payload);
    ipcRenderer.on('chat:delta', listener);
    return () => ipcRenderer.removeListener('chat:delta', listener);
  },
  onChatDone: (callback: (payload: ChatStreamDone) => void) => {
    const listener = (_event: unknown, payload: ChatStreamDone) => callback(payload);
    ipcRenderer.on('chat:done', listener);
    return () => ipcRenderer.removeListener('chat:done', listener);
  },
  onChatError: (callback: (payload: ChatStreamError) => void) => {
    const listener = (_event: unknown, payload: ChatStreamError) => callback(payload);
    ipcRenderer.on('chat:error', listener);
    return () => ipcRenderer.removeListener('chat:error', listener);
  },
  onChatActivity: (callback: (payload: ChatActivity) => void) => {
    const listener = (_event: unknown, payload: ChatActivity) => callback(payload);
    ipcRenderer.on('chat:activity', listener);
    return () => ipcRenderer.removeListener('chat:activity', listener);
  },
  onWorkspaceChanged: (callback: (payload: WorkspaceChanged) => void) => {
    const listener = (_event: unknown, payload: WorkspaceChanged) => callback(payload);
    ipcRenderer.on('workspace:changed', listener);
    return () => ipcRenderer.removeListener('workspace:changed', listener);
  },
  onSettingsUpdated: (callback: (settings: AppSettings) => void) => {
    const listener = (_event: unknown, settings: AppSettings) => callback(settings);
    ipcRenderer.on('settings:updated', listener);
    return () => ipcRenderer.removeListener('settings:updated', listener);
  },
  listChats: () => ipcRenderer.invoke('chats:list') as Promise<SavedChatMeta[]>,
  loadChat: (id: string) => ipcRenderer.invoke('chats:load', id) as Promise<SavedChat | null>,
  saveChat: (chat: SavedChat) => ipcRenderer.invoke('chats:save', chat) as Promise<void>,
  deleteChat: (id: string) => ipcRenderer.invoke('chats:delete', id) as Promise<boolean>
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

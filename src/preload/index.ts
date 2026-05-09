import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  ChatActivity,
  ChatMessage,
  ChatStreamDelta,
  ChatStreamDone,
  ChatStreamError,
  ChooseChatThreadBackgroundResult,
  AppUpdateCheckResult,
  AppUpdateEvent,
  ReadChatThreadBackgroundRequest,
  ReadChatThreadBackgroundResult,
  CommandChunk,
  CommandResult,
  ModelInfo,
  ModelListOptions,
  NexusSetupRequest,
  NexusSetupResult,
  OpenFile,
  SavedChat,
  SavedChatMeta,
  ToolApprovalRequest,
  WorkspaceChanged,
  WorkspaceChanges,
  WorkspaceNode,
  WizardDocument,
  WizardPromptApprovalRequest,
  WizardProfile,
  WizardMythwizExportRequest,
  WizardMythwizExportResult,
  WizardMythwizPickImportResult,
  WizardSetupRequest,
  WizardSetupResult,
  ProviderKind,
  ReleaseNotesCache
} from '@shared/types';

const electronAPI = {
  platform: process.platform,
  loadSettings: () => ipcRenderer.invoke('settings:load') as Promise<AppSettings>,
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke('settings:save', settings) as Promise<AppSettings>,
  checkForUpdates: () => ipcRenderer.invoke('app:update-check') as Promise<AppUpdateCheckResult>,
  downloadUpdate: () => ipcRenderer.invoke('app:update-download') as Promise<{ ok: boolean; error?: string }>,
  getReleaseNotes: () => ipcRenderer.invoke('app:release-notes:get') as Promise<ReleaseNotesCache>,
  refreshReleaseNotes: () => ipcRenderer.invoke('app:release-notes:refresh') as Promise<ReleaseNotesCache>,
  chooseWorkspace: () =>
    ipcRenderer.invoke('workspace:choose') as Promise<{ root: string; label: string; tree: WorkspaceNode[] } | null>,
  openLastWorkspace: () =>
    ipcRenderer.invoke('workspace:open-last') as Promise<{ root: string; label: string; tree: WorkspaceNode[] } | null>,
  getLastValidWorkspaceRoot: () =>
    ipcRenderer.invoke('workspace:last-valid-root') as Promise<string | null>,
  activateWorkspace: (root: string) =>
    ipcRenderer.invoke('workspace:activate', root) as Promise<{ root: string; label: string; tree: WorkspaceNode[] }>,
  getWorkspaceTree: (root: string) => ipcRenderer.invoke('workspace:tree', root) as Promise<WorkspaceNode[]>,
  detachWorkspace: () => ipcRenderer.invoke('workspace:detach') as Promise<void>,
  openFile: (root: string, target: string) =>
    ipcRenderer.invoke('workspace:open-file', root, target) as Promise<OpenFile>,
  saveFile: (root: string, target: string, content: string) =>
    ipcRenderer.invoke('workspace:save-file', root, target, content) as Promise<OpenFile>,
  getWorkspaceChanges: (root: string) =>
    ipcRenderer.invoke('workspace:changes', root) as Promise<WorkspaceChanges>,
  getRecommendedWizardWorkspace: (name: string) =>
    ipcRenderer.invoke('wizard:recommended-workspace', name) as Promise<string>,
  chooseWizardWorkspace: (name: string, preferredDefaultPath?: string) =>
    ipcRenderer.invoke('wizard:choose-workspace', name, preferredDefaultPath) as Promise<string | null>,
  chooseWizardProjectsFolder: (preferredDefaultPath?: string) =>
    ipcRenderer.invoke('wizard:choose-projects-folder', preferredDefaultPath) as Promise<string | null>,
  setupWizard: (request: WizardSetupRequest) =>
    ipcRenderer.invoke('wizard:setup', request) as Promise<WizardSetupResult>,
  syncWizardWorkspaceFolder: (profile: WizardProfile) =>
    ipcRenderer.invoke('wizard:sync-workspace-folder', profile) as Promise<WizardProfile>,
  listWizardDocuments: (workspaceRoot: string) =>
    ipcRenderer.invoke('wizard:list-documents', workspaceRoot) as Promise<WizardDocument[]>,
  readWizardDocument: (workspaceRoot: string, target: string) =>
    ipcRenderer.invoke('wizard:read-document', workspaceRoot, target) as Promise<OpenFile>,
  listWizardExportFiles: (workspaceRoot: string) =>
    ipcRenderer.invoke('wizard:list-export-files', workspaceRoot) as Promise<string[]>,
  exportWizardMythwiz: (request: WizardMythwizExportRequest) =>
    ipcRenderer.invoke('wizard:export-mythwiz', request) as Promise<WizardMythwizExportResult>,
  chooseWizardImportMythwiz: () =>
    ipcRenderer.invoke('wizard:choose-import-mythwiz') as Promise<WizardMythwizPickImportResult>,
  deleteWizardWorkspace: (root: string) =>
    ipcRenderer.invoke('wizard:delete-workspace', root) as Promise<{ path: string }>,
  chooseNexusWorkspace: (preferredDefaultPath?: string) =>
    ipcRenderer.invoke('nexus:choose-workspace', preferredDefaultPath) as Promise<string | null>,
  setupNexus: (request: NexusSetupRequest) =>
    ipcRenderer.invoke('nexus:setup', request) as Promise<NexusSetupResult>,
  respondWizardPromptApproval: (id: string, approved: boolean) =>
    ipcRenderer.invoke('wizard:prompt-approval-response', id, approved) as Promise<void>,
  respondToolApproval: (id: string, approved: boolean) =>
    ipcRenderer.invoke('tool:approval-response', id, approved) as Promise<void>,
  onWizardPromptApprovalRequest: (callback: (payload: WizardPromptApprovalRequest) => void) => {
    const listener = (_event: unknown, payload: WizardPromptApprovalRequest) => callback(payload);
    ipcRenderer.on('wizard:prompt-approval-request', listener);
    return () => ipcRenderer.removeListener('wizard:prompt-approval-request', listener);
  },
  onToolApprovalRequest: (callback: (payload: ToolApprovalRequest) => void) => {
    const listener = (_event: unknown, payload: ToolApprovalRequest) => callback(payload);
    ipcRenderer.on('tool:approval-request', listener);
    return () => ipcRenderer.removeListener('tool:approval-request', listener);
  },
  onAppUpdateEvent: (callback: (payload: AppUpdateEvent) => void) => {
    const listener = (_event: unknown, payload: AppUpdateEvent) => callback(payload);
    ipcRenderer.on('app:update-event', listener);
    return () => ipcRenderer.removeListener('app:update-event', listener);
  },
  openExternalUrl: (url: string) => ipcRenderer.invoke('shell:open-external', url) as Promise<void>,
  saveGeneratedMedia: (dataUrl: string, fileName: string, filePath?: string) =>
    ipcRenderer.invoke('generated-media:save', dataUrl, fileName, filePath) as Promise<{ ok: boolean; path?: string; cancelled?: boolean; error?: string }>,
  openGeneratedImage: (dataUrl: string, fileName: string, mimeType: string, filePath?: string) =>
    ipcRenderer.invoke('generated-media:open-image', dataUrl, fileName, mimeType, filePath) as Promise<{ ok: boolean; error?: string }>,
  listModels: (settings: AppSettings, providerKind?: 'lmstudio' | 'openrouter', options?: ModelListOptions) =>
    ipcRenderer.invoke('models:list', settings, providerKind, options) as Promise<ModelInfo[]>,
  streamChat: (
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
      nexusLeaderProvider?: ProviderKind;
      nexusLeaderModel?: string;
      nexusLeaderName?: string;
      mediaGenerationKind?: 'music' | 'video' | 'image';
    }
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
  onChatsUpdated: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('chats:updated', listener);
    return () => ipcRenderer.removeListener('chats:updated', listener);
  },
  listChats: () => ipcRenderer.invoke('chats:list') as Promise<SavedChatMeta[]>,
  loadChat: (id: string) => ipcRenderer.invoke('chats:load', id) as Promise<SavedChat | null>,
  saveChat: (chat: SavedChat) => ipcRenderer.invoke('chats:save', chat) as Promise<void>,
  deleteChat: (id: string) => ipcRenderer.invoke('chats:delete', id) as Promise<boolean>,
  chooseChatThreadBackground: () =>
    ipcRenderer.invoke('ui:choose-chat-thread-background') as Promise<ChooseChatThreadBackgroundResult>,
  readChatThreadBackground: (request: ReadChatThreadBackgroundRequest | string) =>
    ipcRenderer.invoke('ui:read-chat-thread-background', request) as Promise<ReadChatThreadBackgroundResult>
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

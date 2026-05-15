import { contextBridge, ipcRenderer } from "electron";
const electronAPI = {
  platform: process.platform,
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  checkForUpdates: () => ipcRenderer.invoke("app:update-check"),
  downloadUpdate: () => ipcRenderer.invoke("app:update-download"),
  getReleaseNotes: () => ipcRenderer.invoke("app:release-notes:get"),
  refreshReleaseNotes: () => ipcRenderer.invoke("app:release-notes:refresh"),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  openLastWorkspace: () => ipcRenderer.invoke("workspace:open-last"),
  getLastValidWorkspaceRoot: () => ipcRenderer.invoke("workspace:last-valid-root"),
  activateWorkspace: (root) => ipcRenderer.invoke("workspace:activate", root),
  getWorkspaceTree: (root) => ipcRenderer.invoke("workspace:tree", root),
  openWorkspaceFolder: (root) => ipcRenderer.invoke("workspace:open-folder", root),
  detachWorkspace: () => ipcRenderer.invoke("workspace:detach"),
  openFile: (root, target) => ipcRenderer.invoke("workspace:open-file", root, target),
  saveFile: (root, target, content) => ipcRenderer.invoke("workspace:save-file", root, target, content),
  getWorkspaceChanges: (root) => ipcRenderer.invoke("workspace:changes", root),
  getRecommendedWizardWorkspace: (name) => ipcRenderer.invoke("wizard:recommended-workspace", name),
  chooseWizardWorkspace: (name, preferredDefaultPath) => ipcRenderer.invoke("wizard:choose-workspace", name, preferredDefaultPath),
  chooseWizardProjectsFolder: (preferredDefaultPath) => ipcRenderer.invoke("wizard:choose-projects-folder", preferredDefaultPath),
  setupWizard: (request) => ipcRenderer.invoke("wizard:setup", request),
  syncWizardWorkspaceFolder: (profile) => ipcRenderer.invoke("wizard:sync-workspace-folder", profile),
  listWizardDocuments: (workspaceRoot) => ipcRenderer.invoke("wizard:list-documents", workspaceRoot),
  readWizardDocument: (workspaceRoot, target) => ipcRenderer.invoke("wizard:read-document", workspaceRoot, target),
  listWizardExportFiles: (workspaceRoot) => ipcRenderer.invoke("wizard:list-export-files", workspaceRoot),
  exportWizardMythwiz: (request) => ipcRenderer.invoke("wizard:export-mythwiz", request),
  chooseWizardImportMythwiz: () => ipcRenderer.invoke("wizard:choose-import-mythwiz"),
  deleteWizardWorkspace: (root) => ipcRenderer.invoke("wizard:delete-workspace", root),
  chooseNexusWorkspace: (preferredDefaultPath) => ipcRenderer.invoke("nexus:choose-workspace", preferredDefaultPath),
  setupNexus: (request) => ipcRenderer.invoke("nexus:setup", request),
  respondWizardPromptApproval: (id, approved) => ipcRenderer.invoke("wizard:prompt-approval-response", id, approved),
  respondToolApproval: (id, approved) => ipcRenderer.invoke("tool:approval-response", id, approved),
  onWizardPromptApprovalRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("wizard:prompt-approval-request", listener);
    return () => ipcRenderer.removeListener("wizard:prompt-approval-request", listener);
  },
  onToolApprovalRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("tool:approval-request", listener);
    return () => ipcRenderer.removeListener("tool:approval-request", listener);
  },
  onAppUpdateEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("app:update-event", listener);
    return () => ipcRenderer.removeListener("app:update-event", listener);
  },
  openExternalUrl: (url) => ipcRenderer.invoke("shell:open-external", url),
  saveGeneratedMedia: (dataUrl, fileName, filePath) => ipcRenderer.invoke("generated-media:save", dataUrl, fileName, filePath),
  openGeneratedImage: (dataUrl, fileName, mimeType, filePath) => ipcRenderer.invoke("generated-media:open-image", dataUrl, fileName, mimeType, filePath),
  getOpenRouterCredits: (settings) => ipcRenderer.invoke("openrouter:credits", settings),
  listModels: (settings, providerKind, options) => ipcRenderer.invoke("models:list", settings, providerKind, options),
  streamChat: (requestId, settings, messages, runtime) => ipcRenderer.invoke("chat:stream", requestId, settings, messages, runtime),
  stopChat: (requestId) => ipcRenderer.invoke("chat:stop", requestId),
  runCommand: (command, cwd) => ipcRenderer.invoke("commands:run", command, cwd),
  killCommand: (jobId) => ipcRenderer.invoke("commands:kill", jobId),
  onCommandChunk: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("commands:chunk", listener);
    return () => ipcRenderer.removeListener("commands:chunk", listener);
  },
  onCommandDone: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("commands:done", listener);
    return () => ipcRenderer.removeListener("commands:done", listener);
  },
  onChatDelta: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("chat:delta", listener);
    return () => ipcRenderer.removeListener("chat:delta", listener);
  },
  onChatDone: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("chat:done", listener);
    return () => ipcRenderer.removeListener("chat:done", listener);
  },
  onChatError: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("chat:error", listener);
    return () => ipcRenderer.removeListener("chat:error", listener);
  },
  onChatActivity: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("chat:activity", listener);
    return () => ipcRenderer.removeListener("chat:activity", listener);
  },
  onWorkspaceChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("workspace:changed", listener);
    return () => ipcRenderer.removeListener("workspace:changed", listener);
  },
  onSettingsUpdated: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on("settings:updated", listener);
    return () => ipcRenderer.removeListener("settings:updated", listener);
  },
  onChatsUpdated: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("chats:updated", listener);
    return () => ipcRenderer.removeListener("chats:updated", listener);
  },
  listChats: () => ipcRenderer.invoke("chats:list"),
  loadChat: (id) => ipcRenderer.invoke("chats:load", id),
  saveChat: (chat) => ipcRenderer.invoke("chats:save", chat),
  deleteChat: (id) => ipcRenderer.invoke("chats:delete", id),
  chooseChatThreadBackground: () => ipcRenderer.invoke("ui:choose-chat-thread-background"),
  readChatThreadBackground: (request) => ipcRenderer.invoke("ui:read-chat-thread-background", request)
};
contextBridge.exposeInMainWorld("electronAPI", electronAPI);

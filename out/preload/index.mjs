import { contextBridge, ipcRenderer } from "electron";
const electronAPI = {
  platform: process.platform,
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  getWorkspaceTree: (root) => ipcRenderer.invoke("workspace:tree", root),
  openFile: (root, target) => ipcRenderer.invoke("workspace:open-file", root, target),
  saveFile: (root, target, content) => ipcRenderer.invoke("workspace:save-file", root, target, content),
  listModels: (settings, providerKind) => ipcRenderer.invoke("models:list", settings, providerKind),
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
  listChats: () => ipcRenderer.invoke("chats:list"),
  loadChat: (id) => ipcRenderer.invoke("chats:load", id),
  saveChat: (chat) => ipcRenderer.invoke("chats:save", chat),
  deleteChat: (id) => ipcRenderer.invoke("chats:delete", id)
};
contextBridge.exposeInMainWorld("electronAPI", electronAPI);

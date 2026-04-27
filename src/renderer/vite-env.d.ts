/// <reference types="vite/client" />

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
  WorkspaceNode
} from '@shared/types';

declare global {
  interface Window {
    electronAPI: {
      platform: string;
      loadSettings: () => Promise<AppSettings>;
      saveSettings: (settings: AppSettings) => Promise<AppSettings>;
      chooseWorkspace: () => Promise<{ root: string; label: string; tree: WorkspaceNode[] } | null>;
      getWorkspaceTree: (root: string) => Promise<WorkspaceNode[]>;
      openFile: (root: string, target: string) => Promise<OpenFile>;
      saveFile: (root: string, target: string, content: string) => Promise<OpenFile>;
      listModels: (settings: AppSettings, providerKind?: 'lmstudio' | 'openrouter') => Promise<ModelInfo[]>;
      streamChat: (
        requestId: string,
        settings: AppSettings,
        messages: ChatMessage[],
        runtime: { workspaceRoot?: string; activeFilePath?: string; conversationId?: string }
      ) => Promise<{ ok: boolean }>;
      stopChat: (requestId: string) => Promise<boolean>;
      runCommand: (command: string, cwd?: string) => Promise<{ jobId: string }>;
      killCommand: (jobId: string) => Promise<boolean>;
      onCommandChunk: (callback: (payload: CommandChunk) => void) => () => void;
      onCommandDone: (callback: (payload: CommandResult) => void) => () => void;
      onChatDelta: (callback: (payload: ChatStreamDelta) => void) => () => void;
      onChatDone: (callback: (payload: ChatStreamDone) => void) => () => void;
      onChatError: (callback: (payload: ChatStreamError) => void) => () => void;
      onChatActivity: (callback: (payload: ChatActivity) => void) => () => void;
      onWorkspaceChanged: (callback: (payload: WorkspaceChanged) => void) => () => void;
      listChats: () => Promise<SavedChatMeta[]>;
      loadChat: (id: string) => Promise<SavedChat | null>;
      saveChat: (chat: SavedChat) => Promise<void>;
      deleteChat: (id: string) => Promise<boolean>;
    };
  }
}

export {};

/// <reference types="vite/client" />

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
  OpenRouterCreditsResult,
  ProjectSettings,
  PromptSnippet,
  ChatSearchResult,
  CostDashboardSummary,
  SavedChat,
  SavedChatMeta,
  TestRunSummary,
  ToolHistoryEntry,
  ToolApprovalRequest,
  WorkspaceChanged,
  WorkspaceChanges,
  WorkspaceNode,
  WizardDocument,
  WizardMythwizExportRequest,
  WizardMythwizExportResult,
  WizardMythwizPickImportResult,
  WizardPromptApprovalRequest,
  WizardSetupRequest,
  WizardSetupResult,
  WizardProfile,
  ProviderKind,
  ReleaseNotesCache
} from '@shared/types';

declare global {
  const __MYTHRA_VERSION__: string;

  interface Window {
    electronAPI: {
      platform: string;
      loadSettings: () => Promise<AppSettings>;
      saveSettings: (settings: AppSettings) => Promise<AppSettings>;
      checkForUpdates: () => Promise<AppUpdateCheckResult>;
      downloadUpdate: () => Promise<{ ok: boolean; error?: string }>;
      getReleaseNotes: () => Promise<ReleaseNotesCache>;
      refreshReleaseNotes: () => Promise<ReleaseNotesCache>;
      chooseWorkspace: () => Promise<{ root: string; label: string; tree: WorkspaceNode[] } | null>;
      openLastWorkspace: () => Promise<{ root: string; label: string; tree: WorkspaceNode[] } | null>;
      getLastValidWorkspaceRoot: () => Promise<string | null>;
      activateWorkspace: (root: string) => Promise<{ root: string; label: string; tree: WorkspaceNode[] }>;
      getWorkspaceTree: (root: string) => Promise<WorkspaceNode[]>;
      openWorkspaceFolder: (root: string) => Promise<void>;
      detachWorkspace: () => Promise<void>;
      openFile: (root: string, target: string) => Promise<OpenFile>;
      saveFile: (root: string, target: string, content: string) => Promise<OpenFile>;
      getWorkspaceChanges: (root: string) => Promise<WorkspaceChanges>;
      discardWorkspacePatch: (root: string, patch: string) => Promise<WorkspaceChanges>;
      getRecommendedWizardWorkspace: (name: string) => Promise<string>;
      chooseWizardWorkspace: (name: string, preferredDefaultPath?: string) => Promise<string | null>;
      chooseWizardProjectsFolder: (preferredDefaultPath?: string) => Promise<string | null>;
      chooseNexusWorkspace: (preferredDefaultPath?: string) => Promise<string | null>;
      setupNexus: (request: NexusSetupRequest) => Promise<NexusSetupResult>;
      setupWizard: (request: WizardSetupRequest) => Promise<WizardSetupResult>;
      listWizardDocuments: (workspaceRoot: string) => Promise<WizardDocument[]>;
      readWizardDocument: (workspaceRoot: string, target: string) => Promise<OpenFile>;
      listWizardExportFiles: (workspaceRoot: string) => Promise<string[]>;
      exportWizardMythwiz: (request: WizardMythwizExportRequest) => Promise<WizardMythwizExportResult>;
      chooseWizardImportMythwiz: () => Promise<WizardMythwizPickImportResult>;
      syncWizardWorkspaceFolder: (profile: WizardProfile) => Promise<WizardProfile>;
      deleteWizardWorkspace: (root: string) => Promise<{ path: string }>;
      respondWizardPromptApproval: (id: string, approved: boolean) => Promise<void>;
      respondToolApproval: (id: string, approved: boolean) => Promise<void>;
      onWizardPromptApprovalRequest: (callback: (payload: WizardPromptApprovalRequest) => void) => () => void;
      onToolApprovalRequest: (callback: (payload: ToolApprovalRequest) => void) => () => void;
      onAppUpdateEvent: (callback: (payload: AppUpdateEvent) => void) => () => void;
      openExternalUrl: (url: string) => Promise<void>;
      saveGeneratedMedia: (dataUrl: string, fileName: string, filePath?: string) => Promise<{ ok: boolean; path?: string; cancelled?: boolean; error?: string }>;
      openGeneratedImage: (dataUrl: string, fileName: string, mimeType: string, filePath?: string) => Promise<{ ok: boolean; error?: string }>;
      getOpenRouterCredits: (settings: AppSettings) => Promise<OpenRouterCreditsResult>;
      listModels: (settings: AppSettings, providerKind?: ProviderKind, options?: ModelListOptions) => Promise<ModelInfo[]>;
      streamChat: (
        requestId: string,
        settings: AppSettings,
        messages: ChatMessage[],
        runtime: {
          workspaceRoot?: string;
          activeFilePath?: string;
          conversationId?: string;
          wizardId?: string;
          nexusId?: string;
          wizardName?: string;
          wizardSystemPrompt?: string;
          wizardFullAccess?: boolean;
          wizardAllowOutsideWorkspace?: boolean;
          nexusTeamFullAccess?: boolean;
          nexusTeamWorkspaces?: import('@shared/types').NexusTeamWorkspaceReference[];
          nexusLeaderApprovesTools?: boolean;
          nexusLeaderProvider?: ProviderKind;
          nexusLeaderModel?: string;
          nexusLeaderName?: string;
          mediaGenerationKind?: 'music' | 'video' | 'image';
        }
      ) => Promise<{ ok: boolean }>;
      stopChat: (requestId: string) => Promise<boolean>;
      runCommand: (command: string, cwd?: string) => Promise<{ jobId: string }>;
      runCommandCapture: (command: string, cwd?: string) => Promise<{
        stdout: string;
        stderr: string;
        code: number | null;
        signal: NodeJS.Signals | null;
        startedAt: number;
        finishedAt: number;
      }>;
      killCommand: (jobId: string) => Promise<boolean>;
      onCommandChunk: (callback: (payload: CommandChunk) => void) => () => void;
      onCommandDone: (callback: (payload: CommandResult) => void) => () => void;
      onChatDelta: (callback: (payload: ChatStreamDelta) => void) => () => void;
      onChatDone: (callback: (payload: ChatStreamDone) => void) => () => void;
      onChatError: (callback: (payload: ChatStreamError) => void) => () => void;
      onChatActivity: (callback: (payload: ChatActivity) => void) => () => void;
      onWorkspaceChanged: (callback: (payload: WorkspaceChanged) => void) => () => void;
      onSettingsUpdated: (callback: (settings: AppSettings) => void) => () => void;
      onChatsUpdated: (callback: () => void) => () => void;
      listChats: () => Promise<SavedChatMeta[]>;
      loadChat: (id: string) => Promise<SavedChat | null>;
      searchChats: (query: string, limit?: number) => Promise<ChatSearchResult[]>;
      getCostDashboardSummary: () => Promise<CostDashboardSummary>;
      saveChat: (chat: SavedChat) => Promise<void>;
      deleteChat: (id: string) => Promise<boolean>;
      listPromptSnippets: () => Promise<PromptSnippet[]>;
      savePromptSnippet: (snippet: PromptSnippet) => Promise<PromptSnippet>;
      deletePromptSnippet: (id: string) => Promise<boolean>;
      getProjectSettings: (workspaceRoot: string) => Promise<ProjectSettings>;
      saveProjectSettings: (settings: ProjectSettings) => Promise<ProjectSettings>;
      listToolHistory: (limit?: number) => Promise<ToolHistoryEntry[]>;
      appendToolHistory: (entry: ToolHistoryEntry) => Promise<ToolHistoryEntry>;
      listTestRuns: (workspaceRoot?: string, limit?: number) => Promise<TestRunSummary[]>;
      saveTestRun: (run: TestRunSummary) => Promise<TestRunSummary>;
      chooseChatThreadBackground: () => Promise<ChooseChatThreadBackgroundResult>;
      readChatThreadBackground: (request: ReadChatThreadBackgroundRequest | string) => Promise<ReadChatThreadBackgroundResult>;
    };
  }
}

export {};

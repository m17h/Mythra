import type { ThemeId } from './themes';

export type ProviderKind = 'lmstudio' | 'openrouter';

/** Per saved chat: route API calls through this provider + model instead of app Settings. */
export interface ChatModelOverride {
  provider: ProviderKind;
  model: string;
}

export type ChatKind = 'normal' | 'wizard' | 'wizard-session';

export interface WizardDocument {
  path: string;
  label: string;
  core: boolean;
}

export interface WizardProfile {
  name: string;
  workspaceRoot: string;
  provider: ProviderKind;
  model: string;
  systemPrompt: string;
  documents: WizardDocument[];
  /**
   * When true, file writes, deletes, shell commands, and similar tool actions run without per-action approval
   * for this Wizard’s sessions (same idea as Settings → Agent autonomy → Full access for normal chats).
   */
  fullAccess?: boolean;
}

export interface WizardSetupRequest {
  name: string;
  provider: ProviderKind;
  model: string;
  systemPrompt: string;
  /**
   * Absolute path of the folder that holds Wizard workspaces. Each Wizard is created at
   * `<wizardProjectsParent>/<sanitized wizard name>/`.
   */
  workspaceRoot?: string;
  /** @deprecated Parent folder should be set explicitly; when true and no workspaceRoot, Desktop is used as parent. */
  createOnDesktop?: boolean;
  customDocuments?: string[];
  /** Optional onboarding text merged into soul.md (identity, tone, boundaries). */
  wizardPersonality?: string;
  /** Optional onboarding text merged into memory.md (durable facts to remember). */
  wizardMemory?: string;
}

export interface WizardSetupResult {
  profile: WizardProfile;
  tree: WorkspaceNode[];
}

export interface WizardPromptApprovalRequest {
  id: string;
  title: string;
  wizardName: string;
  before: string;
  after: string;
}

/** In-app confirmation for tool actions when Full access is off. */
export interface ToolApprovalRequest {
  id: string;
  title: string;
  detail: string;
  /** When both are set (UTF-8 text), the renderer shows Wizard-style side-by-side diff with highlighted lines instead of plain `detail` only. */
  diffBefore?: string;
  diffAfter?: string;
}

/** User-saved system prompt preset for a provider profile. */
export interface SavedPromptPreset {
  id: string;
  name: string;
  prompt: string;
  updatedAt: number;
}

export interface ProviderProfile {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  /** Selected preset row, or `null` when the prompt box is a draft not tied to a saved preset. */
  activePromptPresetId: string | null;
  promptPresets: SavedPromptPreset[];
  appName: string;
  appUrl: string;
}

export interface ToolPermissions {
  fileRead: boolean;
  fileWrite: boolean;
  workspaceSearch: boolean;
  commandDeck: boolean;
  /**
   * When true (Agent mode only), the model may call `set_system_prompt` to replace the
   * active provider’s system prompt in Settings, subject to approval unless Full access is on.
   */
  allowModelSystemPrompt: boolean;
}

export type SessionMode = 'agent' | 'talk';
export type SearchProvider = 'duckduckgo' | 'tavily' | 'brave';

export interface SearchSettings {
  provider: SearchProvider;
  tavilyApiKey: string;
  braveApiKey: string;
}

export interface UiSettings {
  themeId: ThemeId;
  /**
   * When `themeId` is `custom`, design-token overrides merged on top of the custom base stylesheet.
   * Cleared when the user picks a preset theme.
   */
  customThemeTokens?: Record<string, string>;
  /** Agent: workspace, tools, and autonomous run markers. Chat (`talk`): plain chat, no file tools. */
  sessionMode: SessionMode;
  /** When on, the `web_search` tool is available in both Chat and Agent (public web via built-in search). */
  webSearch: boolean;
  /**
   * Per-provider favorited model ids (matches catalog `id` for that provider).
   * Used in Settings model picker: favorites sort first, then the rest.
   */
  favoriteModels: Record<ProviderKind, string[]>;
  /**
   * Folder where new Wizards get subfolders (`<this>/<sanitized name>/`). Persisted when chosen in New Wizard.
   */
  wizardProjectsParentFolder: string | null;
}

export interface AgentSettings {
  fullAccess: boolean;
  autoContinue: boolean;
  maxAutoSteps: number;
}

export interface AppSettings {
  selectedProvider: ProviderKind;
  providers: Record<ProviderKind, ProviderProfile>;
  search: SearchSettings;
  tools: ToolPermissions;
  agent: AgentSettings;
  ui: UiSettings;
  /**
   * Most recently opened workspace folder (persists after Clear workspace).
   * Used for “Open last workspace” when nothing is mounted.
   */
  lastWorkspaceRoot: string | null;
}

export interface ModelInfo {
  id: string;
  contextLength?: number;
  ownedBy?: string;
}

export interface WorkspaceNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: WorkspaceNode[];
}

export interface OpenFile {
  path: string;
  content: string;
  /** When set (PNG, JPEG, GIF, WebP, SVG, …), the editor shows this preview instead of Monaco. */
  imagePreview?: {
    mimeType: string;
    dataUrl: string;
  };
}

export interface CommandChunk {
  jobId: string;
  stream: 'stdout' | 'stderr' | 'system';
  chunk: string;
}

export interface CommandResult {
  jobId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** When the API returns separable model reasoning (e.g. OpenRouter), shown in a collapsible "Thinking" block. */
  reasoning?: string;
  attachments?: ChatAttachment[];
  status?: 'streaming' | 'done' | 'error';
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface ChatStreamDelta {
  requestId: string;
  /** Assistant reply text. */
  delta: string;
  /** Reasoning / thinking text (e.g. OpenRouter stream `reasoning` delta). */
  reasoningDelta?: string;
}

/** When the provider returns usage (OpenAI-compatible stream with stream_options.include_usage). */
export interface ChatCompletionTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatStreamDone {
  requestId: string;
  content: string;
  /** Final model reasoning, if the provider sent any (e.g. non-streaming message.reasoning). */
  reasoning?: string;
  /** Present when the upstream API reported token usage for this completion. */
  usage?: ChatCompletionTokenUsage;
}

export interface ChatStreamError {
  requestId: string;
  error: string;
}

export interface ChatActivity {
  id: string;
  requestId: string;
  kind: 'info' | 'tool' | 'command' | 'approval' | 'reasoning' | 'warning' | 'success' | 'finished' | 'stopped' | 'error';
  message: string;
}

export type ChatTimelineEntry =
  | {
      id: string;
      type: 'message';
      message: ChatMessage;
    }
  | {
      id: string;
      type: 'activity';
      activity: ChatActivity;
    };

export interface WorkspaceChanged {
  root: string;
  /** If set, this file was just written to disk (e.g. agent tool) — used to refresh an open editor buffer. */
  fileWritten?: string;
  /** If set, this path was deleted (file or tree) — used to close/remove an open buffer. */
  fileDeleted?: string;
}

export interface WorkspaceChanges {
  ok: boolean;
  root: string;
  status: string;
  diff: string;
  error?: string;
}

export interface SavedChat {
  id: string;
  kind?: ChatKind;
  title: string;
  /** If set to a non-empty string, that label is used instead of the auto title from the first user message. */
  titleOverride?: string | null;
  messages: ChatMessage[];
  timeline: ChatTimelineEntry[];
  createdAt: number;
  updatedAt: number;
  /** Shown at the top of the chat list when true. */
  pinned?: boolean;
  /**
   * When set, `streamChat` uses this provider + model for this thread (API keys/base URLs still come from Settings).
   * Omitted or `null` = use the app’s selected provider and model from Settings.
   */
  modelOverride?: ChatModelOverride | null;
  wizard?: WizardProfile | null;
  wizardId?: string | null;
}

export interface SavedChatMeta {
  id: string;
  kind?: ChatKind;
  title: string;
  titleOverride?: string | null;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  modelOverride?: ChatModelOverride | null;
  wizard?: WizardProfile | null;
  wizardId?: string | null;
}

export const defaultSettings: AppSettings = {
  selectedProvider: 'lmstudio',
  providers: {
    lmstudio: {
      kind: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: '',
      systemPrompt: '',
      activePromptPresetId: null,
      promptPresets: [],
      appName: 'Mythra',
      appUrl: 'https://example.local'
    },
    openrouter: {
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: '',
      model: '',
      systemPrompt: '',
      activePromptPresetId: null,
      promptPresets: [],
      appName: 'Mythra',
      appUrl: 'https://example.local'
    }
  },
  search: {
    provider: 'duckduckgo',
    tavilyApiKey: '',
    braveApiKey: ''
  },
  tools: {
    fileRead: true,
    fileWrite: true,
    workspaceSearch: true,
    commandDeck: true,
    allowModelSystemPrompt: false
  },
  agent: {
    fullAccess: false,
    autoContinue: true,
    maxAutoSteps: 24
  },
  ui: {
    themeId: 'neon-grid',
    sessionMode: 'agent',
    webSearch: false,
    favoriteModels: { lmstudio: [], openrouter: [] },
    wizardProjectsParentFolder: null
  },
  lastWorkspaceRoot: null
};

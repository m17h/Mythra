import { getPromptPreset } from './prompt-presets';
import type { ThemeId } from './themes';

export type ProviderKind = 'lmstudio' | 'openrouter';

/** Per saved chat: route API calls through this provider + model instead of app Settings. */
export interface ChatModelOverride {
  provider: ProviderKind;
  model: string;
}

export interface CustomPromptPreset {
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
  promptPresetId: string;
  systemPrompt: string;
  /** When `promptPresetId` is `custom`, the saved preset being edited (drives the prompt textarea and list). */
  activeCustomPresetId: string | null;
  customPromptPresets: CustomPromptPreset[];
  appName: string;
  appUrl: string;
}

export interface ToolPermissions {
  fileRead: boolean;
  fileWrite: boolean;
  workspaceSearch: boolean;
  commandDeck: boolean;
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
  /** Agent: workspace, tools, and autonomous run markers. Chat (`talk`): plain chat, no file tools. */
  sessionMode: SessionMode;
  /** When on, the `web_search` tool is available in both Chat and Agent (public web via built-in search). */
  webSearch: boolean;
  /**
   * Per-provider favorited model ids (matches catalog `id` for that provider).
   * Used in Settings model picker: favorites sort first, then the rest.
   */
  favoriteModels: Record<ProviderKind, string[]>;
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

export interface ChatStreamDone {
  requestId: string;
  content: string;
  /** Final model reasoning, if the provider sent any (e.g. non-streaming message.reasoning). */
  reasoning?: string;
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

export interface SavedChat {
  id: string;
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
}

export interface SavedChatMeta {
  id: string;
  title: string;
  titleOverride?: string | null;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  modelOverride?: ChatModelOverride | null;
}

export const defaultSettings: AppSettings = {
  selectedProvider: 'lmstudio',
  providers: {
    lmstudio: {
      kind: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: '',
      promptPresetId: 'general-coding',
      systemPrompt: getPromptPreset('general-coding').prompt,
      activeCustomPresetId: null,
      customPromptPresets: [],
      appName: 'OpenKiwi',
      appUrl: 'https://example.local'
    },
    openrouter: {
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: '',
      model: '',
      promptPresetId: 'general-coding',
      systemPrompt: getPromptPreset('general-coding').prompt,
      activeCustomPresetId: null,
      customPromptPresets: [],
      appName: 'OpenKiwi',
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
    commandDeck: true
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
    favoriteModels: { lmstudio: [], openrouter: [] }
  }
};

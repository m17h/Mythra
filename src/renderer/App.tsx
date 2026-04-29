import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { applyChatModelOverride, formatOverrideLabel } from '@renderer/lib/apply-model-override';
import { AppConfirmDialog } from './components/AppConfirmDialog';
import { AppSelect } from './components/AppSelect';
import { ChatPanel } from './components/ChatPanel';
import { ChangesPanel } from './components/ChangesPanel';
import { EditorPanel } from './components/EditorPanel';
import { FileTree } from './components/FileTree';
import { ModelSearch } from './components/ModelSearch';
import { MythraMark } from './components/MythraMark';
import { SettingsPanel } from './components/SettingsPanel';
import { SystemPromptModal } from './components/SystemPromptModal';
import { WizardSettingsPanel } from './components/WizardSettingsPanel';
import { WizardSetupModal } from './components/WizardSetupModal';
import {
  defaultSettings,
  type AppSettings,
  type ChatActivity,
  type ChatAttachment,
  type ChatMessage,
  type ChatModelOverride,
  type ChatCompletionTokenUsage,
  type ChatTimelineEntry,
  type ModelInfo,
  type OpenFile,
  type ProviderKind,
  type SessionMode,
  type SavedChat,
  type SavedChatMeta,
  type ToolApprovalRequest,
  type WizardDocument,
  type WizardProfile,
  type WizardPromptApprovalRequest,
  type WizardSetupRequest,
  type WorkspaceChanges,
  type WorkspaceNode
} from '@shared/types';
import { patchSystemPromptInSettings } from '@shared/patch-system-prompt';
import { isAllowedCustomThemeTokenKey, isLikelyLightCssBackground } from '@shared/themes';

const uid = () => Math.random().toString(36).slice(2, 10);
const pathLabel = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() ?? value;

/** Loose match for comparing filesystem roots across slash variants. */
const pathsEqual = (a: string, b: string) =>
  a.replace(/\\/g, '/').replace(/\/+$/, '') === b.replace(/\\/g, '/').replace(/\/+$/, '');

/** Remap absolute paths that lived under oldRoot to newRoot (same relative suffix). */
function workspaceAbsolutePathPrefixRemap(oldRoot: string, newRoot: string) {
  const norm = (s: string) => s.replace(/\\/g, '/');
  const oldBase = norm(oldRoot).replace(/\/+$/, '');
  const newBase = norm(newRoot).replace(/\/+$/, '');
  const oldLen = oldBase.length;
  return (p: string) => {
    const pn = norm(p);
    const prefix = `${oldBase}/`;
    if (pn === oldBase || pn.startsWith(prefix)) {
      const suffix = pn === oldBase ? '' : pn.slice(oldLen);
      return `${newBase}${suffix}`;
    }
    return p;
  };
}
const isEmbeddingModel = (modelId: string) => /embed|embedding/i.test(modelId);
const normalizeProviderBaseUrl = (kind: AppSettings['selectedProvider'], baseUrl: string) => {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  if (kind !== 'lmstudio') return trimmed;
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
};
const pickDefaultModel = (modelList: ModelInfo[], currentModel?: string) => {
  if (currentModel && modelList.some((m) => m.id === currentModel)) return currentModel;
  const preferred = modelList.find((m) => !isEmbeddingModel(m.id));
  return preferred?.id ?? modelList[0]?.id ?? '';
};
const providerOptions: Array<{ value: ProviderKind; label: string }> = [
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'openrouter', label: 'OpenRouter' }
];
const needsSearchApiKeyNotice = (settings: AppSettings) => {
  if (settings.search.provider === 'tavily') {
    return settings.search.tavilyApiKey.trim().length === 0;
  }
  if (settings.search.provider === 'brave') {
    return settings.search.braveApiKey.trim().length === 0;
  }
  return true;
};

const chatTitle = (messages: ChatMessage[]) => {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'New Chat';
  const text = first.content.trim();
  return text.length > 48 ? `${text.slice(0, 48)}...` : text || 'New Chat';
};

const resolveChatTitle = (messages: ChatMessage[], titleOverride: string | null | undefined) => {
  const t = titleOverride?.trim();
  if (t) return t;
  return chatTitle(messages);
};

const sessionTitle = (messages: ChatMessage[], fallback = 'New session') => {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return fallback;
  const text = first.content.trim();
  return text.length > 42 ? `${text.slice(0, 42)}...` : text || fallback;
};

const buildWizardSystemPrompt = (wizard: WizardProfile) => `${wizard.systemPrompt}

Mythra Wizard runtime:
- You are currently inside your private Wizard workspace: ${wizard.workspaceRoot}
- Always use this workspace for file reads, memory, and edits unless the user explicitly tells you otherwise.
- At the start of every new session, read soul.md, tools.md, memory.md, and corrections.md before giving your first substantive response.
- When asked about your identity, memory, tools, or corrections, read the matching Markdown file before answering.
- Do not use app theme tools unless the user explicitly asks to change Mythra's visual theme.`;

interface WizardDocsContextResult {
  message: ChatMessage | null;
  loaded: Array<{ name: string; ok: boolean }>;
}

const buildWizardDocsContext = async (wizard: WizardProfile): Promise<WizardDocsContextResult> => {
  const coreDocs = wizard.documents.filter((doc) => doc.core);
  if (coreDocs.length === 0) return { message: null, loaded: [] };
  const loaded: Array<{ name: string; ok: boolean }> = [];
  const parts = await Promise.all(
    coreDocs.map(async (doc) => {
      const name = doc.path.split(/[\\/]/).pop() ?? doc.label;
      try {
        const file = await window.electronAPI.openFile(wizard.workspaceRoot, doc.path);
        loaded.push({ name, ok: true });
        return `## ${name}\n${file.content}`;
      } catch {
        loaded.push({ name, ok: false });
        return `## ${name}\n[Could not read this document.]`;
      }
    })
  );
  return {
    loaded,
    message: {
      id: `wizard-docs-${Date.now()}`,
      role: 'system',
      content: [
        'Wizard core workspace documents are injected below. Treat these as current private context for this Wizard session.',
        ...parts
      ].join('\n\n'),
      status: 'done'
    }
  };
};

type DiffLineKind = 'same' | 'add' | 'remove';

const diffPromptLines = (before: string, after: string) => {
  const a = (before || '[empty]').split('\n');
  const b = (after || '[empty]').split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const left: Array<{ text: string; kind: DiffLineKind }> = [];
  const right: Array<{ text: string; kind: DiffLineKind }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      left.push({ text: a[i]!, kind: 'same' });
      right.push({ text: b[j]!, kind: 'same' });
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      right.push({ text: b[j]!, kind: 'add' });
      j += 1;
    } else if (i < a.length) {
      left.push({ text: a[i]!, kind: 'remove' });
      i += 1;
    }
  }
  return { left, right };
};

const chatFingerprint = (messages: ChatMessage[], timeline: ChatTimelineEntry[]) =>
  JSON.stringify({ messages, timeline });

const formatRelativeDate = (ts: number) => {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

interface FileBuffer extends OpenFile {
  dirty: boolean;
}

type InspectorTab = 'editor' | 'changes' | 'settings';
type SettingsInspectorScope = 'general' | 'wizard';
type SidebarTab = 'chats' | 'wizards' | 'files';

interface InFlightChat {
  chatId: string;
  requestId: string;
  messages: ChatMessage[];
  timeline: ChatTimelineEntry[];
}

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsStatus, setSettingsStatus] = useState('Load a provider profile, then refresh models.');
  const [workspaceRoot, setWorkspaceRoot] = useState<string>();
  const [workspaceTree, setWorkspaceTree] = useState<WorkspaceNode[]>([]);
  const [buffers, setBuffers] = useState<Record<string, FileBuffer>>({});
  const buffersRef = useRef<Record<string, FileBuffer>>({});
  buffersRef.current = buffers;
  const [activeFilePath, setActiveFilePath] = useState<string>();
  const [models, setModels] = useState<ModelInfo[]>([]);
  /** Last reported token totals from an completed provider response (streaming include_usage). */
  const [lastTokenUsage, setLastTokenUsage] = useState<ChatCompletionTokenUsage | null>(null);
  /** After at least one model-catalog fetch (success or fail); used so we show "Disconnected" instead of "Waiting" only once we know. */
  const [modelCatalogSettled, setModelCatalogSettled] = useState(false);

  /** Latest values each render so send uses up-to-date system prompt, workspace, and active file (no new chat required). */
  const settingsRef = useRef<AppSettings | null>(null);
  const workspaceRootRef = useRef<string | undefined>(undefined);
  const activeFilePathRef = useRef<string | undefined>(undefined);
  const chatSessionIdRef = useRef<string>('');
  settingsRef.current = settings;
  workspaceRootRef.current = workspaceRoot;
  activeFilePathRef.current = activeFilePath;

  /** New id on “New chat”; matches saved chat id when a thread is loaded — sent to the model as a fresh thread boundary. */
  const [chatSessionId, setChatSessionId] = useState(() => uid());
  chatSessionIdRef.current = chatSessionId;

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatTimeline, setChatTimeline] = useState<ChatTimelineEntry[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([]);
  const [chatStreaming, setChatStreaming] = useState(false);
  const [activeRequestId, setActiveRequestId] = useState<string>();
  const chatStreamingRef = useRef(false);

  const [activeChatId, setActiveChatId] = useState<string>();
  const activeChatIdRef = useRef<string | undefined>(undefined);
  const inFlightChatsRef = useRef<Map<string, InFlightChat>>(new Map());
  const [chatList, setChatList] = useState<SavedChatMeta[]>([]);
  /** Provider whose catalog to show in “This chat” model override (when enabled). */
  const [overrideModelProvider, setOverrideModelProvider] = useState<ProviderKind>('lmstudio');
  const [overrideModels, setOverrideModels] = useState<ModelInfo[]>([]);
  const [chatModelExpanded, setChatModelExpanded] = useState(false);
  /** Per-chat model override before the thread is saved (no activeChatId). Copied to disk on first send / persist. */
  const [newChatModelOverride, setNewChatModelOverride] = useState<ChatModelOverride | null>(null);
  const newChatModelOverrideRef = useRef<ChatModelOverride | null>(null);
  newChatModelOverrideRef.current = newChatModelOverride;
  chatStreamingRef.current = chatStreaming;

  const [inlineTerminalLogs, setInlineTerminalLogs] = useState('');
  const [inlineTerminalJobId, setInlineTerminalJobId] = useState<string>();
  const inlineTerminalJobIdRef = useRef<string | undefined>(undefined);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('settings');
  const [settingsInspectorScope, setSettingsInspectorScope] = useState<SettingsInspectorScope>('general');
  const settingsInspectorWizardIdRef = useRef<string | undefined>(undefined);
  const lastInspectorTabRef = useRef<InspectorTab>(inspectorTab);
  const [workspaceChanges, setWorkspaceChanges] = useState<WorkspaceChanges | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('chats');
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [showWizardSetup, setShowWizardSetup] = useState(false);
  const [showWebSearchNotice, setShowWebSearchNotice] = useState(false);
  const [showSystemPromptModal, setShowSystemPromptModal] = useState(false);
  const [showConnectionHelp, setShowConnectionHelp] = useState(false);
  const [searchSettingsFocusKey, setSearchSettingsFocusKey] = useState(0);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleDraft, setEditingTitleDraft] = useState('');
  const [wizardDraft, setWizardDraft] = useState<WizardProfile | null>(null);
  const [wizardDeleteTarget, setWizardDeleteTarget] = useState<SavedChatMeta | null>(null);
  const [wizardSessionDeleteTarget, setWizardSessionDeleteTarget] = useState<SavedChatMeta | null>(null);
  const [workspaceDeleteTarget, setWorkspaceDeleteTarget] = useState<{ wizardName: string; workspaceRoot: string } | null>(null);
  const [wizardPromptApproval, setWizardPromptApproval] = useState<WizardPromptApprovalRequest | null>(null);
  const [toolApprovalRequest, setToolApprovalRequest] = useState<ToolApprovalRequest | null>(null);
  const [expandedWizardIds, setExpandedWizardIds] = useState<Set<string>>(new Set());

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wizardAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wizardDraftRef = useRef<WizardProfile | null>(null);
  const lastContentFingerprintRef = useRef<string | null>(null);
  const skipNextRenameCommitRef = useRef(false);
  activeChatIdRef.current = activeChatId;

  const findInFlightByChatId = (chatId: string | undefined) => {
    if (!chatId) return undefined;
    for (const item of inFlightChatsRef.current.values()) {
      if (item.chatId === chatId) return item;
    }
    return undefined;
  };

  const showInFlightIfActive = (snapshot: InFlightChat) => {
    if (activeChatIdRef.current !== snapshot.chatId) return;
    setChatMessages(snapshot.messages);
    setChatTimeline(snapshot.timeline);
    setChatStreaming(true);
    setActiveRequestId(snapshot.requestId);
  };

  const updateInFlightMessage = (requestId: string, recipe: (msg: ChatMessage) => ChatMessage) => {
    const snapshot = inFlightChatsRef.current.get(requestId);
    if (!snapshot) {
      setChatMessages((current) => current.map((m) => (m.id === requestId ? recipe(m) : m)));
      updateTimelineMessage(requestId, recipe);
      return undefined;
    }

    snapshot.messages = snapshot.messages.map((m) => (m.id === requestId ? recipe(m) : m));
    snapshot.timeline = snapshot.timeline.map((entry) =>
      entry.type === 'message' && entry.message.id === requestId
        ? { ...entry, message: recipe(entry.message) }
        : entry
    );
    showInFlightIfActive(snapshot);
    return snapshot;
  };

  const appendActivity = (activity: ChatActivity) => {
    const entry: ChatTimelineEntry = { id: `activity-${activity.id}`, type: 'activity', activity };
    const snapshot = inFlightChatsRef.current.get(activity.requestId);
    if (snapshot) {
      snapshot.timeline = [...snapshot.timeline, entry];
      showInFlightIfActive(snapshot);
      return;
    }
    setChatTimeline((current) => [...current, entry]);
  };

  const updateTimelineMessage = (messageId: string, recipe: (msg: ChatMessage) => ChatMessage) => {
    setChatTimeline((current) =>
      current.map((entry) =>
        entry.type === 'message' && entry.message.id === messageId ? { ...entry, message: recipe(entry.message) } : entry
      )
    );
  };

  const refreshChatList = useCallback(async () => {
    const list = await window.electronAPI.listChats();
    setChatList(list);
  }, []);

  const refreshWorkspaceChanges = useCallback(async (rootOverride?: string) => {
    const root = rootOverride ?? workspaceRootRef.current;
    if (!root) {
      setWorkspaceChanges(null);
      return;
    }
    setChangesLoading(true);
    try {
      setWorkspaceChanges(await window.electronAPI.getWorkspaceChanges(root));
    } finally {
      setChangesLoading(false);
    }
  }, []);

  const saveChatSnapshot = useCallback(
    async (chatId: string, msgs: ChatMessage[], tl: ChatTimelineEntry[]) => {
      const disk = await window.electronAPI.loadChat(chatId);
      if (!disk) return;
      await window.electronAPI.saveChat({
        ...disk,
        title: resolveChatTitle(msgs, disk.titleOverride),
        messages: msgs,
        timeline: tl,
        updatedAt: Date.now()
      });
      await refreshChatList();
    },
    [refreshChatList]
  );

  const activeChatMeta = useMemo(
    () => (activeChatId ? chatList.find((c) => c.id === activeChatId) : undefined),
    [activeChatId, chatList]
  );
  const normalChatList = useMemo(() => chatList.filter((c) => (c.kind ?? 'normal') === 'normal'), [chatList]);
  const wizardChatList = useMemo(() => chatList.filter((c) => c.kind === 'wizard'), [chatList]);
  const wizardSessionsByWizardId = useMemo(() => {
    const map = new Map<string, SavedChatMeta[]>();
    for (const chat of chatList) {
      if (chat.kind !== 'wizard-session' || !chat.wizardId) continue;
      const list = map.get(chat.wizardId) ?? [];
      list.push(chat);
      map.set(chat.wizardId, list);
    }
    return map;
  }, [chatList]);

  /** Wizard selected from sidebar (settings/workspace) without an active chat thread. */
  const [sidebarFocusedWizardId, setSidebarFocusedWizardId] = useState<string | undefined>(undefined);

  const sidebarWizardListMeta = useMemo(
    () =>
      sidebarFocusedWizardId
        ? wizardChatList.find((c) => c.id === sidebarFocusedWizardId)
        : undefined,
    [sidebarFocusedWizardId, wizardChatList]
  );

  const activeWizardMeta = useMemo(() => {
    if (activeChatMeta?.kind === 'wizard-session' && activeChatMeta.wizardId) {
      return chatList.find((c) => c.id === activeChatMeta.wizardId && c.kind === 'wizard');
    }
    if (activeChatMeta?.kind === 'wizard') {
      return activeChatMeta;
    }
    return sidebarWizardListMeta;
  }, [activeChatMeta, chatList, sidebarWizardListMeta]);
  const activeWizard = activeWizardMeta?.wizard ?? null;

  useEffect(() => {
    setWizardDraft(activeWizard);
  }, [activeChatId, activeWizard]);

  useEffect(() => {
    const id = activeWizardMeta?.id;
    if (!id) {
      setSettingsInspectorScope('general');
      settingsInspectorWizardIdRef.current = undefined;
      return;
    }
    const prev = settingsInspectorWizardIdRef.current;
    if (prev !== id) {
      settingsInspectorWizardIdRef.current = id;
      if (prev === undefined) setSettingsInspectorScope('wizard');
    }
  }, [activeWizardMeta?.id]);

  useEffect(() => {
    wizardDraftRef.current = wizardDraft;
  }, [wizardDraft]);

  useEffect(() => {
    if (wizardAutosaveTimerRef.current) {
      clearTimeout(wizardAutosaveTimerRef.current);
      wizardAutosaveTimerRef.current = null;
    }
  }, [activeWizardMeta?.id]);

  const effectiveModelOverride = useMemo((): ChatModelOverride | null => {
    if (activeChatId) return activeChatMeta?.modelOverride ?? null;
    return newChatModelOverride;
  }, [activeChatId, activeChatMeta?.modelOverride, newChatModelOverride]);

  const showWizardHubPlaceholder = useMemo(
    () =>
      sidebarTab === 'wizards' &&
      !sidebarFocusedWizardId &&
      activeChatMeta?.kind !== 'wizard-session',
    [sidebarTab, sidebarFocusedWizardId, activeChatMeta?.kind]
  );

  const chatSessionSubheading = useMemo(() => {
    if (
      sidebarTab === 'wizards' &&
      !sidebarFocusedWizardId &&
      activeChatMeta?.kind !== 'wizard-session'
    ) {
      return 'Select a Wizard to get started';
    }
    if (activeWizard) {
      const session =
        activeChatMeta?.kind === 'wizard-session'
          ? activeChatMeta.title
          : !activeChatId && sidebarFocusedWizardId && activeWizardMeta?.id === sidebarFocusedWizardId
            ? 'New session on first send'
            : activeChatMeta?.kind === 'wizard'
              ? 'Home'
              : 'Home';
      return `${activeWizard.name} · ${session} · ${pathLabel(activeWizard.workspaceRoot)}`;
    }
    if (chatMessages.length === 0) {
      if (newChatModelOverride?.model) {
        return `New conversation · ${formatOverrideLabel(newChatModelOverride, pathLabel)}`;
      }
      return 'New conversation';
    }
    if (activeChatId) {
      const meta = chatList.find((c) => c.id === activeChatId);
      if (meta?.title) {
        const base = meta.title;
        if (meta.modelOverride?.model) {
          return `${base} · ${formatOverrideLabel(meta.modelOverride, pathLabel)}`;
        }
        return base;
      }
    }
    return chatTitle(chatMessages);
  }, [
    activeChatId,
    activeChatMeta,
    activeWizard,
    activeWizardMeta?.id,
    chatList,
    chatMessages,
    newChatModelOverride,
    pathLabel,
    sidebarFocusedWizardId,
    sidebarTab
  ]);

  const persistCurrentChat = useCallback(
    async (msgs: ChatMessage[], tl: ChatTimelineEntry[], chatId?: string) => {
      if (msgs.length === 0) return;
      const id = chatId ?? uid();
      const fp = chatFingerprint(msgs, tl);
      if (fp === lastContentFingerprintRef.current) {
        if (chatId) return id;
        return;
      }
      const now = Date.now();
      const existing = chatList.find((c) => c.id === id);
      const disk = chatId ? await window.electronAPI.loadChat(chatId) : null;
      const nameOverride =
        disk != null
          ? disk.titleOverride ?? null
          : existing?.titleOverride == null || existing.titleOverride === ''
            ? null
            : existing.titleOverride;
      const createdAt = disk?.createdAt ?? existing?.createdAt ?? now;
      const kind = disk?.kind ?? existing?.kind ?? 'normal';
      const wizard = disk?.wizard ?? existing?.wizard ?? null;
      const wizardId = disk?.wizardId ?? existing?.wizardId ?? null;
      const chat: SavedChat = {
        id,
        kind,
        title: kind === 'wizard-session' ? sessionTitle(msgs, nameOverride ?? undefined) : resolveChatTitle(msgs, nameOverride),
        titleOverride: nameOverride == null || nameOverride === '' ? null : nameOverride.trim() || null,
        messages: msgs,
        timeline: tl,
        createdAt,
        updatedAt: now,
        pinned: disk?.pinned ?? existing?.pinned ?? false,
        modelOverride: disk?.modelOverride ?? existing?.modelOverride ?? (chatId ? null : (newChatModelOverrideRef.current ?? null)),
        wizard,
        wizardId
      };
      await window.electronAPI.saveChat(chat);
      lastContentFingerprintRef.current = fp;
      if (!chatId) setActiveChatId(id);
      await refreshChatList();
      return id;
    },
    [chatList, refreshChatList]
  );

  const debouncedSave = useCallback(
    (msgs: ChatMessage[], tl: ChatTimelineEntry[], chatId?: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void persistCurrentChat(msgs, tl, chatId);
      }, 1500);
    },
    [persistCurrentChat]
  );

  const appliedCustomTokensRef = useRef(new Set<string>());

  useEffect(() => {
    const boot = async () => {
      const loaded = await window.electronAPI.loadSettings();
      setSettings(loaded);
      await refreshChatList();
    };
    void boot();
  }, []);

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    appliedCustomTokensRef.current.forEach((k) => root.style.removeProperty(k));
    appliedCustomTokensRef.current.clear();
    root.dataset.theme = settings.ui.themeId;

    if (settings.ui.themeId === 'custom' && settings.ui.customThemeTokens) {
      for (const [key, val] of Object.entries(settings.ui.customThemeTokens)) {
        if (!isAllowedCustomThemeTokenKey(key)) continue;
        root.style.setProperty(key, val);
        appliedCustomTokensRef.current.add(key);
      }
    }

    if (settings.ui.themeId === 'custom') {
      const bgToken = settings.ui.customThemeTokens?.['--bg-0'];
      const customLight =
        bgToken == null || String(bgToken).trim() === '' ? true : isLikelyLightCssBackground(String(bgToken));
      if (customLight) {
        root.dataset.customLight = 'true';
      } else {
        delete root.dataset.customLight;
      }
      root.style.colorScheme = customLight ? 'light' : 'dark';
    } else {
      delete root.dataset.customLight;
      root.style.removeProperty('color-scheme');
    }
  }, [settings]);

  const openRouterKeyForEffect = settings?.selectedProvider === 'openrouter' ? settings.providers.openrouter.apiKey : null;

  useEffect(() => {
    if (!settings) return;
    void refreshModels(settings);
  }, [settings?.selectedProvider, openRouterKeyForEffect]);

  useEffect(() => {
    if (!settings) return;
    if (activeChatId) {
      setOverrideModelProvider(activeChatMeta?.modelOverride?.provider ?? settings.selectedProvider);
    } else {
      setOverrideModelProvider(newChatModelOverride?.provider ?? settings.selectedProvider);
    }
  }, [activeChatId, activeChatMeta?.modelOverride?.provider, newChatModelOverride?.provider, settings]);

  useEffect(() => {
    if (!settings) {
      setOverrideModels([]);
      return;
    }
    let cancelled = false;
    void window.electronAPI.listModels(settings, overrideModelProvider).then((list) => {
      if (!cancelled) setOverrideModels(list);
    });
    return () => {
      cancelled = true;
    };
  }, [settings, overrideModelProvider]);

  useEffect(() => {
    const offChunk = window.electronAPI.onCommandChunk((payload) => {
      if (payload.jobId && payload.jobId === inlineTerminalJobIdRef.current) {
        setInlineTerminalLogs((c) => c + payload.chunk);
      }
    });
    const offDone = window.electronAPI.onCommandDone((payload) => {
      if (payload.jobId && payload.jobId === inlineTerminalJobIdRef.current) {
        setInlineTerminalJobId(undefined);
        inlineTerminalJobIdRef.current = undefined;
        setInlineTerminalLogs((c) => c + `\n[process exited ${payload.code ?? 'signal'}]\n`);
      }
    });
    const offDelta = window.electronAPI.onChatDelta(({ requestId, delta, reasoningDelta }) => {
      updateInFlightMessage(requestId, (m) => ({
        ...m,
        content: delta ? `${m.content}${delta}` : m.content,
        reasoning: reasoningDelta ? `${m.reasoning ?? ''}${reasoningDelta}` : m.reasoning,
        status: 'streaming' as const
      }));
    });
    const offDoneChat = window.electronAPI.onChatDone(({ requestId, content, reasoning, usage }) => {
      const snapshot = updateInFlightMessage(requestId, (m) => {
        const next: ChatMessage = { ...m, content, status: 'done' as const };
        if (reasoning !== undefined) next.reasoning = reasoning;
        else if (m.reasoning !== undefined) next.reasoning = m.reasoning;
        return next;
      });
      if (snapshot) {
        if (usage && activeChatIdRef.current === snapshot.chatId) {
          setLastTokenUsage(usage);
        }
        if (activeChatIdRef.current === snapshot.chatId) {
          setChatStreaming(false);
          setActiveRequestId(undefined);
        }
        void saveChatSnapshot(snapshot.chatId, snapshot.messages, snapshot.timeline).finally(() => {
          if (inFlightChatsRef.current.get(requestId) === snapshot) {
            inFlightChatsRef.current.delete(requestId);
          }
        });
        return;
      }
      setChatStreaming(false);
      setActiveRequestId(undefined);
    });
    const offError = window.electronAPI.onChatError(({ requestId, error }) => {
      const snapshot = updateInFlightMessage(requestId, (m) => ({
        ...m,
        content: error,
        status: 'error',
        role: 'assistant'
      }));
      appendActivity({
        id: uid(),
        requestId,
        kind: error === 'Request stopped.' ? 'stopped' : 'error',
        message: error === 'Request stopped.' ? 'Model stopped.' : `Model error: ${error}`
      });
      if (snapshot) {
        if (activeChatIdRef.current === snapshot.chatId) {
          setChatStreaming(false);
          setActiveRequestId(undefined);
        }
        void saveChatSnapshot(snapshot.chatId, snapshot.messages, snapshot.timeline).finally(() => {
          if (inFlightChatsRef.current.get(requestId) === snapshot) {
            inFlightChatsRef.current.delete(requestId);
          }
        });
        return;
      }
      setChatStreaming(false);
      setActiveRequestId(undefined);
    });
    const offActivity = window.electronAPI.onChatActivity((payload) => {
      appendActivity(payload);
    });
    const offSettingsUpdated = window.electronAPI.onSettingsUpdated((next) => {
      setSettings(next);
    });
    const offChatsUpdated = window.electronAPI.onChatsUpdated(() => {
      void refreshChatList();
    });
    const offWizardPromptApproval = window.electronAPI.onWizardPromptApprovalRequest((payload) => {
      setWizardPromptApproval(payload);
    });
    const offToolApproval = window.electronAPI.onToolApprovalRequest((payload) => {
      setToolApprovalRequest(payload);
    });
    const offWorkspaceChanged = window.electronAPI.onWorkspaceChanged(
      async ({ root, fileWritten, fileDeleted }) => {
        const latestTree = await window.electronAPI.getWorkspaceTree(root);
        setWorkspaceTree(latestTree);
        void refreshWorkspaceChanges(root);

        const wDraft = wizardDraftRef.current;
        if (wDraft && pathsEqual(wDraft.workspaceRoot, root)) {
          try {
            const docs = await window.electronAPI.listWizardDocuments(root);
            const wid = activeWizardMeta?.id;
            const cur = wizardDraftRef.current;
            if (wid && cur && pathsEqual(cur.workspaceRoot, root)) {
              const full = await window.electronAPI.loadChat(wid);
              if (full?.kind === 'wizard' && full.wizard) {
                const merged: WizardProfile = { ...full.wizard, documents: docs };
                setWizardDraft(merged);
                wizardDraftRef.current = merged;
                await window.electronAPI.saveChat({ ...full, wizard: merged, updatedAt: Date.now() });
              }
            }
          } catch {
            /* ignore */
          }
        }

        if (!fileWritten && activeFilePathRef.current) {
          const activeKey = activeFilePathRef.current;
          const buf = buffersRef.current[activeKey];
          if (!buf?.dirty) {
            try {
              const reloaded = await window.electronAPI.openFile(root, activeKey);
              setBuffers((current) => ({
                ...current,
                [activeKey]: { ...reloaded, dirty: false }
              }));
            } catch {
              // active file may have been removed or become unreadable
            }
          }
        }

        if (fileDeleted) {
          setBuffers((c) => {
            const key = Object.keys(c).find((k) => k === fileDeleted || c[k].path === fileDeleted);
            if (key == null) return c;
            const { [key]: _removed, ...rest } = c;
            setActiveFilePath((a) => (a != null && (a === key || a === fileDeleted) ? undefined : a));
            return rest;
          });
        }

        if (fileWritten) {
          try {
            const reloaded = await window.electronAPI.openFile(root, fileWritten);
            setBuffers((current) => {
              const key = Object.keys(current).find(
                (k) => k === fileWritten || k === reloaded.path || current[k].path === reloaded.path
              );
              if (key == null) return current;
              return { ...current, [key]: { ...reloaded, dirty: false } };
            });
          } catch {
            // File may be missing or not UTF-8; tree is already up to date
          }
        }
      }
    );
    return () => {
      offChunk();
      offDone();
      offDelta();
      offDoneChat();
      offError();
      offActivity();
      offSettingsUpdated();
      offChatsUpdated();
      offWizardPromptApproval();
      offToolApproval();
      offWorkspaceChanged();
    };
  }, [activeWizardMeta?.id, refreshChatList, refreshWorkspaceChanges]);

  useEffect(() => {
    if (chatMessages.length > 0 && !chatStreaming) {
      debouncedSave(chatMessages, chatTimeline, activeChatId);
    }
  }, [activeChatId, chatMessages, chatStreaming, chatTimeline, debouncedSave]);

  const chooseWorkspace = async () => {
    const result = await window.electronAPI.chooseWorkspace();
    if (!result) return;
    setWorkspaceRoot(result.root);
    setWorkspaceTree(result.tree);
    setInlineTerminalLogs((c) => c + `\n[workspace attached: ${result.root}]\n`);
    void refreshWorkspaceChanges(result.root);
  };

  const openLastWorkspace = async () => {
    const result = await window.electronAPI.openLastWorkspace();
    if (!result) {
      setSettingsStatus('Last workspace folder is missing or was moved. Use Open workspace to pick a folder.');
      return;
    }
    setWorkspaceRoot(result.root);
    setWorkspaceTree(result.tree);
    setInlineTerminalLogs((c) => c + `\n[workspace attached: ${result.root}]\n`);
    void refreshWorkspaceChanges(result.root);
    setSettingsStatus('');
  };

  const clearWorkspace = () => {
    if (!workspaceRoot) return;
    if (activeWizard) {
      setSettingsStatus('Wizard workspaces stay attached while their Wizard is selected.');
      return;
    }
    void window.electronAPI.detachWorkspace().finally(() => {
      setWorkspaceRoot(undefined);
      setWorkspaceTree([]);
      setWorkspaceChanges(null);
      setBuffers({});
      setActiveFilePath(undefined);
      setInlineTerminalLogs((c) => c + '\n[workspace cleared]\n');
    });
  };

  const activateWorkspace = async (root: string) => {
    const result = await window.electronAPI.activateWorkspace(root);
    setWorkspaceRoot(result.root);
    setWorkspaceTree(result.tree);
    setWorkspaceChanges(null);
    setBuffers({});
    setActiveFilePath(undefined);
    void refreshWorkspaceChanges(result.root);
    return result;
  };

  const isWizardOwnedWorkspaceRoot = useCallback(
    (root: string) =>
      wizardChatList.some(
        (w) => w.kind === 'wizard' && w.wizard?.workspaceRoot && pathsEqual(w.wizard.workspaceRoot, root)
      ),
    [wizardChatList]
  );

  /** When leaving Wizard context, detach the Wizard folder rather than treating it as the normal sidebar workspace. Does not auto-open the last non-wizard workspace — the user does that with Open workspace. */
  const switchAwayFromWizardMountedWorkspace = useCallback(async () => {
    const root = workspaceRootRef.current;
    if (!root || !isWizardOwnedWorkspaceRoot(root)) return;

    await window.electronAPI.detachWorkspace();
    setWorkspaceRoot(undefined);
    setWorkspaceTree([]);
    setWorkspaceChanges(null);
    setBuffers({});
    setActiveFilePath(undefined);
  }, [isWizardOwnedWorkspaceRoot]);

  const openFile = async (target: string) => {
    if (!workspaceRoot) return;
    if (buffers[target]) {
      setActiveFilePath(target);
      return;
    }
    const file = await window.electronAPI.openFile(workspaceRoot, target);
    setBuffers((current) => ({ ...current, [target]: { ...file, dirty: false } }));
    setActiveFilePath(target);
    setInspectorTab('editor');
  };

  const saveActiveFile = async () => {
    if (!workspaceRoot || !activeFilePath) return;
    const activeBuffer = buffers[activeFilePath];
    if (!activeBuffer || activeBuffer.imagePreview) return;
    const saved = await window.electronAPI.saveFile(workspaceRoot, activeFilePath, activeBuffer.content);
    setBuffers((current) => ({ ...current, [activeFilePath]: { ...saved, dirty: false } }));
    void refreshWorkspaceChanges(workspaceRoot);
  };

  const refreshModels = async (settingsOverride?: AppSettings) => {
    const activeSettings = settingsOverride ?? settings;
    if (!activeSettings) return;

    setModelCatalogSettled(false);

    if (activeSettings.selectedProvider === 'openrouter') {
      const key = activeSettings.providers.openrouter.apiKey?.trim() ?? '';
      if (!key) {
        setModels([]);
        setSettingsStatus('OpenRouter: add an API key in Settings; the catalog loads after the key is set.');
        setModelCatalogSettled(true);
        return;
      }
    }

    try {
      setSettingsStatus('Loading model catalog...');
      const modelList = await window.electronAPI.listModels(activeSettings, activeSettings.selectedProvider);
      setModels(modelList);
      const defaultModel = pickDefaultModel(modelList, activeSettings.providers[activeSettings.selectedProvider].model);
      const normalizedBaseUrl = normalizeProviderBaseUrl(
        activeSettings.selectedProvider,
        activeSettings.providers[activeSettings.selectedProvider].baseUrl
      );
      if (defaultModel && defaultModel !== activeSettings.providers[activeSettings.selectedProvider].model) {
        setSettings((c) =>
          c
            ? {
                ...c,
                providers: {
                  ...c.providers,
                  [activeSettings.selectedProvider]: {
                    ...c.providers[activeSettings.selectedProvider],
                    model: defaultModel,
                    baseUrl: normalizedBaseUrl
                  }
                }
              }
            : c
        );
      } else if (normalizedBaseUrl !== activeSettings.providers[activeSettings.selectedProvider].baseUrl) {
        setSettings((c) =>
          c
            ? {
                ...c,
                providers: {
                  ...c.providers,
                  [activeSettings.selectedProvider]: {
                    ...c.providers[activeSettings.selectedProvider],
                    baseUrl: normalizedBaseUrl
                  }
                }
              }
            : c
        );
      }
      if (modelList.length > 0) {
        setSettingsStatus(`Connected. ${modelList.length} models available. Active: ${defaultModel || 'none'}.`);
      } else {
        setSettingsStatus(
          activeSettings.selectedProvider === 'lmstudio'
            ? 'Connected, but no models returned. Load a model in LM Studio first.'
            : 'Connected, but OpenRouter returned no models for this profile.'
        );
      }
    } catch (error) {
      setModels([]);
      const message = error instanceof Error ? error.message : 'Failed to load models.';
      setSettingsStatus(`Connection failed: ${message}`);
    } finally {
      setModelCatalogSettled(true);
    }
  };

  const persistSettingsToDisk = async (next: AppSettings) => {
    const saved = await window.electronAPI.saveSettings(next);
    setSettings(saved);
  };

  const SETTINGS_AUTOSAVE_MS = 450;
  const WIZARD_AUTOSAVE_MS = 450;

  const flushSettingsAutosaveTimer = () => {
    if (settingsAutosaveTimerRef.current) {
      clearTimeout(settingsAutosaveTimerRef.current);
      settingsAutosaveTimerRef.current = null;
    }
  };

  const flushWizardAutosaveTimer = () => {
    if (wizardAutosaveTimerRef.current) {
      clearTimeout(wizardAutosaveTimerRef.current);
      wizardAutosaveTimerRef.current = null;
    }
  };

  const handleSettingsPanelChange = useCallback((next: AppSettings) => {
    settingsRef.current = next;
    setSettings(next);
    flushSettingsAutosaveTimer();
    settingsAutosaveTimerRef.current = setTimeout(() => {
      settingsAutosaveTimerRef.current = null;
      void (async () => {
        try {
          const latest = settingsRef.current;
          if (!latest) return;
          const saved = await window.electronAPI.saveSettings(latest);
          setSettings(saved);
          settingsRef.current = saved;
          setSettingsStatus('Saved.');
        } catch (e) {
          const m = e instanceof Error ? e.message : 'Save failed';
          setSettingsStatus(`Could not save settings: ${m}`);
        }
      })();
    }, SETTINGS_AUTOSAVE_MS);
  }, []);

  const handleWebSearchChange = useCallback(async (next: boolean) => {
    flushSettingsAutosaveTimer();
    const s = settingsRef.current;
    if (!s) return;
    const updated: AppSettings = { ...s, ui: { ...s.ui, webSearch: next } };
    settingsRef.current = updated;
    setSettings(updated);
    try {
      const saved = await window.electronAPI.saveSettings(updated);
      setSettings(saved);
      settingsRef.current = saved;
      if (next && needsSearchApiKeyNotice(saved)) {
        setShowWebSearchNotice(true);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed';
      setSettingsStatus(`Web search setting not saved: ${m}`);
    }
  }, []);

  const persistWizardProjectsParentFolder = useCallback(async (folder: string) => {
    flushSettingsAutosaveTimer();
    const s = settingsRef.current;
    if (!s) return;
    const updated: AppSettings = {
      ...s,
      ui: { ...s.ui, wizardProjectsParentFolder: folder }
    };
    settingsRef.current = updated;
    setSettings(updated);
    try {
      const saved = await window.electronAPI.saveSettings(updated);
      setSettings(saved);
      settingsRef.current = saved;
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed';
      setSettingsStatus(`Could not save Wizards folder: ${m}`);
      throw e;
    }
  }, []);

  const jumpToSearchSettings = useCallback(() => {
    setShowWebSearchNotice(false);
    setInspectorTab('settings');
    setSearchSettingsFocusKey((key) => key + 1);
  }, []);

  const handleSessionModeToggle = useCallback(async () => {
    flushSettingsAutosaveTimer();
    const s = settingsRef.current;
    if (!s) return;
    const nextMode: SessionMode = s.ui.sessionMode === 'talk' ? 'agent' : 'talk';
    const updated: AppSettings = { ...s, ui: { ...s.ui, sessionMode: nextMode } };
    settingsRef.current = updated;
    setSettings(updated);
    try {
      const saved = await window.electronAPI.saveSettings(updated);
      setSettings(saved);
      settingsRef.current = saved;
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed';
      setSettingsStatus(`Session mode not saved: ${m}`);
    }
  }, []);

  const persistAfterPresetAction = async (next: AppSettings) => {
    flushSettingsAutosaveTimer();
    try {
      await persistSettingsToDisk(next);
      setSettingsStatus('Saved.');
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed';
      setSettingsStatus(`Could not save settings to disk: ${m}`);
    }
  };

  const addChatAttachments = async (files: FileList | null) => {
    if (!files?.length) return;
    const nextAttachments = await Promise.all(
      Array.from(files).map(
        (file) =>
          new Promise<ChatAttachment>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({ id: uid(), name: file.name, mimeType: file.type || 'image/*', dataUrl: String(reader.result) });
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          })
      )
    );
    setChatAttachments((c) => [...c, ...nextAttachments]);
  };

  const startNewChat = async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSidebarFocusedWizardId(undefined);
    await switchAwayFromWizardMountedWorkspace();
    lastContentFingerprintRef.current = null;
    setChatMessages([]);
    setChatTimeline([]);
    setChatInput('');
    setChatAttachments([]);
    setLastTokenUsage(null);
    setChatStreaming(false);
    setActiveRequestId(undefined);
    setActiveChatId(undefined);
    activeChatIdRef.current = undefined;
    setNewChatModelOverride(null);
    const nextSid = uid();
    setChatSessionId(nextSid);
    chatSessionIdRef.current = nextSid;
    setSidebarTab('chats');
    setShowNewMenu(false);
  };

  const handleChatsTabClick = () => {
    setSidebarTab('chats');
    const meta = activeChatId ? chatList.find((c) => c.id === activeChatId) : undefined;
    const comingFromWizardContext = Boolean(
      sidebarFocusedWizardId || meta?.kind === 'wizard' || meta?.kind === 'wizard-session'
    );
    if (comingFromWizardContext) void startNewChat();
  };

  const loadChat = async (id: string, opts?: { expandWizardInSidebar?: boolean }) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const chat = await window.electronAPI.loadChat(id);
    if (!chat) return;

    /** Opening any saved conversation clears “wizard selected, no chat” sidebar focus. */
    setSidebarFocusedWizardId(undefined);
    const parentWizard =
      chat.kind === 'wizard-session' && chat.wizardId
        ? await window.electronAPI.loadChat(chat.wizardId)
        : chat.kind === 'wizard'
          ? chat
          : null;
    if (parentWizard?.kind === 'wizard' && parentWizard.wizard?.workspaceRoot) {
      try {
        await activateWorkspace(parentWizard.wizard.workspaceRoot);
      } catch (e) {
        setSettingsStatus(e instanceof Error ? e.message : 'Wizard workspace could not be opened.');
      }
      setSidebarTab('wizards');
      const expandInSidebar =
        opts?.expandWizardInSidebar ??
        chat.kind !== 'wizard' /* wizard-session (and similar) expands parent row in sidebar */;
      if (expandInSidebar) {
        setExpandedWizardIds((current) => new Set(current).add(parentWizard.id));
      }
    } else {
      setSidebarTab('chats');
      await switchAwayFromWizardMountedWorkspace();
    }
    const inFlight = findInFlightByChatId(id);
    const messages = inFlight?.messages ?? chat.messages;
    const timeline = inFlight?.timeline ?? chat.timeline;
    lastContentFingerprintRef.current = chatFingerprint(messages, timeline);
    setChatMessages(messages);
    setChatTimeline(timeline);
    setActiveChatId(chat.id);
    activeChatIdRef.current = chat.id;
    setChatSessionId(chat.id);
    chatSessionIdRef.current = chat.id;
    setNewChatModelOverride(null);
    setChatInput('');
    setChatAttachments([]);
    setLastTokenUsage(null);
    setChatStreaming(Boolean(inFlight));
    setActiveRequestId(inFlight?.requestId);
  };

  const handleWizardSidebarRowActivate = async (chat: SavedChatMeta) => {
    if (editingTitleId === chat.id || !chat.wizard?.workspaceRoot) return;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const active = activeChatId ? chatList.find((c) => c.id === activeChatId) : undefined;
    const sessionOpenForThisWizard = active?.kind === 'wizard-session' && active.wizardId === chat.id;
    const toggleOnlySidebar =
      (!activeChatId && sidebarFocusedWizardId === chat.id) || sessionOpenForThisWizard;

    if (toggleOnlySidebar) {
      setExpandedWizardIds((current) => {
        const next = new Set(current);
        if (next.has(chat.id)) next.delete(chat.id);
        else next.add(chat.id);
        return next;
      });
      return;
    }

    setExpandedWizardIds((current) => {
      const next = new Set(current);
      if (next.has(chat.id)) next.delete(chat.id);
      else next.add(chat.id);
      return next;
    });

    setSidebarFocusedWizardId(chat.id);
    setInspectorTab('settings');
    setSettingsInspectorScope('wizard');

    lastContentFingerprintRef.current = null;
    setChatMessages([]);
    setChatTimeline([]);
    setChatInput('');
    setChatAttachments([]);
    setLastTokenUsage(null);
    setChatStreaming(false);
    setActiveRequestId(undefined);
    setActiveChatId(undefined);
    activeChatIdRef.current = undefined;
    const nextSid = uid();
    setChatSessionId(nextSid);
    chatSessionIdRef.current = nextSid;

    try {
      await activateWorkspace(chat.wizard.workspaceRoot);
    } catch (e) {
      setSettingsStatus(e instanceof Error ? e.message : 'Wizard workspace could not be opened.');
    }
    setSidebarTab('wizards');

    try {
      const full = await window.electronAPI.loadChat(chat.id);
      if (full?.kind === 'wizard' && full.wizard) {
        setWizardDraft(full.wizard);
        wizardDraftRef.current = full.wizard;
      }
    } catch {
      /* ignore */
    }
  };

  const deleteChat = async (id: string) => {
    const inFlight = findInFlightByChatId(id);
    if (inFlight) {
      await window.electronAPI.stopChat(inFlight.requestId);
      inFlightChatsRef.current.delete(inFlight.requestId);
    }
    await window.electronAPI.deleteChat(id);
    if (activeChatId === id) await startNewChat();
    if (editingTitleId === id) {
      setEditingTitleId(null);
      setEditingTitleDraft('');
    }
    await refreshChatList();
  };

  const requestDeleteChat = (chat: SavedChatMeta) => {
    if (chat.kind === 'wizard') {
      setWizardDeleteTarget(chat);
      return;
    }
    if (chat.kind === 'wizard-session') {
      setWizardSessionDeleteTarget(chat);
      return;
    }
    void deleteChat(chat.id);
  };

  const clearActiveConversation = async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSidebarFocusedWizardId(undefined);
    await switchAwayFromWizardMountedWorkspace();
    lastContentFingerprintRef.current = null;
    setChatMessages([]);
    setChatTimeline([]);
    setChatInput('');
    setChatAttachments([]);
    setLastTokenUsage(null);
    setChatStreaming(false);
    setActiveRequestId(undefined);
    setActiveChatId(undefined);
    activeChatIdRef.current = undefined;
    setNewChatModelOverride(null);
    const nextSid = uid();
    setChatSessionId(nextSid);
    chatSessionIdRef.current = nextSid;
  };

  const deleteWizardSession = async (session: SavedChatMeta) => {
    const wizardId = session.wizardId;
    const inFlight = findInFlightByChatId(session.id);
    if (inFlight) {
      await window.electronAPI.stopChat(inFlight.requestId);
      inFlightChatsRef.current.delete(inFlight.requestId);
    }
    await window.electronAPI.deleteChat(session.id);
    if (activeChatId === session.id) {
      const siblings = wizardId
        ? (wizardSessionsByWizardId.get(wizardId) ?? []).filter((item) => item.id !== session.id)
        : [];
      if (siblings[0]) {
        await loadChat(siblings[0].id);
      } else {
        await clearActiveConversation();
        setSidebarTab('wizards');
        if (wizardId) setExpandedWizardIds((current) => new Set(current).add(wizardId));
      }
    }
    if (editingTitleId === session.id) {
      setEditingTitleId(null);
      setEditingTitleDraft('');
    }
    await refreshChatList();
  };

  const confirmDeleteWizard = async () => {
    const target = wizardDeleteTarget;
    if (!target) return;
    const workspaceRoot = target.wizard?.workspaceRoot;
    const wizardName = target.wizard?.name || target.title;
    const sessions = wizardSessionsByWizardId.get(target.id) ?? [];
    const priorActiveId = activeChatId;
    const idsRemoved = new Set<string>([target.id, ...sessions.map((s) => s.id)]);

    setWizardDeleteTarget(null);

    for (const cid of idsRemoved) {
      const inf = findInFlightByChatId(cid);
      if (inf) {
        await window.electronAPI.stopChat(inf.requestId);
        inFlightChatsRef.current.delete(inf.requestId);
      }
    }

    await Promise.all(sessions.map((session) => window.electronAPI.deleteChat(session.id)));
    await deleteChat(target.id);

    if (priorActiveId && idsRemoved.has(priorActiveId)) {
      await startNewChat();
    }
    if (editingTitleId && idsRemoved.has(editingTitleId)) {
      setEditingTitleId(null);
      setEditingTitleDraft('');
    }

    setSidebarTab('wizards');
    setExpandedWizardIds((current) => {
      const next = new Set(current);
      next.delete(target.id);
      return next;
    });
    if (workspaceRoot) {
      setWorkspaceDeleteTarget({ wizardName, workspaceRoot });
    }
  };

  /** Persist a new wizard-session with the bootstrap assistant message (shared with Send auto-create). */
  const createWizardSessionBootstrapOnDisk = async (
    full: SavedChat
  ): Promise<{
    sessionId: string;
    assistantMessage: ChatMessage;
    timeline: ChatTimelineEntry[];
    workspaceRoot: string;
    wizardDiskId: string;
  } | null> => {
    if (!full?.wizard || full.kind !== 'wizard') return null;
    const now = Date.now();
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: `New session started for ${full.wizard.name}. I will use the injected core docs and check soul.md, tools.md, memory.md, and corrections.md before my first substantive response.`,
      status: 'done'
    };
    const timeline: ChatTimelineEntry[] = [{ id: `message-${assistantMessage.id}`, type: 'message', message: assistantMessage }];
    const sessionId = uid();
    const session: SavedChat = {
      id: sessionId,
      kind: 'wizard-session',
      title: 'New session',
      titleOverride: null,
      messages: [assistantMessage],
      timeline,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      modelOverride: { provider: full.wizard.provider, model: full.wizard.model },
      wizardId: full.id
    };
    await window.electronAPI.saveChat(session);
    return {
      sessionId,
      assistantMessage,
      timeline,
      workspaceRoot: full.wizard.workspaceRoot,
      wizardDiskId: full.id
    };
  };

  const createWizardSession = async (wizardMeta: SavedChatMeta) => {
    const full = await window.electronAPI.loadChat(wizardMeta.id);
    if (!full || full.kind !== 'wizard' || !full.wizard) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const bootstrap = await createWizardSessionBootstrapOnDisk(full);
    if (!bootstrap) return;
    const { assistantMessage, timeline, sessionId } = bootstrap;
    lastContentFingerprintRef.current = chatFingerprint([assistantMessage], timeline);
    setChatMessages([assistantMessage]);
    setChatTimeline(timeline);
    setChatInput('');
    setChatAttachments([]);
    setLastTokenUsage(null);
    setChatStreaming(false);
    setActiveRequestId(undefined);
    setActiveChatId(sessionId);
    activeChatIdRef.current = sessionId;
    setChatSessionId(sessionId);
    chatSessionIdRef.current = sessionId;
    setExpandedWizardIds((current) => new Set(current).add(full.id));
    setSidebarTab('wizards');
    await refreshChatList();
    await activateWorkspace(bootstrap.workspaceRoot);
    setSidebarFocusedWizardId(undefined);
  };

  const beginRenameChat = (e: MouseEvent, id: string, currentTitle: string) => {
    e.stopPropagation();
    skipNextRenameCommitRef.current = false;
    setEditingTitleId(id);
    setEditingTitleDraft(currentTitle);
  };

  const cancelRenameChat = () => {
    setEditingTitleId(null);
    setEditingTitleDraft('');
  };

  const saveChatModelOverride = useCallback(
    async (override: ChatModelOverride | null) => {
      if (!activeChatId) {
        setNewChatModelOverride(override);
        return;
      }
      const full = await window.electronAPI.loadChat(activeChatId);
      if (!full) return;
      await window.electronAPI.saveChat({ ...full, modelOverride: override, updatedAt: full.updatedAt });
      await refreshChatList();
    },
    [activeChatId, refreshChatList]
  );

  const listModelsForWizardSetup = useCallback(
    async (provider: ProviderKind) => {
      const s = settingsRef.current;
      if (!s) return [];
      return window.electronAPI.listModels(s, provider);
    },
    []
  );

  const saveActiveWizard = useCallback(
    async (wizard: WizardProfile) => {
      const wizardId = activeWizardMeta?.id;
      if (!wizardId) return;
      const full = await window.electronAPI.loadChat(wizardId);
      if (!full || full.kind !== 'wizard' || !full.wizard) return;
      const previousDiskRoot = full.wizard.workspaceRoot;
      const profileInput: WizardProfile = { ...wizard, workspaceRoot: full.wizard.workspaceRoot };
      let profile: WizardProfile;
      try {
        profile = await window.electronAPI.syncWizardWorkspaceFolder(profileInput);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSettingsStatus(msg);
        return;
      }
      if (
        workspaceRootRef.current &&
        pathsEqual(workspaceRootRef.current, previousDiskRoot) &&
        profile.workspaceRoot !== previousDiskRoot
      ) {
        const mapPath = workspaceAbsolutePathPrefixRemap(previousDiskRoot, profile.workspaceRoot);
        setWorkspaceRoot(profile.workspaceRoot);
        setBuffers((current) => {
          const next: Record<string, FileBuffer> = {};
          for (const [key, buf] of Object.entries(current)) {
            const mappedKey = mapPath(key);
            next[mappedKey] = { ...buf, path: mapPath(buf.path) };
          }
          return next;
        });
        setActiveFilePath((active) => (active ? mapPath(active) : active));
        try {
          setWorkspaceTree(await window.electronAPI.getWorkspaceTree(profile.workspaceRoot));
        } catch {
          setWorkspaceTree([]);
        }
        void refreshWorkspaceChanges(profile.workspaceRoot);
      }
      await window.electronAPI.saveChat({
        ...full,
        title: profile.name,
        titleOverride: profile.name,
        updatedAt: Date.now(),
        modelOverride: { provider: profile.provider, model: profile.model },
        wizard: profile
      });
      await refreshChatList();
      setWizardDraft(profile);
    },
    [activeWizardMeta?.id, refreshChatList, refreshWorkspaceChanges]
  );

  const handleWizardDraftChange = useCallback(
    (next: WizardProfile) => {
      setWizardDraft(next);
      wizardDraftRef.current = next;
      flushWizardAutosaveTimer();
      wizardAutosaveTimerRef.current = setTimeout(() => {
        wizardAutosaveTimerRef.current = null;
        const draft = wizardDraftRef.current;
        if (draft) void saveActiveWizard(draft);
      }, WIZARD_AUTOSAVE_MS);
    },
    [saveActiveWizard]
  );

  useEffect(() => {
    const prev = lastInspectorTabRef.current;
    lastInspectorTabRef.current = inspectorTab;
    if (prev !== 'settings' || inspectorTab === 'settings') return;
    flushSettingsAutosaveTimer();
    void (async () => {
      try {
        const s = settingsRef.current;
        if (s) await persistSettingsToDisk(s);
      } catch {
        /* best-effort flush when leaving Settings inspector */
      }
    })();
    flushWizardAutosaveTimer();
    const w = wizardDraftRef.current;
    if (w && activeWizardMeta?.id) void saveActiveWizard(w);
  }, [inspectorTab, activeWizardMeta?.id, saveActiveWizard]);

  const refreshWizardModels = useCallback(async (provider: ProviderKind) => listModelsForWizardSetup(provider), [listModelsForWizardSetup]);

  const createWizard = useCallback(
    async (request: WizardSetupRequest) => {
      const result = await window.electronAPI.setupWizard(request);
      setWorkspaceRoot(result.profile.workspaceRoot);
      setWorkspaceTree(result.tree);
      setWorkspaceChanges(null);
      setBuffers({});
      setActiveFilePath(undefined);
      const now = Date.now();
      const id = uid();
      const chat: SavedChat = {
        id,
        kind: 'wizard',
        title: result.profile.name,
        titleOverride: result.profile.name,
        messages: [],
        timeline: [],
        createdAt: now,
        updatedAt: now,
        pinned: false,
        modelOverride: { provider: result.profile.provider, model: result.profile.model },
        wizard: result.profile
      };
      await window.electronAPI.saveChat(chat);
      await refreshChatList();
      setShowWizardSetup(false);
      await createWizardSession({
        id,
        kind: 'wizard',
        title: result.profile.name,
        titleOverride: result.profile.name,
        createdAt: now,
        updatedAt: now,
        pinned: false,
        modelOverride: { provider: result.profile.provider, model: result.profile.model },
        wizard: result.profile
      });
      void refreshWorkspaceChanges(result.profile.workspaceRoot);
    },
    [refreshChatList, refreshWorkspaceChanges]
  );

  const togglePinChat = useCallback(
    async (e: MouseEvent, id: string) => {
      e.stopPropagation();
      const full = await window.electronAPI.loadChat(id);
      if (!full) return;
      await window.electronAPI.saveChat({ ...full, pinned: !full.pinned, updatedAt: Date.now() });
      await refreshChatList();
    },
    [refreshChatList]
  );

  const commitRenameChat = async (id: string, draft: string) => {
    if (skipNextRenameCommitRef.current) {
      skipNextRenameCommitRef.current = false;
      return;
    }
    if (editingTitleId !== id) return;
    setEditingTitleId(null);
    setEditingTitleDraft('');
    const full = await window.electronAPI.loadChat(id);
    if (!full) return;
    const trimmed = draft.trim();
    const nextOverride = trimmed.length > 0 ? trimmed : null;

    let wizardPatch = full.kind === 'wizard' && full.wizard ? { ...full.wizard, name: nextOverride ?? full.wizard.name } : full.wizard;
    const prevWizardRoot = full.kind === 'wizard' ? full.wizard?.workspaceRoot : undefined;
    if (full.kind === 'wizard' && wizardPatch) {
      try {
        wizardPatch = await window.electronAPI.syncWizardWorkspaceFolder({
          ...wizardPatch,
          workspaceRoot: full.wizard!.workspaceRoot
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSettingsStatus(msg);
        return;
      }
    }

    if (
      prevWizardRoot &&
      wizardPatch &&
      workspaceRootRef.current &&
      pathsEqual(workspaceRootRef.current, prevWizardRoot) &&
      wizardPatch.workspaceRoot !== prevWizardRoot
    ) {
      const mapPath = workspaceAbsolutePathPrefixRemap(prevWizardRoot, wizardPatch.workspaceRoot);
      setWorkspaceRoot(wizardPatch.workspaceRoot);
      setBuffers((current) => {
        const next: Record<string, FileBuffer> = {};
        for (const [key, buf] of Object.entries(current)) {
          const mappedKey = mapPath(key);
          next[mappedKey] = { ...buf, path: mapPath(buf.path) };
        }
        return next;
      });
      setActiveFilePath((active) => (active ? mapPath(active) : active));
      try {
        setWorkspaceTree(await window.electronAPI.getWorkspaceTree(wizardPatch.workspaceRoot));
      } catch {
        setWorkspaceTree([]);
      }
      void refreshWorkspaceChanges(wizardPatch.workspaceRoot);
    }

    await window.electronAPI.saveChat({
      ...full,
      title: nextOverride != null ? nextOverride : full.kind === 'wizard-session' ? sessionTitle(full.messages) : chatTitle(full.messages),
      titleOverride: nextOverride,
      wizard: full.kind === 'wizard' ? wizardPatch : full.wizard,
      updatedAt: Date.now()
    });
    await refreshChatList();
  };

  const sendChat = async () => {
    const sendSettings = settingsRef.current;
    const trimmedInput = chatInput.trim();
    const attachmentsSnapshot = [...chatAttachments];
    if (
      chatStreamingRef.current ||
      !sendSettings ||
      (trimmedInput.length === 0 && attachmentsSnapshot.length === 0)
    ) {
      return;
    }

    let messagesForHistory = chatMessages;
    let timelineForHistory = chatTimeline;
    let disk: SavedChat | null = activeChatId ? await window.electronAPI.loadChat(activeChatId) : null;

    if (activeWizard && activeWizardMeta?.id && (!disk || disk.kind === 'wizard')) {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const fullWizard = await window.electronAPI.loadChat(activeWizardMeta.id);
      if (
        !fullWizard ||
        fullWizard.kind !== 'wizard' ||
        !fullWizard.wizard
      ) {
        return;
      }
      const bootstrap = await createWizardSessionBootstrapOnDisk(fullWizard);
      if (!bootstrap) return;
      const {
        assistantMessage,
        timeline: bootstrapTimeline,
        sessionId,
        workspaceRoot: wsRoot,
        wizardDiskId
      } = bootstrap;
      lastContentFingerprintRef.current = chatFingerprint([assistantMessage], bootstrapTimeline);
      setActiveChatId(sessionId);
      activeChatIdRef.current = sessionId;
      setChatSessionId(sessionId);
      chatSessionIdRef.current = sessionId;
      setSidebarFocusedWizardId(undefined);
      setExpandedWizardIds((current) => new Set(current).add(wizardDiskId));
      await refreshChatList();
      try {
        await activateWorkspace(wsRoot);
      } catch (e) {
        setSettingsStatus(e instanceof Error ? e.message : 'Wizard workspace could not be opened.');
        return;
      }
      disk = await window.electronAPI.loadChat(sessionId);
      if (!disk || disk.kind !== 'wizard-session') return;
      messagesForHistory = disk.messages;
      timelineForHistory = disk.timeline;
    }

    const activeDiskChat = disk;
    if (activeWizard && (!activeDiskChat || activeDiskChat.kind !== 'wizard-session')) {
      setSettingsStatus('Wizard session could not be started.');
      return;
    }
    const parentWizardChat =
      activeDiskChat?.kind === 'wizard-session' && activeDiskChat.wizardId
        ? await window.electronAPI.loadChat(activeDiskChat.wizardId)
        : activeDiskChat?.kind === 'wizard'
          ? activeDiskChat
          : null;
    const wizardForStream =
      parentWizardChat?.kind === 'wizard'
        ? parentWizardChat.wizard ?? null
        : activeChatMeta?.kind === 'wizard'
          ? activeChatMeta.wizard ?? null
          : null;
    if (wizardForStream && (!wizardForStream.model.trim() || !wizardForStream.workspaceRoot.trim())) return;
    if (wizardForStream && workspaceRootRef.current !== wizardForStream.workspaceRoot) {
      try {
        await activateWorkspace(wizardForStream.workspaceRoot);
      } catch (e) {
        setSettingsStatus(e instanceof Error ? e.message : 'Wizard workspace could not be opened.');
        return;
      }
    }
    chatStreamingRef.current = true;
    const userMessage: ChatMessage = {
      id: uid(),
      role: 'user',
      content: trimmedInput.length > 0 ? trimmedInput : 'Please use the attached image(s) as context for this request.',
      attachments: attachmentsSnapshot,
      status: 'done'
    };
    const requestId = uid();
    const assistantStreaming: ChatMessage = {
      id: requestId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      reasoning: sendSettings.ui.sessionMode === 'talk' && !wizardForStream ? '' : undefined
    };
    const nextHistory = [...messagesForHistory, userMessage];
    const nextTimeline: ChatTimelineEntry[] = [
      ...timelineForHistory,
      { id: `message-${userMessage.id}`, type: 'message', message: userMessage },
      { id: `message-${assistantStreaming.id}`, type: 'message', message: assistantStreaming }
    ];
    setChatMessages([...nextHistory, assistantStreaming]);
    setChatTimeline(nextTimeline);
    setChatInput('');
    setChatAttachments([]);
    setChatStreaming(true);
    setActiveRequestId(requestId);

    const priorChatId = activeChatIdRef.current;
    let chatIdForStream = priorChatId;
    let overrideForStream: ChatModelOverride | null = null;
    if (!priorChatId) {
      const newId = uid();
      chatIdForStream = newId;
      const mo = newChatModelOverrideRef.current;
      overrideForStream = mo;
      setActiveChatId(newId);
      activeChatIdRef.current = newId;
      setChatSessionId(newId);
      chatSessionIdRef.current = newId;
      setNewChatModelOverride(null);
      const chat: SavedChat = {
        id: newId,
        title: chatTitle([...nextHistory, assistantStreaming]),
        titleOverride: null,
        messages: [...nextHistory, assistantStreaming],
        timeline: nextTimeline,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pinned: false,
        modelOverride: mo
      };
      await window.electronAPI.saveChat(chat);
      await refreshChatList();
    } else {
      const loaded = await window.electronAPI.loadChat(priorChatId);
      overrideForStream = loaded?.modelOverride ?? null;
    }
    if (!chatIdForStream) return;
    inFlightChatsRef.current.set(requestId, {
      chatId: chatIdForStream,
      requestId,
      messages: [...nextHistory, assistantStreaming],
      timeline: nextTimeline
    });
    const streamSettings = wizardForStream
      ? {
          ...sendSettings,
          selectedProvider: wizardForStream.provider,
          providers: {
            ...sendSettings.providers,
            [wizardForStream.provider]: {
              ...sendSettings.providers[wizardForStream.provider],
              model: wizardForStream.model,
              systemPrompt: buildWizardSystemPrompt(wizardForStream)
            }
          },
          tools: {
            ...sendSettings.tools,
            allowModelSystemPrompt: false
          },
          ui: {
            ...sendSettings.ui,
            sessionMode: 'agent' as const
          }
        }
      : applyChatModelOverride(sendSettings, overrideForStream);

    const wizardDocsContext = wizardForStream ? await buildWizardDocsContext(wizardForStream) : { message: null, loaded: [] };
    if (wizardForStream) {
      const loadedDocs = wizardDocsContext.loaded;
      const okCount = loadedDocs.filter((doc) => doc.ok).length;
      const checklist = [
        `Workspace active: ${wizardForStream.workspaceRoot}`,
        ...loadedDocs.map((doc) => `${doc.ok ? 'Loaded' : 'Missing'} ${doc.name}`),
        `Injected ${okCount}/${loadedDocs.length} core docs into this request.`
      ].join('\n');
      const activity: ChatActivity = {
        id: uid(),
        requestId,
        kind: okCount === loadedDocs.length ? 'success' : 'warning',
        message: checklist
      };
      const activityEntry: ChatTimelineEntry = { id: `activity-${activity.id}`, type: 'activity', activity };
      const timelineWithChecklist = [...nextTimeline, activityEntry];
      setChatTimeline(timelineWithChecklist);
      const snapshot = inFlightChatsRef.current.get(requestId);
      if (snapshot) {
        snapshot.timeline = timelineWithChecklist;
      }
    }
    const streamHistory = wizardDocsContext.message ? [wizardDocsContext.message, ...nextHistory] : nextHistory;

    await window.electronAPI.streamChat(requestId, streamSettings, streamHistory, {
      workspaceRoot: wizardForStream?.workspaceRoot ?? workspaceRootRef.current,
      activeFilePath: activeFilePathRef.current,
      conversationId: chatSessionIdRef.current,
      wizardId: parentWizardChat?.kind === 'wizard' ? parentWizardChat.id : undefined,
      wizardName: wizardForStream?.name,
      wizardSystemPrompt: wizardForStream?.systemPrompt,
      wizardFullAccess: wizardForStream ? Boolean(wizardForStream.fullAccess) : undefined
    });
  };

  const stopChat = async () => {
    if (!activeRequestId) return;
    await window.electronAPI.stopChat(activeRequestId);
    setChatStreaming(false);
    setActiveRequestId(undefined);
  };

  const runInlineTerminal = useCallback(async (command: string) => {
    if (!command.trim() || !workspaceRoot) return;
    setInlineTerminalLogs((c) => c + `> ${command}\n`);
    const result = await window.electronAPI.runCommand(command, workspaceRoot);
    setInlineTerminalJobId(result.jobId);
    inlineTerminalJobIdRef.current = result.jobId;
  }, [workspaceRoot]);

  const killInlineTerminal = useCallback(async () => {
    if (!inlineTerminalJobId) return;
    await window.electronAPI.killCommand(inlineTerminalJobId);
    setInlineTerminalJobId(undefined);
    inlineTerminalJobIdRef.current = undefined;
    setInlineTerminalLogs((c) => c + '\n[termination requested]\n');
  }, [inlineTerminalJobId]);

  const activeBuffer = activeFilePath ? buffers[activeFilePath] : undefined;
  const selectedProvider = settings?.providers[settings.selectedProvider];
  const isWizardActive = Boolean(activeWizard);
  const chatPanelIsWizard = Boolean(isWizardActive && !showWizardHubPlaceholder);
  /** Per-chat model override wins in the top bar and footer over the global default. */
  const effectiveHeaderModelId =
    activeWizard?.model ?? effectiveModelOverride?.model ?? selectedProvider?.model ?? '';
  const openRouterReady =
    settings && settings.selectedProvider === 'openrouter'
      ? Boolean(settings.providers.openrouter.apiKey?.trim())
      : true;
  const providerConnected = activeWizard
    ? Boolean(activeWizard.model)
    : Boolean(settings && openRouterReady && models.length > 0 && selectedProvider?.model);
  /** Catalog row for context window size (respects per-chat provider override lists). */
  const modelCatalogForLimit = effectiveModelOverride ? overrideModels : models;
  const resolvedContextLimit = (() => {
    const id = effectiveHeaderModelId.trim();
    if (!id) return 131072;
    return modelCatalogForLimit.find((m) => m.id === id)?.contextLength ?? 131072;
  })();
  const selectedProviderLabel = (activeWizard?.provider ?? settings?.selectedProvider) === 'openrouter' ? 'OpenRouter' : 'LM Studio';
  const sessionMode = activeWizard ? 'agent' : (settings?.ui.sessionMode ?? 'agent');
  const isDarwin = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
  const wizardPromptDiff = wizardPromptApproval
    ? diffPromptLines(wizardPromptApproval.before, wizardPromptApproval.after)
    : { left: [], right: [] };
  const toolApprovalDiff =
    toolApprovalRequest &&
    typeof toolApprovalRequest.diffBefore === 'string' &&
    typeof toolApprovalRequest.diffAfter === 'string'
      ? diffPromptLines(toolApprovalRequest.diffBefore, toolApprovalRequest.diffAfter)
      : null;

  return (
    <div className="app-shell">
      <div className="background-grid" />
      <AnimatePresence>
        {showWebSearchNotice ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="app-dialog-backdrop"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            role="presentation"
          >
            <motion.div
              aria-modal="true"
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="app-dialog"
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              role="dialog"
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div className="app-dialog__kicker">Web Search</div>
              <h3>Search works better with an API key</h3>
              <p>
                Mythra can search without a key, but the built-in DuckDuckGo fallback only returns short instant
                answers and often misses normal web results. For better AI search, add a Tavily or Brave Search API key
                in Settings. Tavily is the simplest recommendation for AI-ready results; Brave is a strong general web
                search option.
              </p>
              <div className="app-dialog__links">
                <a
                  className="app-dialog__link"
                  href="https://tavily.com/"
                  onClick={(e) => {
                    e.preventDefault();
                    void window.electronAPI.openExternalUrl('https://tavily.com/');
                  }}
                  rel="noreferrer"
                >
                  Tavily
                </a>
                <span aria-hidden className="app-dialog__links-sep">
                  ·
                </span>
                <a
                  className="app-dialog__link"
                  href="https://brave.com/search/api/"
                  onClick={(e) => {
                    e.preventDefault();
                    void window.electronAPI.openExternalUrl('https://brave.com/search/api/');
                  }}
                  rel="noreferrer"
                >
                  Brave Search API
                </a>
              </div>
              <div className="app-dialog__actions">
                <button className="btn btn--secondary" onClick={() => setShowWebSearchNotice(false)} type="button">
                  Not now
                </button>
                <button className="btn btn--primary" onClick={jumpToSearchSettings} type="button">
                  Add API key
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <SystemPromptModal
        open={showSystemPromptModal && Boolean(settings)}
        value={settings?.providers[settings.selectedProvider].systemPrompt ?? ''}
        onChange={(v) => {
          const s = settingsRef.current;
          if (!s) return;
          handleSettingsPanelChange(patchSystemPromptInSettings(s, v));
        }}
        onClose={() => setShowSystemPromptModal(false)}
      />
      <WizardSetupModal
        onClose={() => setShowWizardSetup(false)}
        onCreate={createWizard}
        onListModels={listModelsForWizardSetup}
        onPersistWizardProjectsParentFolder={persistWizardProjectsParentFolder}
        open={showWizardSetup}
        settings={settings}
      />
      <AppConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Delete Wizard"
        confirmVariant="danger"
        description={
          <>
            Delete <strong>{wizardDeleteTarget?.title ?? 'this Wizard'}</strong> from Mythra? This removes the Wizard
            entry and its conversation history, but does not delete its workspace folder yet.
          </>
        }
        kicker="Delete Wizard"
        onCancel={() => setWizardDeleteTarget(null)}
        onConfirm={() => void confirmDeleteWizard()}
        open={Boolean(wizardDeleteTarget)}
        title="Are you sure?"
      />
      <AppConfirmDialog
        cancelLabel="Keep folder"
        confirmLabel="Delete folder"
        confirmVariant="danger"
        description={
          <>
            Also delete <strong>{workspaceDeleteTarget?.wizardName ?? 'this Wizard'}</strong>&apos;s workspace folder and
            all files inside it?
            <br />
            <code className="app-dialog__code">{workspaceDeleteTarget?.workspaceRoot}</code>
          </>
        }
        kicker="Wizard Workspace"
        onCancel={() => setWorkspaceDeleteTarget(null)}
        onConfirm={() => {
          const target = workspaceDeleteTarget;
          setWorkspaceDeleteTarget(null);
          if (!target) return;
          void window.electronAPI.deleteWizardWorkspace(target.workspaceRoot).then(() => {
            if (workspaceRootRef.current === target.workspaceRoot) {
              setWorkspaceRoot(undefined);
              setWorkspaceTree([]);
              setWorkspaceChanges(null);
              setBuffers({});
              setActiveFilePath(undefined);
            }
          });
        }}
        open={Boolean(workspaceDeleteTarget)}
        title="Delete its workspace too?"
      />
      <AppConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Delete session"
        confirmVariant="danger"
        description={
          <>
            Delete <strong>{wizardSessionDeleteTarget?.title ?? 'this session'}</strong>? This only removes this
            conversation history. The Wizard, workspace, and core documents will stay.
          </>
        }
        kicker="Delete Session"
        onCancel={() => setWizardSessionDeleteTarget(null)}
        onConfirm={() => {
          const target = wizardSessionDeleteTarget;
          setWizardSessionDeleteTarget(null);
          if (target) void deleteWizardSession(target);
        }}
        open={Boolean(wizardSessionDeleteTarget)}
        title="Delete this Wizard session?"
      />
      <AnimatePresence>
        {wizardPromptApproval ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="app-dialog-backdrop app-dialog-backdrop--overlay-top"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            role="presentation"
          >
            <motion.div
              aria-modal="true"
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="app-dialog wizard-prompt-approval"
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              role="dialog"
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div className="wizard-prompt-approval__intro">
                <div className="app-dialog__kicker">Wizard System Prompt</div>
                <h3>{wizardPromptApproval.title}</h3>
                <p>
                  {wizardPromptApproval.wizardName} wants to replace its private system prompt. Review the change before
                  allowing it.
                </p>
              </div>
              <div className="wizard-prompt-approval__compare">
                <section>
                  <h4>Original</h4>
                  <pre>
                    {wizardPromptDiff.left.map((line, index) => (
                      <span className={`wizard-prompt-approval__line wizard-prompt-approval__line--${line.kind}`} key={`${index}-${line.kind}`}>
                        {line.text || ' '}
                      </span>
                    ))}
                  </pre>
                </section>
                <div className="wizard-prompt-approval__arrow" aria-hidden>
                  --&gt;
                </div>
                <section>
                  <h4>New</h4>
                  <pre>
                    {wizardPromptDiff.right.map((line, index) => (
                      <span className={`wizard-prompt-approval__line wizard-prompt-approval__line--${line.kind}`} key={`${index}-${line.kind}`}>
                        {line.text || ' '}
                      </span>
                    ))}
                  </pre>
                </section>
              </div>
              <div className="app-dialog__actions">
                <button
                  className="btn btn--secondary"
                  onClick={() => {
                    const id = wizardPromptApproval.id;
                    setWizardPromptApproval(null);
                    void window.electronAPI.respondWizardPromptApproval(id, false);
                  }}
                  type="button"
                >
                  Deny
                </button>
                <button
                  className="btn btn--primary"
                  onClick={() => {
                    const id = wizardPromptApproval.id;
                    setWizardPromptApproval(null);
                    void window.electronAPI.respondWizardPromptApproval(id, true);
                  }}
                  type="button"
                >
                  Approve
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {toolApprovalRequest ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="app-dialog-backdrop app-dialog-backdrop--overlay-top"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            role="presentation"
          >
            <motion.div
              aria-modal="true"
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className={`app-dialog app-dialog--scrollable ${toolApprovalDiff ? 'wizard-prompt-approval' : 'tool-approval-dialog'}`}
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              role="dialog"
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div className="app-dialog__kicker">Approval required</div>
              <h3>{toolApprovalRequest.title}</h3>
              {toolApprovalDiff ? (
                <>
                  <div className="wizard-prompt-approval__intro">
                    <p id="tool-approval-desc">{toolApprovalRequest.detail}</p>
                  </div>
                  <div aria-describedby="tool-approval-desc" className="wizard-prompt-approval__compare">
                    <section>
                      <h4>Before</h4>
                      <pre>
                        {toolApprovalDiff.left.map((line, index) => (
                          <span className={`wizard-prompt-approval__line wizard-prompt-approval__line--${line.kind}`} key={`tool-dl-${index}-${line.kind}`}>
                            {line.text || ' '}
                          </span>
                        ))}
                      </pre>
                    </section>
                    <div className="wizard-prompt-approval__arrow" aria-hidden>
                      --&gt;
                    </div>
                    <section>
                      <h4>After</h4>
                      <pre>
                        {toolApprovalDiff.right.map((line, index) => (
                          <span className={`wizard-prompt-approval__line wizard-prompt-approval__line--${line.kind}`} key={`tool-dr-${index}-${line.kind}`}>
                            {line.text || ' '}
                          </span>
                        ))}
                      </pre>
                    </section>
                  </div>
                </>
              ) : (
                <pre className="tool-approval-dialog__detail">{toolApprovalRequest.detail}</pre>
              )}
              <div className="app-dialog__actions">
                <button
                  className="btn btn--secondary"
                  onClick={() => {
                    const id = toolApprovalRequest.id;
                    setToolApprovalRequest(null);
                    void window.electronAPI.respondToolApproval(id, false);
                  }}
                  type="button"
                >
                  Deny
                </button>
                <button
                  className="btn btn--primary"
                  onClick={() => {
                    const id = toolApprovalRequest.id;
                    setToolApprovalRequest(null);
                    void window.electronAPI.respondToolApproval(id, true);
                  }}
                  type="button"
                >
                  Approve
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {showConnectionHelp ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="app-dialog-backdrop"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            role="presentation"
          >
            <motion.div
              aria-describedby="connection-help-desc"
              aria-labelledby="connection-help-title"
              aria-modal="true"
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="app-dialog app-dialog--scrollable"
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              role="dialog"
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div className="app-dialog__kicker">Connection</div>
              <h3 id="connection-help-title">Need help?</h3>
              <p id="connection-help-desc">
                Mythra sends your chats to an LLM through either <strong>OpenRouter</strong> (many cloud models, one API
                key) or <strong>LM Studio</strong> (models running on your computer). Use the guide below for the option
                you prefer.
              </p>
              <div className="app-dialog__section">
                <div className="app-dialog__section-title">OpenRouter</div>
                <p>
                  OpenRouter is a service that routes requests to a large catalog of hosted models so you do not run the
                  weights locally. In Mythra, choose <strong>OpenRouter</strong> under Provider, paste an API key from
                  your OpenRouter account (for example <code className="app-dialog__code">sk-or-v1-…</code>), then pick a
                  model. The default base URL points at OpenRouter’s API and usually does not need changing. Your key is
                  stored only in this app’s settings on your machine.
                </p>
              </div>
              <div className="app-dialog__section">
                <div className="app-dialog__section-title">LM Studio</div>
                <p>
                  LM Studio is a desktop app that downloads and runs models on your own hardware. Install it, load a
                  model, and start the <strong>local server</strong> (often on port <code className="app-dialog__code">1234</code>
                  ). In Mythra, choose <strong>LM Studio</strong>, confirm the base URL matches your server (the default
                  is <code className="app-dialog__code">http://127.0.0.1:1234/v1</code>), then use <strong>Test +
                  Refresh</strong> to load the model list. The server key defaults to{' '}
                  <code className="app-dialog__code">lm-studio</code> unless you changed it in LM Studio.
                </p>
              </div>
              <div className="app-dialog__links">
                <a
                  className="app-dialog__link"
                  href="https://openrouter.ai/"
                  onClick={(e) => {
                    e.preventDefault();
                    void window.electronAPI.openExternalUrl('https://openrouter.ai/');
                  }}
                  rel="noreferrer"
                >
                  OpenRouter website
                </a>
                <span aria-hidden className="app-dialog__links-sep">
                  ·
                </span>
                <a
                  className="app-dialog__link"
                  href="https://lmstudio.ai/"
                  onClick={(e) => {
                    e.preventDefault();
                    void window.electronAPI.openExternalUrl('https://lmstudio.ai/');
                  }}
                  rel="noreferrer"
                >
                  LM Studio website
                </a>
              </div>
              <div className="app-dialog__actions">
                <button className="btn btn--primary" onClick={() => setShowConnectionHelp(false)} type="button">
                  Got it
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {isDarwin ? <div aria-hidden className="app-titlebar" /> : null}
      <main className="layout layout--atomic">
        <motion.aside
          animate={{ opacity: 1, x: 0 }}
          className="sidebar"
          initial={{ opacity: 0, x: -16 }}
          transition={{ delay: 0.05, duration: 0.4 }}
        >
          <div className="sidebar-card">
            <div className="sidebar-brand">
              <div className="sidebar-brand__badge">OK</div>
              <div>
                <div className="sidebar-brand__title">
                  <MythraMark />
                </div>
                <div className="sidebar-brand__copy">Local AI workspace</div>
              </div>
            </div>

            <div className="sidebar-quick">
              <div className={`sidebar-new ${showNewMenu ? 'is-open' : ''}`}>
                <button
                  className="sidebar-quick__btn sidebar-quick__btn--primary"
                  onClick={() => setShowNewMenu((v) => !v)}
                  type="button"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  New
                </button>
                <AnimatePresence>
                  {showNewMenu ? (
                    <motion.div
                      animate={{ opacity: 1, y: 0 }}
                      className="sidebar-new__menu"
                      exit={{ opacity: 0, y: -4 }}
                      initial={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.15 }}
                    >
                      <button onClick={() => void startNewChat()} type="button">
                        <strong>Normal Chat</strong>
                        <span>Regular chat with Chat and Agent modes.</span>
                      </button>
                      <button
                        onClick={() => {
                          setShowNewMenu(false);
                          setShowWizardSetup(true);
                        }}
                        type="button"
                      >
                        <strong>Wizard</strong>
                        <span>Named AI with its own model, memory, and local workspace.</span>
                      </button>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
              <button
                className="sidebar-quick__btn"
                disabled={Boolean(activeWizard)}
                onClick={chooseWorkspace}
                title={activeWizard ? 'This Wizard uses its own private workspace.' : undefined}
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M1 4.5l5-3 5 3v6l-5 3-5-3v-6z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
                {activeWizard ? 'Wizard workspace' : workspaceRoot ? 'Switch workspace' : 'Open workspace'}
              </button>
              {workspaceRoot && activeWizard ? (
                <button
                  className="sidebar-quick__btn"
                  disabled
                  type="button"
                  title="Wizard workspaces stay attached while their Wizard is selected"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M4 4l6 6M10 4l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                  Clear workspace
                </button>
              ) : workspaceRoot ? (
                <button
                  className="sidebar-quick__btn"
                  onClick={clearWorkspace}
                  type="button"
                  title="Unmount the current folder"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M4 4l6 6M10 4l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                  Clear workspace
                </button>
              ) : settings?.lastWorkspaceRoot ? (
                <button
                  className="sidebar-quick__btn"
                  onClick={() => void openLastWorkspace()}
                  type="button"
                  title={`Reopen ${settings.lastWorkspaceRoot}`}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M8.25 11V7.25A2.75 2.75 0 005.5 4.5H3.25"
                      stroke="currentColor"
                      strokeWidth="1.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M5.5 2.25L3.25 4.5 5.5 6.75"
                      stroke="currentColor"
                      strokeWidth="1.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Open last workspace
                </button>
              ) : (
                <button
                  className="sidebar-quick__btn"
                  disabled
                  type="button"
                  title="No workspace open"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M4 4l6 6M10 4l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                  Clear workspace
                </button>
              )}
            </div>

            <div className="sidebar-tabs" role="tablist">
              <button
                className={`sidebar-tabs__tab ${sidebarTab === 'chats' ? 'is-active' : ''}`}
                onClick={handleChatsTabClick}
                type="button"
                role="tab"
              >
                Chats
              </button>
              <button
                className={`sidebar-tabs__tab ${sidebarTab === 'wizards' ? 'is-active' : ''}`}
                onClick={() => setSidebarTab('wizards')}
                type="button"
                role="tab"
              >
                Wizards
              </button>
              <button
                className={`sidebar-tabs__tab ${sidebarTab === 'files' ? 'is-active' : ''}`}
                onClick={() => setSidebarTab('files')}
                type="button"
                role="tab"
              >
                Files
              </button>
            </div>

            <div className="sidebar-content">
              <AnimatePresence mode="wait">
                {sidebarTab === 'chats' ? (
                  <motion.div
                    key="chats"
                    className="sidebar-panel"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {settings ? (
                      <div className={`chat-thread-options ${chatModelExpanded ? 'is-expanded' : ''}`}>
                        <button
                          className="chat-thread-options__header"
                          onClick={() => setChatModelExpanded((v) => !v)}
                          type="button"
                        >
                          <span className="chat-thread-options__header-left">
                            <svg
                              className="chat-thread-options__chevron"
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="none"
                              aria-hidden
                            >
                              <path d="M4 2.5L7.5 6 4 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <span className="chat-thread-options__title">Model override</span>
                          </span>
                          {effectiveModelOverride && !chatModelExpanded ? (
                            <span className="chat-thread-options__badge">
                              {pathLabel(effectiveModelOverride.model)}
                            </span>
                          ) : null}
                        </button>

                        <AnimatePresence initial={false}>
                          {chatModelExpanded && (
                            <motion.div
                              key="override-body"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                              style={{ overflow: 'hidden' }}
                            >
                              <div className="chat-thread-options__body">
                                <label
                                  className={`chat-panel__web-toggle chat-thread-options__web-toggle ${effectiveModelOverride ? 'is-on' : ''}`}
                                >
                                  <input
                                    checked={Boolean(effectiveModelOverride)}
                                    onChange={async (e) => {
                                      if (!settings) return;
                                      if (e.target.checked) {
                                        const list = await window.electronAPI.listModels(settings, overrideModelProvider);
                                        const model = pickDefaultModel(list, list[0]?.id);
                                        if (model) {
                                          await saveChatModelOverride({ provider: overrideModelProvider, model });
                                        }
                                      } else {
                                        await saveChatModelOverride(null);
                                      }
                                    }}
                                    type="checkbox"
                                  />
                                  <span className="chat-thread-options__model-toggle-text">
                                    <span>Use a specific model</span>
                                    <span>only for this chat</span>
                                  </span>
                                  <span className="chat-panel__web-toggle-track">
                                    <span className="chat-panel__web-toggle-knob" />
                                  </span>
                                </label>

                                <AnimatePresence initial={false}>
                                  {effectiveModelOverride ? (
                                    <motion.div
                                      key="override-fields"
                                      initial={{ height: 0, opacity: 0 }}
                                      animate={{ height: 'auto', opacity: 1 }}
                                      exit={{ height: 0, opacity: 0 }}
                                      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                                      style={{ overflow: 'hidden' }}
                                    >
                                      <div className="chat-thread-options__fields">
                                        <label className="chat-thread-options__field">
                                          <span className="chat-thread-options__field-label">Provider</span>
                                          <AppSelect
                                            className="app-select--compact"
                                            options={providerOptions}
                                            portalDropdown
                                            onChange={async (p) => {
                                              setOverrideModelProvider(p);
                                              if (!settings) return;
                                              const list = await window.electronAPI.listModels(settings, p);
                                              const model = pickDefaultModel(list, undefined);
                                              if (model) {
                                                await saveChatModelOverride({ provider: p, model });
                                              }
                                            }}
                                            value={overrideModelProvider}
                                          />
                                        </label>
                                        <div className="chat-thread-options__field">
                                          <span className="chat-thread-options__field-label">Model</span>
                                          <ModelSearch
                                            models={overrideModels}
                                            value={effectiveModelOverride.model}
                                            favoriteIds={settings.ui.favoriteModels?.[overrideModelProvider] ?? []}
                                            portalDropdown
                                            onChange={async (model) => {
                                              if (model) {
                                                await saveChatModelOverride({ provider: overrideModelProvider, model });
                                              }
                                            }}
                                            onToggleFavorite={(id) => {
                                              if (!settings) return;
                                              const baseFav = settings.ui.favoriteModels ?? defaultSettings.ui.favoriteModels;
                                              const nextSet = new Set(baseFav[overrideModelProvider] ?? []);
                                              if (nextSet.has(id)) nextSet.delete(id);
                                              else nextSet.add(id);
                                              const next: AppSettings = {
                                                ...settings,
                                                ui: {
                                                  ...settings.ui,
                                                  favoriteModels: {
                                                    ...baseFav,
                                                    [overrideModelProvider]: [...nextSet].sort((a, b) => a.localeCompare(b))
                                                  }
                                                }
                                              };
                                              setSettings(next);
                                              void persistSettingsToDisk(next);
                                            }}
                                          />
                                        </div>
                                      </div>
                                    </motion.div>
                                  ) : null}
                                </AnimatePresence>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    ) : null}
                    {normalChatList.length === 0 ? (
                      <div className="sidebar-empty">
                        <p>No conversations yet. Start a new chat to begin.</p>
                      </div>
                    ) : (
                      <div className="chat-list">
                        {normalChatList.map((chat) => (
                          <div
                            key={chat.id}
                            className={`chat-list__item ${activeChatId === chat.id ? 'is-active' : ''} ${chat.pinned ? 'is-pinned' : ''}`}
                            onClick={() => loadChat(chat.id)}
                          >
                            {editingTitleId === chat.id ? (
                              <div className="chat-list__content chat-list__content--editing" onClick={(e) => e.stopPropagation()}>
                                <input
                                  autoFocus
                                  className="chat-list__title-input"
                                  onBlur={(e) => {
                                    void commitRenameChat(chat.id, e.target.value);
                                  }}
                                  onChange={(e) => setEditingTitleDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') {
                                      e.currentTarget.blur();
                                    } else if (e.key === 'Escape') {
                                      e.preventDefault();
                                      skipNextRenameCommitRef.current = true;
                                      cancelRenameChat();
                                    }
                                  }}
                                  value={editingTitleDraft}
                                />
                              </div>
                            ) : (
                              <div className="chat-list__content">
                                <div className="chat-list__title">{chat.title}</div>
                                <div className="chat-list__date">{formatRelativeDate(chat.updatedAt)}</div>
                              </div>
                            )}
                            {editingTitleId === chat.id ? null : (
                              <div className="chat-list__row-actions" onClick={(e) => e.stopPropagation()}>
                                <button
                                  className={`chat-list__pin ${chat.pinned ? 'is-active' : ''}`}
                                  onClick={(e) => void togglePinChat(e, chat.id)}
                                  type="button"
                                  title={chat.pinned ? 'Unpin' : 'Pin to top'}
                                >
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                    <path
                                      d="M6 1.2L2.2 5.2V10h7.6V5.2L6 1.2z"
                                      fill={chat.pinned ? 'currentColor' : 'none'}
                                      stroke="currentColor"
                                      strokeLinejoin="round"
                                      strokeWidth="1.1"
                                    />
                                  </svg>
                                </button>
                                <button
                                  className="chat-list__rename"
                                  onClick={(e) => beginRenameChat(e, chat.id, chat.title)}
                                  type="button"
                                  title="Rename"
                                >
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                    <path
                                      d="M7.3 1.2l3.4 3.4-7.5 7.5H.8V8.7l7.5-7.5zM1.5 7.6v1.2h1.2l5.6-5.6L7 2 1.5 7.5z"
                                      fill="currentColor"
                                    />
                                  </svg>
                                </button>
                                <button
                                  className="chat-list__delete"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    requestDeleteChat(chat);
                                  }}
                                  onMouseDown={(e) => e.preventDefault()}
                                  type="button"
                                  title="Delete chat"
                                >
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                    <path
                                      d="M2 3h8M4.5 3V2a1 1 0 011-1h1a1 1 0 011 1v1M5 5.5v3M7 5.5v3M3 3l.5 7a1 1 0 001 1h3a1 1 0 001-1L9 3"
                                      stroke="currentColor"
                                      strokeWidth="1.2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                ) : sidebarTab === 'wizards' ? (
                  <motion.div
                    key="wizards"
                    className="sidebar-panel"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {wizardChatList.length === 0 ? (
                      <div className="sidebar-empty">
                        <p>No Wizards yet. Create one from New to give it a model, memory, and workspace.</p>
                      </div>
                    ) : (
                      <>
                        <div className="chat-list">
                        {wizardChatList.map((chat) => (
                          <div className="wizard-group" key={chat.id}>
                            <div
                              aria-expanded={expandedWizardIds.has(chat.id)}
                              className={`chat-list__item chat-list__item--wizard ${activeWizardMeta?.id === chat.id ? 'is-active' : ''} ${chat.pinned ? 'is-pinned' : ''}`}
                              onClick={() => {
                                if (editingTitleId === chat.id) return;
                                void handleWizardSidebarRowActivate(chat);
                              }}
                            >
                              {editingTitleId === chat.id ? (
                                <div className="chat-list__content chat-list__content--editing" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    autoFocus
                                    className="chat-list__title-input"
                                    onBlur={(e) => {
                                      void commitRenameChat(chat.id, e.target.value);
                                    }}
                                    onChange={(e) => setEditingTitleDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                      e.stopPropagation();
                                      if (e.key === 'Enter') {
                                        e.currentTarget.blur();
                                      } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        skipNextRenameCommitRef.current = true;
                                        cancelRenameChat();
                                      }
                                    }}
                                    value={editingTitleDraft}
                                  />
                                </div>
                              ) : (
                                <div className="chat-list__content">
                                  <div className="chat-list__title wizard-title-row">
                                    <svg
                                      className={`wizard-title-row__chevron ${expandedWizardIds.has(chat.id) ? 'is-open' : ''}`}
                                      width="12"
                                      height="12"
                                      viewBox="0 0 12 12"
                                      fill="none"
                                      aria-hidden
                                    >
                                      <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                    <span title={chat.title}>{chat.title}</span>
                                  </div>
                                  <div className="chat-list__date">
                                    Wizard · {(wizardSessionsByWizardId.get(chat.id) ?? []).length} sessions
                                  </div>
                                </div>
                              )}
                              {editingTitleId === chat.id ? null : (
                                <div className="chat-list__row-actions" onClick={(e) => e.stopPropagation()}>
                                  <button
                                    className={`chat-list__pin ${chat.pinned ? 'is-active' : ''}`}
                                    onClick={(e) => void togglePinChat(e, chat.id)}
                                    type="button"
                                    title={chat.pinned ? 'Unpin' : 'Pin to top'}
                                  >
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                      <path d="M6 1.2L2.2 5.2V10h7.6V5.2L6 1.2z" fill={chat.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeLinejoin="round" strokeWidth="1.1" />
                                    </svg>
                                  </button>
                                  <button className="chat-list__rename" onClick={(e) => beginRenameChat(e, chat.id, chat.title)} type="button" title="Rename">
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                      <path d="M7.3 1.2l3.4 3.4-7.5 7.5H.8V8.7l7.5-7.5zM1.5 7.6v1.2h1.2l5.6-5.6L7 2 1.5 7.5z" fill="currentColor" />
                                    </svg>
                                  </button>
                                  <button className="chat-list__delete" onClick={(e) => { e.stopPropagation(); requestDeleteChat(chat); }} onMouseDown={(e) => e.preventDefault()} type="button" title="Delete Wizard">
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                                      <path d="M2 3h8M4.5 3V2a1 1 0 011-1h1a1 1 0 011 1v1M5 5.5v3M7 5.5v3M3 3l.5 7a1 1 0 001 1h3a1 1 0 001-1L9 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  </button>
                                </div>
                              )}
                            </div>
                            <motion.div
                              aria-hidden={!expandedWizardIds.has(chat.id)}
                              className="wizard-session-list-anim"
                              initial={false}
                              animate={{
                                height: expandedWizardIds.has(chat.id) ? 'auto' : 0
                              }}
                              style={{
                                overflow: 'hidden',
                                pointerEvents: expandedWizardIds.has(chat.id) ? 'auto' : 'none'
                              }}
                              transition={{
                                duration: 0.32,
                                ease: [0.4, 0, 0.2, 1]
                              }}
                            >
                              <div className="wizard-session-list">
                                <button className="wizard-session-button" onClick={() => void createWizardSession(chat)} type="button">
                                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden>
                                    <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                  </svg>
                                  New session
                                </button>
                                {(wizardSessionsByWizardId.get(chat.id) ?? []).map((session) => (
                                  <div
                                    className={`wizard-session-row ${activeChatId === session.id ? 'is-active' : ''}`}
                                    key={session.id}
                                    onClick={() => void loadChat(session.id)}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        void loadChat(session.id);
                                      }
                                    }}
                                  >
                                    <span title={session.title}>{session.title}</span>
                                    <div className="wizard-session-row__meta">
                                      <small>{formatRelativeDate(session.updatedAt)}</small>
                                      <button
                                        aria-label={`Delete ${session.title}`}
                                        className="wizard-session-row__delete"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          requestDeleteChat(session);
                                        }}
                                        title="Delete session"
                                        type="button"
                                      >
                                        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
                                          <path d="M2 3h8M4.5 3V2a1 1 0 011-1h1a1 1 0 011 1v1M5 5.5v3M7 5.5v3M3 3l.5 7a1 1 0 001 1h3a1 1 0 001-1L9 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </motion.div>
                          </div>
                        ))}
                        </div>
                      </>
                    )}
                  </motion.div>
                ) : (
                  <motion.div
                    key="files"
                    className="sidebar-panel"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {workspaceRoot ? (
                      <>
                        <div className="workspace-meta">
                          <div className="workspace-meta__value">{pathLabel(workspaceRoot)}</div>
                          <div className="workspace-meta__hint">{workspaceRoot}</div>
                        </div>
                        <FileTree activePath={activeFilePath} nodes={workspaceTree} onOpen={openFile} />
                      </>
                    ) : (
                      <div className="sidebar-empty">
                        <p>Open a workspace to browse and edit project files.</p>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="sidebar-footer">
              <div className="sidebar-footer__meta">
                <span>{selectedProviderLabel}</span>
                <span
                  className={`sidebar-footer__dot ${
                    providerConnected ? 'is-live' : modelCatalogSettled ? 'is-disconnected' : ''
                  }`}
                />
                <span>
                  {effectiveHeaderModelId ? pathLabel(effectiveHeaderModelId) : 'No model'}
                </span>
              </div>
            </div>
          </div>
        </motion.aside>

        <motion.section
          animate={{ opacity: 1, y: 0 }}
          className="center-stage"
          initial={{ opacity: 0, y: 12 }}
          transition={{ delay: 0.1, duration: 0.4 }}
        >
          <ChatPanel
            attachments={chatAttachments}
            chatMessages={chatMessages}
            contextLimit={resolvedContextLimit}
            input={chatInput}
            isStreaming={chatStreaming}
            isWizard={chatPanelIsWizard}
            lastTokenUsage={lastTokenUsage}
            sessionSubheading={chatSessionSubheading}
            timeline={chatTimeline}
            wizardHubPlaceholder={showWizardHubPlaceholder}
            onOpenWizardCreator={() => setShowWizardSetup(true)}
            onAttachImages={addChatAttachments}
            onInputChange={setChatInput}
            onRemoveAttachment={(id) => setChatAttachments((c) => c.filter((a) => a.id !== id))}
            onSend={sendChat}
            onStop={stopChat}
            modelCatalogSettled={Boolean(settings) && modelCatalogSettled}
            providerConnected={providerConnected}
            webSearch={settings?.ui.webSearch ?? false}
            webSearchDisabled={!settings}
            onWebSearchChange={handleWebSearchChange}
            onSessionModeToggle={handleSessionModeToggle}
            sessionModeToggleDisabled={!settings || chatPanelIsWizard}
            sessionMode={sessionMode}
            selectedModel={effectiveHeaderModelId}
            selectedProviderLabel={selectedProviderLabel}
            hasWorkspace={Boolean(workspaceRoot)}
            terminalLogs={inlineTerminalLogs}
            terminalJobId={inlineTerminalJobId}
            onTerminalRun={runInlineTerminal}
            onTerminalKill={killInlineTerminal}
          />
        </motion.section>

        <motion.aside
          animate={{ opacity: 1, x: 0 }}
          className="inspector"
          initial={{ opacity: 0, x: 16 }}
          transition={{ delay: 0.15, duration: 0.4 }}
        >
          <div className="inspector-card">
            <div className="inspector-switcher">
              <button
                className={`inspector-tab ${inspectorTab === 'editor' ? 'is-active' : ''}`}
                onClick={() => setInspectorTab('editor')}
                type="button"
              >
                Editor
              </button>
              <button
                className={`inspector-tab ${inspectorTab === 'changes' ? 'is-active' : ''}`}
                onClick={() => {
                  setInspectorTab('changes');
                  void refreshWorkspaceChanges();
                }}
                type="button"
              >
                Changes
              </button>
              <button
                className={`inspector-tab ${inspectorTab === 'settings' ? 'is-active' : ''}`}
                onClick={() => setInspectorTab('settings')}
                type="button"
              >
                Settings
              </button>
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                className="utility-stack"
                animate={{ opacity: 1, y: 0 }}
                initial={{ opacity: 0, y: 8 }}
                key={inspectorTab}
                transition={{ duration: 0.2 }}
              >
                {inspectorTab === 'editor' ? (
                  <EditorPanel
                    content={activeBuffer?.content ?? ''}
                    dirty={activeBuffer?.dirty ?? false}
                    filePath={activeFilePath}
                    imagePreview={activeBuffer?.imagePreview}
                    onChange={(next) => {
                      if (!activeFilePath) return;
                      const cur = buffers[activeFilePath];
                      if (cur?.imagePreview) return;
                      setBuffers((current) => ({
                        ...current,
                        [activeFilePath]: { ...current[activeFilePath], content: next, dirty: true }
                      }));
                    }}
                    onSave={saveActiveFile}
                  />
                ) : null}
                {inspectorTab === 'changes' ? (
                  <ChangesPanel
                    changes={workspaceChanges}
                    loading={changesLoading}
                    onRefresh={() => void refreshWorkspaceChanges()}
                    workspaceRoot={workspaceRoot}
                  />
                ) : null}
                {inspectorTab === 'settings' && settings ? (
                  <div className="inspector-settings-wrap">
                    {activeWizard ? (
                      <div className="inspector-settings-scope" role="group" aria-label="Which settings to edit">
                        <div className="session-mode-toggle">
                          <button
                            className={`session-mode-toggle__option ${settingsInspectorScope === 'general' ? 'is-active' : ''}`}
                            onClick={() => setSettingsInspectorScope('general')}
                            type="button"
                          >
                            General
                          </button>
                          <button
                            className={`session-mode-toggle__option ${settingsInspectorScope === 'wizard' ? 'is-active' : ''}`}
                            onClick={() => setSettingsInspectorScope('wizard')}
                            type="button"
                          >
                            Wizard
                          </button>
                          <span
                            className="session-mode-toggle__slider"
                            style={{
                              transform: settingsInspectorScope === 'wizard' ? 'translateX(100%)' : 'translateX(0)'
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                    {settingsInspectorScope === 'wizard' && wizardDraft ? (
                      <WizardSettingsPanel
                        modelOptions={overrideModels}
                        onChange={handleWizardDraftChange}
                        onOpenDocument={(path) => void openFile(path)}
                        onPresetPersist={persistAfterPresetAction}
                        onRefreshModels={refreshWizardModels}
                        onSettingsChangeForFavorites={handleSettingsPanelChange}
                        settings={settings}
                        statusMessage={settingsStatus}
                        wizard={wizardDraft}
                      />
                    ) : (
                      <SettingsPanel
                        focusSearchSettingsKey={searchSettingsFocusKey}
                        modelOptions={models}
                        onChange={handleSettingsPanelChange}
                        onOpenConnectionHelp={() => setShowConnectionHelp(true)}
                        onOpenSystemPromptModal={() => setShowSystemPromptModal(true)}
                        onOpenWebSearchInfo={() => setShowWebSearchNotice(true)}
                        onPresetPersist={persistAfterPresetAction}
                        onRefreshModels={refreshModels}
                        settings={settings}
                        statusMessage={settingsStatus}
                      />
                    )}
                  </div>
                ) : null}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.aside>
      </main>
    </div>
  );
}

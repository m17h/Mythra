import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import openkiwiLogo from '@renderer/assets/openkiwi.png';
import { applyChatModelOverride, formatOverrideLabel } from '@renderer/lib/apply-model-override';
import { ChatPanel } from './components/ChatPanel';
import { CommandDeck } from './components/CommandDeck';
import { ModelSearch } from './components/ModelSearch';
import { EditorPanel } from './components/EditorPanel';
import { FileTree } from './components/FileTree';
import { OpenKiwiMark } from './components/OpenKiwiMark';
import { SettingsPanel } from './components/SettingsPanel';
import {
  defaultSettings,
  type AppSettings,
  type ChatActivity,
  type ChatAttachment,
  type ChatMessage,
  type ChatModelOverride,
  type ChatTimelineEntry,
  type CommandResult,
  type ModelInfo,
  type OpenFile,
  type ProviderKind,
  type SessionMode,
  type SavedChat,
  type SavedChatMeta,
  type WorkspaceNode
} from '@shared/types';

const uid = () => Math.random().toString(36).slice(2, 10);
const pathLabel = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() ?? value;
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

type InspectorTab = 'editor' | 'console' | 'settings';
type SidebarTab = 'chats' | 'files';

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsStatus, setSettingsStatus] = useState('Load a provider profile, then refresh models.');
  const [workspaceRoot, setWorkspaceRoot] = useState<string>();
  const [workspaceTree, setWorkspaceTree] = useState<WorkspaceNode[]>([]);
  const [buffers, setBuffers] = useState<Record<string, FileBuffer>>({});
  const [activeFilePath, setActiveFilePath] = useState<string>();
  const [models, setModels] = useState<ModelInfo[]>([]);
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

  const [commandInput, setCommandInput] = useState('git status');
  const [commandLogs, setCommandLogs] = useState('');
  const [activeJobId, setActiveJobId] = useState<string>();
  const [lastCommandResult, setLastCommandResult] = useState<CommandResult>();
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('settings');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('chats');
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleDraft, setEditingTitleDraft] = useState('');

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastContentFingerprintRef = useRef<string | null>(null);
  const skipNextRenameCommitRef = useRef(false);

  const appendActivity = (activity: ChatActivity) => {
    setChatTimeline((current) => [...current, { id: `activity-${activity.id}`, type: 'activity', activity }]);
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

  const activeChatMeta = useMemo(
    () => (activeChatId ? chatList.find((c) => c.id === activeChatId) : undefined),
    [activeChatId, chatList]
  );

  const effectiveModelOverride = useMemo((): ChatModelOverride | null => {
    if (activeChatId) return activeChatMeta?.modelOverride ?? null;
    return newChatModelOverride;
  }, [activeChatId, activeChatMeta?.modelOverride, newChatModelOverride]);

  const chatSessionSubheading = useMemo(() => {
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
  }, [activeChatId, chatList, chatMessages, newChatModelOverride, pathLabel]);

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
      const chat: SavedChat = {
        id,
        title: resolveChatTitle(msgs, nameOverride),
        titleOverride: nameOverride == null || nameOverride === '' ? null : nameOverride.trim() || null,
        messages: msgs,
        timeline: tl,
        createdAt,
        updatedAt: now,
        pinned: disk?.pinned ?? existing?.pinned ?? false,
        modelOverride: disk?.modelOverride ?? existing?.modelOverride ?? (chatId ? null : (newChatModelOverrideRef.current ?? null))
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

  useEffect(() => {
    const boot = async () => {
      const loaded = await window.electronAPI.loadSettings();
      setSettings(loaded);
      document.documentElement.dataset.theme = loaded.ui.themeId;
      await refreshChatList();
    };
    void boot();
  }, []);

  useEffect(() => {
    if (!settings) return;
    document.documentElement.dataset.theme = settings.ui.themeId;
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
      setCommandLogs((c) => c + payload.chunk);
    });
    const offDone = window.electronAPI.onCommandDone((payload) => {
      setActiveJobId(undefined);
      setLastCommandResult(payload);
      setCommandLogs((c) => c + `\n[process exited ${payload.code ?? 'signal'}]\n`);
    });
    const offDelta = window.electronAPI.onChatDelta(({ requestId, delta, reasoningDelta }) => {
      setChatMessages((current) =>
        current.map((m) => {
          if (m.id !== requestId) return m;
          return {
            ...m,
            content: delta ? `${m.content}${delta}` : m.content,
            reasoning: reasoningDelta ? `${m.reasoning ?? ''}${reasoningDelta}` : m.reasoning,
            status: 'streaming' as const
          };
        })
      );
      updateTimelineMessage(requestId, (m) => ({
        ...m,
        content: delta ? `${m.content}${delta}` : m.content,
        reasoning: reasoningDelta ? `${m.reasoning ?? ''}${reasoningDelta}` : m.reasoning,
        status: 'streaming' as const
      }));
    });
    const offDoneChat = window.electronAPI.onChatDone(({ requestId, content, reasoning }) => {
      setChatStreaming(false);
      setActiveRequestId(undefined);
      setChatMessages((current) =>
        current.map((m) => {
          if (m.id !== requestId) return m;
          const next: ChatMessage = { ...m, content, status: 'done' as const };
          if (reasoning !== undefined) next.reasoning = reasoning;
          else if (m.reasoning !== undefined) next.reasoning = m.reasoning;
          return next;
        })
      );
      updateTimelineMessage(requestId, (m) => {
        const next: ChatMessage = { ...m, content, status: 'done' as const };
        if (reasoning !== undefined) next.reasoning = reasoning;
        else if (m.reasoning !== undefined) next.reasoning = m.reasoning;
        return next;
      });
    });
    const offError = window.electronAPI.onChatError(({ requestId, error }) => {
      setChatStreaming(false);
      setActiveRequestId(undefined);
      setChatMessages((current) =>
        current.map((m) => (m.id === requestId ? { ...m, content: error, status: 'error', role: 'assistant' } : m))
      );
      updateTimelineMessage(requestId, (m) => ({ ...m, content: error, status: 'error', role: 'assistant' }));
      appendActivity({
        id: uid(),
        requestId,
        kind: error === 'Request stopped.' ? 'stopped' : 'error',
        message: error === 'Request stopped.' ? 'Model stopped.' : `Model error: ${error}`
      });
    });
    const offActivity = window.electronAPI.onChatActivity((payload) => {
      appendActivity(payload);
    });
    const offSettingsUpdated = window.electronAPI.onSettingsUpdated((next) => {
      setSettings(next);
    });
    const offWorkspaceChanged = window.electronAPI.onWorkspaceChanged(
      async ({ root, fileWritten, fileDeleted }) => {
        const latestTree = await window.electronAPI.getWorkspaceTree(root);
        setWorkspaceTree(latestTree);

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
              return { ...current, [key]: { path: reloaded.path, content: reloaded.content, dirty: false } };
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
      offWorkspaceChanged();
    };
  }, []);

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
    setCommandLogs((c) => c + `\n[workspace attached: ${result.root}]\n`);
  };

  const clearWorkspace = () => {
    if (!workspaceRoot) return;
    setWorkspaceRoot(undefined);
    setWorkspaceTree([]);
    setBuffers({});
    setActiveFilePath(undefined);
    setCommandLogs((c) => c + '\n[workspace cleared]\n');
  };

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
    if (!activeBuffer) return;
    const saved = await window.electronAPI.saveFile(workspaceRoot, activeFilePath, activeBuffer.content);
    setBuffers((current) => ({ ...current, [activeFilePath]: { ...saved, dirty: false } }));
  };

  const refreshModels = async (settingsOverride?: AppSettings) => {
    const activeSettings = settingsOverride ?? settings;
    if (!activeSettings) return;

    setModelCatalogSettled(false);

    if (activeSettings.selectedProvider === 'openrouter') {
      const key = activeSettings.providers.openrouter.apiKey?.trim() ?? '';
      if (!key) {
        setModels([]);
        setSettingsStatus('OpenRouter: add an API key in Settings, then use Test + refresh.');
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

  const handleWebSearchChange = useCallback(async (next: boolean) => {
    const s = settingsRef.current;
    if (!s) return;
    const updated: AppSettings = { ...s, ui: { ...s.ui, webSearch: next } };
    try {
      const saved = await window.electronAPI.saveSettings(updated);
      setSettings(saved);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed';
      setSettingsStatus(`Web search setting not saved: ${m}`);
    }
  }, []);

  const handleSessionModeToggle = useCallback(async () => {
    const s = settingsRef.current;
    if (!s) return;
    const nextMode: SessionMode = s.ui.sessionMode === 'talk' ? 'agent' : 'talk';
    const updated: AppSettings = { ...s, ui: { ...s.ui, sessionMode: nextMode } };
    try {
      const saved = await window.electronAPI.saveSettings(updated);
      setSettings(saved);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed';
      setSettingsStatus(`Session mode not saved: ${m}`);
    }
  }, []);

  const persistAfterPresetAction = async (next: AppSettings) => {
    try {
      await persistSettingsToDisk(next);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed';
      setSettingsStatus(`Could not save settings to disk: ${m}`);
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    try {
      await persistSettingsToDisk(settings);
      setSettingsStatus('Profile saved.');
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed';
      setSettingsStatus(`Profile save failed: ${m}`);
      throw e;
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

  const startNewChat = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    lastContentFingerprintRef.current = null;
    setChatMessages([]);
    setChatTimeline([]);
    setChatInput('');
    setChatAttachments([]);
    setChatStreaming(false);
    setActiveRequestId(undefined);
    setActiveChatId(undefined);
    setNewChatModelOverride(null);
    const nextSid = uid();
    setChatSessionId(nextSid);
    chatSessionIdRef.current = nextSid;
  };

  const loadChat = async (id: string) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const chat = await window.electronAPI.loadChat(id);
    if (!chat) return;
    lastContentFingerprintRef.current = chatFingerprint(chat.messages, chat.timeline);
    setChatMessages(chat.messages);
    setChatTimeline(chat.timeline);
    setActiveChatId(chat.id);
    setChatSessionId(chat.id);
    chatSessionIdRef.current = chat.id;
    setNewChatModelOverride(null);
    setChatInput('');
    setChatAttachments([]);
    setChatStreaming(false);
    setActiveRequestId(undefined);
  };

  const deleteChat = async (id: string) => {
    await window.electronAPI.deleteChat(id);
    if (activeChatId === id) startNewChat();
    if (editingTitleId === id) {
      setEditingTitleId(null);
      setEditingTitleDraft('');
    }
    await refreshChatList();
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
    await window.electronAPI.saveChat({
      ...full,
      title: nextOverride != null ? nextOverride : chatTitle(full.messages),
      titleOverride: nextOverride,
      updatedAt: full.updatedAt
    });
    await refreshChatList();
  };

  const sendChat = async () => {
    const sendSettings = settingsRef.current;
    if (chatStreamingRef.current || !sendSettings || (chatInput.trim().length === 0 && chatAttachments.length === 0)) return;
    chatStreamingRef.current = true;
    const userMessage: ChatMessage = {
      id: uid(),
      role: 'user',
      content: chatInput.trim().length > 0 ? chatInput : 'Please use the attached image(s) as context for this request.',
      attachments: chatAttachments,
      status: 'done'
    };
    const requestId = uid();
    const assistantMessage: ChatMessage = {
      id: requestId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      reasoning: sendSettings.ui.sessionMode === 'talk' ? '' : undefined
    };
    const nextHistory = [...chatMessages, userMessage];
    const nextTimeline: ChatTimelineEntry[] = [
      ...chatTimeline,
      { id: `message-${userMessage.id}`, type: 'message', message: userMessage },
      { id: `message-${assistantMessage.id}`, type: 'message', message: assistantMessage }
    ];
    setChatMessages([...nextHistory, assistantMessage]);
    setChatTimeline(nextTimeline);
    setChatInput('');
    setChatAttachments([]);
    setChatStreaming(true);
    setActiveRequestId(requestId);

    const priorChatId = activeChatId;
    let overrideForStream: ChatModelOverride | null = null;
    if (!priorChatId) {
      const newId = uid();
      const mo = newChatModelOverrideRef.current;
      overrideForStream = mo;
      setActiveChatId(newId);
      setChatSessionId(newId);
      chatSessionIdRef.current = newId;
      setNewChatModelOverride(null);
      const chat: SavedChat = {
        id: newId,
        title: chatTitle([...nextHistory, assistantMessage]),
        titleOverride: null,
        messages: [...nextHistory, assistantMessage],
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
    const streamSettings = applyChatModelOverride(sendSettings, overrideForStream);

    await window.electronAPI.streamChat(requestId, streamSettings, nextHistory, {
      workspaceRoot: workspaceRootRef.current,
      activeFilePath: activeFilePathRef.current,
      conversationId: chatSessionIdRef.current
    });
  };

  const stopChat = async () => {
    if (!activeRequestId) return;
    await window.electronAPI.stopChat(activeRequestId);
    setChatStreaming(false);
    setActiveRequestId(undefined);
  };

  const runCommand = async () => {
    if (!commandInput.trim()) return;
    const result = await window.electronAPI.runCommand(commandInput, workspaceRoot);
    setActiveJobId(result.jobId);
    setLastCommandResult(undefined);
  };

  const killCommand = async () => {
    if (!activeJobId) return;
    await window.electronAPI.killCommand(activeJobId);
    setActiveJobId(undefined);
    setCommandLogs((c) => c + '\n[termination requested]\n');
  };

  const activeBuffer = activeFilePath ? buffers[activeFilePath] : undefined;
  const selectedProvider = settings?.providers[settings.selectedProvider];
  /** Per-chat model override wins in the top bar and footer over the global default. */
  const effectiveHeaderModelId =
    effectiveModelOverride?.model ?? selectedProvider?.model ?? '';
  const openRouterReady =
    settings && settings.selectedProvider === 'openrouter'
      ? Boolean(settings.providers.openrouter.apiKey?.trim())
      : true;
  const providerConnected = Boolean(
    settings && openRouterReady && models.length > 0 && selectedProvider?.model
  );
  const selectedProviderLabel = settings?.selectedProvider === 'openrouter' ? 'OpenRouter' : 'LM Studio';
  const sessionMode = settings?.ui.sessionMode ?? 'agent';
  const isDarwin = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';

  return (
    <div className="app-shell">
      <div className="background-grid" />
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
                  <OpenKiwiMark />
                  <img
                    alt=""
                    className="sidebar-brand__logo"
                    decoding="async"
                    height={32}
                    src={openkiwiLogo}
                    width={32}
                  />
                </div>
                <div className="sidebar-brand__copy">Local AI workspace</div>
              </div>
            </div>

            <div className="sidebar-quick">
              <button className="sidebar-quick__btn sidebar-quick__btn--primary" onClick={startNewChat} type="button">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                New Chat
              </button>
              <button className="sidebar-quick__btn" onClick={chooseWorkspace} type="button">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M1 4.5l5-3 5 3v6l-5 3-5-3v-6z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
                {workspaceRoot ? 'Switch workspace' : 'Open workspace'}
              </button>
              <button
                className="sidebar-quick__btn"
                disabled={!workspaceRoot}
                onClick={clearWorkspace}
                type="button"
                title={workspaceRoot ? 'Unmount the current folder' : 'No workspace open'}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                  <path
                    d="M2.5 5h2.2L5.3 4h3.4l.6 1h2.2a1 1 0 011 1v5.5a1 1 0 01-1 1h-9a1 1 0 01-1-1V6a1 1 0 011-1zM5.5 8.5h3"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Clear workspace
              </button>
            </div>

            <div className="sidebar-tabs" role="tablist">
              <button
                className={`sidebar-tabs__tab ${sidebarTab === 'chats' ? 'is-active' : ''}`}
                onClick={() => setSidebarTab('chats')}
                type="button"
                role="tab"
              >
                Chats
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
                                          <select
                                            className="chat-thread-options__select"
                                            onChange={async (e) => {
                                              const p = e.target.value as ProviderKind;
                                              setOverrideModelProvider(p);
                                              if (!settings) return;
                                              const list = await window.electronAPI.listModels(settings, p);
                                              const model = pickDefaultModel(list, undefined);
                                              if (model) {
                                                await saveChatModelOverride({ provider: p, model });
                                              }
                                            }}
                                            value={overrideModelProvider}
                                          >
                                            <option value="lmstudio">LM Studio</option>
                                            <option value="openrouter">OpenRouter</option>
                                          </select>
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
                    {chatList.length === 0 ? (
                      <div className="sidebar-empty">
                        <p>No conversations yet. Start a new chat to begin.</p>
                      </div>
                    ) : (
                      <div className="chat-list">
                        {chatList.map((chat) => (
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
                                    deleteChat(chat.id);
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
            input={chatInput}
            isStreaming={chatStreaming}
            sessionSubheading={chatSessionSubheading}
            timeline={chatTimeline}
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
            sessionModeToggleDisabled={!settings}
            sessionMode={sessionMode}
            selectedModel={effectiveHeaderModelId}
            selectedProviderLabel={selectedProviderLabel}
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
                className={`inspector-tab ${inspectorTab === 'console' ? 'is-active' : ''}`}
                onClick={() => setInspectorTab('console')}
                type="button"
              >
                Console
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
                    onChange={(next) => {
                      if (!activeFilePath) return;
                      setBuffers((current) => ({
                        ...current,
                        [activeFilePath]: { ...current[activeFilePath], content: next, dirty: true }
                      }));
                    }}
                    onSave={saveActiveFile}
                  />
                ) : null}
                {inspectorTab === 'console' ? (
                  <CommandDeck
                    activeJobId={activeJobId}
                    commandInput={commandInput}
                    lastResult={lastCommandResult}
                    logs={commandLogs}
                    onCommandInputChange={setCommandInput}
                    onKill={killCommand}
                    onRun={runCommand}
                  />
                ) : null}
                {inspectorTab === 'settings' && settings ? (
                  <SettingsPanel
                    modelOptions={models}
                    onChange={setSettings}
                    onPresetPersist={persistAfterPresetAction}
                    onRefreshModels={refreshModels}
                    onSave={saveSettings}
                    settings={settings}
                    statusMessage={settingsStatus}
                  />
                ) : null}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.aside>
      </main>
    </div>
  );
}

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import type {
  ChatActivity,
  ChatAttachment,
  ChatCompletionTokenUsage,
  ChatMessage,
  ChatTimelineEntry,
  SessionMode
} from '@shared/types';
import {
  DEFAULT_HIDDEN_SYSTEM_OVERHEAD_TOKENS,
  roughTokensForDraft,
  roughTokensFromMessages
} from '@renderer/lib/estimate-context-tokens';
import { ALL_EMBED_STRIP_STRINGS } from '@shared/mythra-embeds';
import { AssistantMessageContent } from './AssistantMessageContent';
import { ChatMarkdown } from './ChatMarkdown';

/** How close to the true bottom counts as “pinned” for auto-follow while the model streams. */
const CHAT_BOTTOM_STICK_EPSILON_PX = 4;

function NexusRelayProgressBar(props: { wizardName: string; segmentStartedAt: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, [props.segmentStartedAt, props.wizardName]);
  const sec = Math.max(0, Math.floor((Date.now() - props.segmentStartedAt) / 1000));
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  const elapsed = mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${sec}s`;

  return (
    <div className="chat-compose__relay-status" role="status">
      <span className="chat-compose__relay-pulse" aria-hidden />
      <span className="chat-compose__relay-primary">
        <strong>{props.wizardName}</strong>
        <span className="chat-compose__relay-muted"> · responding</span>
      </span>
      <span className="chat-compose__relay-elapsed">{elapsed}</span>
      <span className="chat-compose__relay-hint">
        Still working — queue a message for the next teammate. Name someone (<strong>@WizardName</strong> or their display name) so Mythra routes the next reply to them.
      </span>
    </div>
  );
}

function distanceFromChatBottom(node: HTMLElement): number {
  const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
  return maxScroll - node.scrollTop;
}

function getChatScrollMax(node: HTMLElement): number {
  return Math.max(0, node.scrollHeight - node.clientHeight);
}

function getCopyableMessageText(content: string): string {
  let s = content;
  for (const token of ALL_EMBED_STRIP_STRINGS) {
    s = s.replaceAll(token, '');
  }
  return s.trim();
}

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatTokensExact(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString();
}

function ChatContextMeter({ used, limit }: { used: number; limit: number }) {
  const safeLimit = Math.max(limit, 1);
  const usedRounded = Math.max(0, Math.round(used));
  const available = Math.max(0, safeLimit - usedRounded);
  const pct = Math.min(100, Math.max(0, (usedRounded / safeLimit) * 100));
  const r = 9;
  const c = 2 * Math.PI * r;
  const dashOffset = c * (1 - pct / 100);
  const ariaSummary = `${pct.toFixed(1)}% context used. ${formatTokensExact(usedRounded)} of ${formatTokensExact(safeLimit)} tokens.`;
  const warn = pct >= 88;
  const tooltipId = useId();

  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current != null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const updateAnchor = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    setAnchor({ top: b.top, left: b.left + b.width / 2 });
  }, []);

  const handleOpen = useCallback(() => {
    clearCloseTimer();
    updateAnchor();
    setOpen(true);
  }, [clearCloseTimer, updateAnchor]);

  const handleScheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => setOpen(false), 180);
  }, [clearCloseTimer]);

  useLayoutEffect(() => {
    if (!open) return;
    updateAnchor();
    const onReposition = () => updateAnchor();
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    return () => {
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };
  }, [open, updateAnchor]);

  useEffect(() => {
    return () => clearCloseTimer();
  }, [clearCloseTimer]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  const popover =
    open &&
    typeof document !== 'undefined' &&
    createPortal(
      <div
        className="chat-context-meter__popup"
        id={tooltipId}
        onMouseEnter={handleOpen}
        onMouseLeave={handleScheduleClose}
        role="tooltip"
        style={{
          left: anchor.left,
          top: anchor.top - 8,
          transform: 'translate(-50%, -100%)'
        }}
      >
        <div className="chat-context-meter__popup-inner">
          <div className="chat-context-meter__row">
            <span className="chat-context-meter__label">Used</span>
            <span className="chat-context-meter__value">{formatTokensExact(usedRounded)}</span>
          </div>
          <div className="chat-context-meter__row">
            <span className="chat-context-meter__label">Available</span>
            <span className="chat-context-meter__value">{formatTokensExact(available)}</span>
          </div>
          <div className="chat-context-meter__meta">
            {pct.toFixed(1)}% · {formatTokensShort(safeLimit)} context window
          </div>
        </div>
      </div>,
      document.body
    );

  return (
    <>
      <button
        ref={triggerRef}
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        aria-label={ariaSummary}
        className={`chat-context-meter${warn ? ' chat-context-meter--warn' : ''}`}
        onBlur={handleScheduleClose}
        onFocus={handleOpen}
        onMouseEnter={handleOpen}
        onMouseLeave={handleScheduleClose}
        type="button"
      >
        <svg aria-hidden height="22" viewBox="0 0 22 22" width="22">
          <circle className="chat-context-meter__track" cx="11" cy="11" fill="none" r={r} strokeWidth="2" />
          <circle
            className="chat-context-meter__fill"
            cx="11"
            cy="11"
            fill="none"
            r={r}
            strokeDasharray={c}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            strokeWidth="2"
            transform="rotate(-90 11 11)"
          />
        </svg>
      </button>
      {popover}
    </>
  );
}

function CopyMessageIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M20 6L9 17l-5-5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect width="14" height="14" x="8" y="8" rx="2" stroke="currentColor" strokeWidth="2" />
      <path
        d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface ChatPanelProps {
  timeline: ChatTimelineEntry[];
  input: string;
  attachments: ChatAttachment[];
  /** e.g. “New conversation” or the saved chat title */
  sessionSubheading: string;
  selectedProviderLabel: string;
  selectedModel: string;
  sessionMode: SessionMode;
  isWizard?: boolean;
  isNexus?: boolean;
  /** True after first model-list fetch (so we can show "Disconnected" vs initial "Waiting"). */
  modelCatalogSettled: boolean;
  providerConnected: boolean;
  isStreaming: boolean;
  webSearch: boolean;
  onWebSearchChange: (next: boolean) => void;
  /** True while settings have not loaded yet */
  webSearchDisabled?: boolean;
  onInputChange: (value: string) => void;
  onAttachImages: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  /** Nexus relay only: footer progress while one teammate streams (live elapsed timer). */
  nexusRelayProgress?: { wizardName: string; segmentStartedAt: number } | null;
  /** Nexus relay only: allow Send during streaming (queues user turns for the next teammate). */
  nexusRelayQueueDuringStream?: boolean;
  onSend: () => void;
  onStop: () => void;
  /** Messages in the active thread (for rough context estimate). */
  chatMessages: ChatMessage[];
  /** Max context from model catalog, or a default when unknown. */
  contextLimit: number;
  /** Last API usage for this thread, if the provider reported it. */
  lastTokenUsage: ChatCompletionTokenUsage | null;
  /** Toggle Chat ↔ Agent; persisted with settings. */
  onSessionModeToggle: () => void;
  /** True while settings are not loaded (toggle no-ops). */
  sessionModeToggleDisabled?: boolean;
  /** Whether a workspace folder is currently open. */
  hasWorkspace: boolean;
  /** Terminal log output. */
  terminalLogs: string;
  /** Currently running terminal job id, if any. */
  terminalJobId?: string;
  onTerminalRun: (command: string) => void;
  onTerminalKill: () => void;
  /** Wizards tab with no wizard/session selected: show hub copy + create action instead of the thread. */
  wizardHubPlaceholder?: boolean;
  onOpenWizardCreator?: () => void;
}

const activityLabelMap = {
  info: 'Status',
  reasoning: 'Thinking',
  tool: 'Tool',
  command: 'Command',
  approval: 'Approval',
  warning: 'Warning',
  success: 'Update',
  finished: 'Finished',
  stopped: 'Stopped',
  error: 'Error'
} as const;

const hiddenActivityKinds = new Set<ChatActivity['kind']>(['info', 'finished', 'reasoning']);

/** Consecutive tool-flow steps; hidden kinds between them are skipped without breaking a run. */
const groupableActivityKinds = new Set<ChatActivity['kind']>(['tool', 'command', 'success', 'approval']);

type ActivityTimelineEntry = Extract<ChatTimelineEntry, { type: 'activity' }>;
type MessageTimelineEntry = Extract<ChatTimelineEntry, { type: 'message' }>;

type RenderChunk =
  | { type: 'message'; entry: MessageTimelineEntry }
  | { type: 'activity-solo'; entry: ActivityTimelineEntry }
  | { type: 'activity-group'; id: string; items: ActivityTimelineEntry[] };

function buildRenderChunks(timeline: ChatTimelineEntry[]): RenderChunk[] {
  const out: RenderChunk[] = [];
  let buffer: ActivityTimelineEntry[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      out.push({ type: 'activity-solo', entry: buffer[0]! });
    } else {
      out.push({ type: 'activity-group', id: `tool-group-${buffer[0]!.id}`, items: buffer });
    }
    buffer = [];
  };

  for (const entry of timeline) {
    if (entry.type === 'message') {
      flush();
      out.push({ type: 'message', entry });
      continue;
    }
    const { activity } = entry;
    if (hiddenActivityKinds.has(activity.kind)) {
      continue;
    }
    if (groupableActivityKinds.has(activity.kind)) {
      buffer.push(entry);
      continue;
    }
    flush();
    out.push({ type: 'activity-solo', entry });
  }
  flush();
  return out;
}

/** Shown as collapsible; start expanded for user-visible issues. */
const activityDetailsStartOpen = (kind: ChatActivity['kind']) =>
  kind === 'error' || kind === 'stopped' || kind === 'warning';

function CollapsibleActivityBlock({ activity, onDetailsToggle }: { activity: ChatActivity; onDetailsToggle?: () => void }) {
  const [open, setOpen] = useState(() => activityDetailsStartOpen(activity.kind));
  const label = activityLabelMap[activity.kind];
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="chat-activity-wrap"
      initial={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      <details
        className={`chat-activity chat-activity--collapsible chat-activity--${activity.kind}`}
        onToggle={(e) => {
          setOpen((e.currentTarget as HTMLDetailsElement).open);
          onDetailsToggle?.();
        }}
        open={open}
      >
        <summary className="chat-activity__summary">{label}</summary>
        <div className="chat-activity__body">
          <p>{activity.message}</p>
        </div>
      </details>
    </motion.div>
  );
}

function ToolActivityGroup({ items, onDetailsToggle }: { items: ActivityTimelineEntry[]; onDetailsToggle?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="chat-activity-wrap"
      initial={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      <details
        className="chat-activity chat-activity--collapsible chat-activity--grouped-tools"
        onToggle={(e) => {
          setOpen((e.currentTarget as HTMLDetailsElement).open);
          onDetailsToggle?.();
        }}
        open={open}
      >
        <summary className="chat-activity__summary">
          Tool activity · {items.length} steps
        </summary>
        <div className="chat-activity-group__list">
          {items.map((entry) => (
            <div
              className={`chat-activity-group__row chat-activity-group__row--${entry.activity.kind}`}
              key={entry.id}
            >
              <div className="chat-activity-group__row-label">{activityLabelMap[entry.activity.kind]}</div>
              <p className="chat-activity-group__row-text">{entry.activity.message}</p>
            </div>
          ))}
        </div>
      </details>
    </motion.div>
  );
}

/** Match ThinkingBlock motion.transition duration (+ small buffer). */
const THINKING_LAYOUT_MS = 240;

/** `data-thinking-layout-lock-until` on `.chat-scroll` blocks ResizeObserver auto-clamp mid-animation (prevents jitter). */
function ThinkingBlock({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false);
  const summaryRef = useRef<HTMLButtonElement>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    []
  );

  const handleToggleThinking = () => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    const summary = summaryRef.current;
    const scrollEl = summary?.closest('.chat-scroll') as HTMLElement | null;
    let beforeSummaryTop: number | undefined;

    const lockUntil = Date.now() + THINKING_LAYOUT_MS + 120;
    if (scrollEl) {
      scrollEl.dataset.thinkingLayoutLockUntil = String(lockUntil);
    }

    if (summary && scrollEl) {
      beforeSummaryTop = summary.getBoundingClientRect().top;
    }

    setOpen((v) => !v);

    if (beforeSummaryTop !== undefined && scrollEl) {
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        const s = summaryRef.current;
        if (!s?.isConnected || !scrollEl.isConnected) {
          delete scrollEl.dataset.thinkingLayoutLockUntil;
          return;
        }
        const afterSummaryTop = s.getBoundingClientRect().top;
        scrollEl.scrollTop += afterSummaryTop - beforeSummaryTop;
        delete scrollEl.dataset.thinkingLayoutLockUntil;
      }, THINKING_LAYOUT_MS + 40);
    }
  };

  return (
    <div className={`chat-thinking ${open ? 'is-open' : ''}`}>
      <button
        ref={summaryRef}
        className="chat-thinking__summary"
        onClick={() => {
          handleToggleThinking();
        }}
        type="button"
      >
        <span className="chat-thinking__chevron" aria-hidden>&#x25B6;</span>
        Thinking
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="thinking-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <pre className="chat-thinking__body">{reasoning}</pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function ChatPanel({
  timeline,
  input,
  attachments,
  sessionSubheading,
  selectedProviderLabel,
  selectedModel,
  sessionMode,
  isWizard = false,
  isNexus = false,
  modelCatalogSettled,
  providerConnected,
  isStreaming,
  webSearch,
  onWebSearchChange,
  webSearchDisabled = false,
  onInputChange,
  onAttachImages,
  onRemoveAttachment,
  onSend,
  onStop,
  chatMessages,
  contextLimit,
  lastTokenUsage,
  onSessionModeToggle,
  sessionModeToggleDisabled = false,
  hasWorkspace,
  terminalLogs,
  terminalJobId,
  onTerminalRun,
  onTerminalKill,
  wizardHubPlaceholder = false,
  onOpenWizardCreator,
  nexusRelayProgress = null,
  nexusRelayQueueDuringStream = false
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const copyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const contextUsedEstimate = useMemo(() => {
    const threadRough =
      roughTokensFromMessages(chatMessages) + DEFAULT_HIDDEN_SYSTEM_OVERHEAD_TOKENS;
    const draftRough = roughTokensForDraft(input, attachments);
    const rough = threadRough + draftRough;
    if (lastTokenUsage == null) return rough;
    return Math.max(rough, lastTokenUsage.totalTokens);
  }, [attachments, chatMessages, input, lastTokenUsage]);
  /** When true and the model grows the thread height, snap scroll only if still within epsilon of bottom. */
  const userPinnedToBottomRef = useRef(true);

  const scrollToBottomHard = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = getChatScrollMax(node);
    userPinnedToBottomRef.current = true;
  }, []);

  const clampOverscroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const maxScroll = getChatScrollMax(node);
    if (node.scrollTop > maxScroll) {
      node.scrollTop = maxScroll;
    }
  }, []);

  const maybeStickStreamingToBottom = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    clampOverscroll();
    if (!userPinnedToBottomRef.current) return;
    const target = getChatScrollMax(node);
    if (Math.abs(node.scrollTop - target) > 1) {
      node.scrollTop = target;
    }
  }, [clampOverscroll]);

  const clampAndMaybeStickToBottom = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    clampOverscroll();
    if (userPinnedToBottomRef.current) {
      scrollToBottomHard();
    }
  }, [clampOverscroll, scrollToBottomHard]);

  const afterScrollLayout = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        clampAndMaybeStickToBottom();
      });
    });
  }, [clampAndMaybeStickToBottom]);

  /** Collapsible <details> toggles (Thinking, tool blocks) do not change React state; the scroll range can go stale. */
  const afterCollapsibleLayout = useCallback(() => {
    afterScrollLayout();
  }, [afterScrollLayout]);

  const handleScroll = useCallback(() => {
    const n = scrollRef.current;
    if (!n) return;
    userPinnedToBottomRef.current = distanceFromChatBottom(n) <= CHAT_BOTTOM_STICK_EPSILON_PX;
  }, []);

  /** Stop chasing the stream the instant the user scrolls upward (wheel / trackpad), before scrollTop updates. */
  const handleWheelCapture = useCallback((e: WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      userPinnedToBottomRef.current = false;
    }
  }, []);

  const handleCopyMessage = useCallback(async (messageId: string, rawContent: string) => {
    const text = getCopyableMessageText(rawContent);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
      setCopiedMessageId(messageId);
      copyToastTimerRef.current = setTimeout(() => {
        setCopiedMessageId((cur) => (cur === messageId ? null : cur));
        copyToastTimerRef.current = null;
      }, 2000);
    } catch {
      // Clipboard may be denied in some environments
    }
  }, []);

  useEffect(() => {
    return () => {
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
    };
  }, []);

  /** Stable keys so streaming token updates don't re-trigger layout scroll logic. */
  const threadHeadKey = timeline.length === 0 ? '__empty__' : timeline[0]!.id;
  const timelineTailKey =
    timeline.length === 0 ? '__empty__' : `${timeline[timeline.length - 1]!.type}:${timeline[timeline.length - 1]!.id}`;
  const threadHeadKeyPrevRef = useRef<string | null>(null);
  const timelineTailKeyPrevRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    if (threadHeadKeyPrevRef.current !== threadHeadKey) {
      threadHeadKeyPrevRef.current = threadHeadKey;
      timelineTailKeyPrevRef.current = timelineTailKey;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToBottomHard();
        });
      });
      return;
    }

    const prevTail = timelineTailKeyPrevRef.current;
    timelineTailKeyPrevRef.current = timelineTailKey;

    if (
      timelineTailKey !== '__empty__' &&
      prevTail !== null &&
      timelineTailKey !== prevTail &&
      userPinnedToBottomRef.current
    ) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToBottomHard();
        });
      });
    }
  }, [scrollToBottomHard, threadHeadKey, timelineTailKey]);

  useEffect(() => {
    const inner = innerRef.current;
    const scroll = scrollRef.current;
    if (!inner || !scroll) return;

    let raf = 0;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const scheduleClamp = () => {
      const lockUntilRaw = scroll.dataset.thinkingLayoutLockUntil;
      if (lockUntilRaw != null && lockUntilRaw !== '' && Number(lockUntilRaw) > Date.now()) {
        return;
      }

      if (isStreaming) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          raf = 0;
          maybeStickStreamingToBottom();
        });
        return;
      }

      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = undefined;
        requestAnimationFrame(() => {
          clampAndMaybeStickToBottom();
        });
      }, 100);
    };

    const ro = new ResizeObserver(() => {
      scheduleClamp();
    });
    ro.observe(inner);
    ro.observe(scroll);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      if (debounce) clearTimeout(debounce);
    };
  }, [clampAndMaybeStickToBottom, isStreaming, maybeStickStreamingToBottom]);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [input, autoResize]);

  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalInput, setTerminalInput] = useState('');
  const terminalLogRef = useRef<HTMLPreElement>(null);
  const [workspaceGateNotice, setWorkspaceGateNotice] = useState<string | null>(null);
  const workspaceGateNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissWorkspaceGateNotice = useCallback(() => {
    if (workspaceGateNoticeTimerRef.current) {
      clearTimeout(workspaceGateNoticeTimerRef.current);
      workspaceGateNoticeTimerRef.current = null;
    }
    setWorkspaceGateNotice(null);
  }, []);

  const showWorkspaceGateNotice = useCallback(
    (message: string) => {
      if (workspaceGateNoticeTimerRef.current) {
        clearTimeout(workspaceGateNoticeTimerRef.current);
        workspaceGateNoticeTimerRef.current = null;
      }
      setWorkspaceGateNotice(message);
      workspaceGateNoticeTimerRef.current = setTimeout(() => {
        setWorkspaceGateNotice(null);
        workspaceGateNoticeTimerRef.current = null;
      }, 10_000);
    },
    []
  );

  useEffect(
    () => () => {
      if (workspaceGateNoticeTimerRef.current) {
        clearTimeout(workspaceGateNoticeTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (hasWorkspace && workspaceGateNotice) {
      dismissWorkspaceGateNotice();
    }
  }, [hasWorkspace, workspaceGateNotice, dismissWorkspaceGateNotice]);

  useEffect(() => {
    if (terminalLogRef.current) {
      terminalLogRef.current.scrollTop = terminalLogRef.current.scrollHeight;
    }
  }, [terminalLogs]);

  const handleTerminalToggle = useCallback(() => {
    if (!hasWorkspace) {
      showWorkspaceGateNotice(
        'Open a workspace from the sidebar first. The terminal runs commands in your project folder.'
      );
      return;
    }
    setTerminalOpen((v) => !v);
  }, [hasWorkspace, showWorkspaceGateNotice]);

  const isTalk = !isWizard && !isNexus && sessionMode === 'talk';

  const statusLabel = isStreaming
    ? 'Working'
    : providerConnected
      ? 'Connected'
      : modelCatalogSettled
        ? 'Disconnected'
        : 'Waiting';

  const statusModifierClass = isStreaming || providerConnected ? 'is-live' : modelCatalogSettled ? 'is-disconnected' : '';

  const renderChunks = useMemo(() => buildRenderChunks(timeline), [timeline]);

  return (
    <section className="chat-panel">
      <div className="chat-panel__header">
        <div className="chat-panel__header-left">
          <div className="chat-panel__header-titles">
            {isWizard || isNexus ? (
              <div
                className={`chat-panel__wizard-pill ${isNexus ? 'chat-panel__wizard-pill--nexus' : ''}`}
                title={isNexus ? 'Nexus projects coordinate multiple Wizards in a shared workspace' : 'Wizards always work with tools and their own workspace'}
              >
                {isNexus ? 'Nexus' : 'Wizard'}
              </div>
            ) : (
              <div className={`chat-panel__mode-toggle ${sessionModeToggleDisabled ? 'is-disabled' : ''}`}>
                <button
                  className={`chat-panel__mode-option ${isTalk ? 'is-active' : ''}`}
                  disabled={sessionModeToggleDisabled}
                  onClick={() => { if (!isTalk) onSessionModeToggle(); }}
                  title="Chat mode (no tools)"
                  type="button"
                >
                  Chat
                </button>
                <button
                  className={`chat-panel__mode-option ${!isTalk ? 'is-active' : ''}`}
                  disabled={sessionModeToggleDisabled}
                  onClick={() => { if (isTalk) onSessionModeToggle(); }}
                  title="Agent mode (tools & workspace)"
                  type="button"
                >
                  Agent
                </button>
                <span
                  className="chat-panel__mode-slider"
                  style={{ transform: isTalk ? 'translateX(0)' : 'translateX(100%)' }}
                />
              </div>
            )}
            <span className="chat-panel__model">{selectedModel || 'No model selected'}</span>
          </div>
          <span className="chat-panel__session" title={sessionSubheading}>
            {sessionSubheading}
          </span>
        </div>
        <div className="chat-panel__header-right">
          <label
            className={`chat-panel__web-toggle ${webSearchDisabled ? 'is-disabled' : ''} ${webSearch ? 'is-on' : ''}`}
            title="Allow the model to call web_search in Chat or Agent"
          >
            <input
              checked={webSearch}
              disabled={webSearchDisabled}
              onChange={(e) => onWebSearchChange(e.target.checked)}
              type="checkbox"
            />
            <span className="chat-panel__web-toggle-track">
              <span className="chat-panel__web-toggle-knob" />
            </span>
            <span>Web</span>
          </label>
          <div
            className={['chat-panel__status', statusModifierClass].filter(Boolean).join(' ')}
          >
            <span className="chat-panel__status-dot" />
            {statusLabel}
          </div>
        </div>
      </div>

      {wizardHubPlaceholder ? (
        <div
          className="chat-scroll wizard-hub-scroll"
          onScroll={handleScroll}
          onWheelCapture={handleWheelCapture}
          ref={scrollRef}
        >
          <div className="chat-scroll__inner wizard-hub-scroll__inner" ref={innerRef}>
            <div className="chat-empty wizard-hub-empty">
              <div className="chat-empty__icon chat-empty__icon--wizard-hat" aria-hidden>
                <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
                  <path
                    d="M22 7L36 37H8L22 7z"
                    stroke="currentColor"
                    strokeWidth="1.45"
                    strokeLinejoin="round"
                  />
                  <circle cx="22" cy="23" r="2.35" fill="currentColor" opacity={0.22} />
                  <path
                    d="M4 37.75c5-5.2 13-8 18-8s13 2.85 18 8"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <h3 className="chat-empty__title">Select a wizard to get started</h3>
              <p className="chat-empty__desc wizard-hub-desc">
                Pick one from the list on the left,
                <br />
                or create one{' '}
                <button type="button" className="wizard-hub-desc__here" onClick={() => onOpenWizardCreator?.()}>
                  here
                </button>
                .
              </p>
            </div>
            <div aria-hidden className="chat-scroll__bottom" ref={bottomRef} />
          </div>
        </div>
      ) : (
        <>
      <div className="chat-scroll" onScroll={handleScroll} onWheelCapture={handleWheelCapture} ref={scrollRef}>
        <div className="chat-scroll__inner" ref={innerRef}>
        {timeline.length === 0 ? (
          <div className="chat-empty chat-empty--thread-start">
            <div className="chat-empty__icon">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <rect x="4" y="6" width="24" height="18" rx="4" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M4 12h24M10 18h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <h3 className="chat-empty__title">
              {isNexus ? 'Nexus ready' : isWizard ? 'Wizard ready' : isTalk ? 'Start a conversation' : 'Ready to build'}
            </h3>
            <p className="chat-empty__desc">
              {providerConnected
                ? isTalk
                  ? 'You\'re in Chat mode. Ask anything or switch to Agent for tools and file access.'
                  : isNexus
                    ? 'The leader Wizard can plan with its team and work in the shared Nexus workspace.'
                  : isWizard
                    ? 'This Wizard is connected to its own local workspace and memory documents.'
                  : `${selectedProviderLabel} is connected. Ask for code, architecture, or refactors.`
                : 'Connect in Settings → Connection, then pick a model.'}
            </p>
          </div>
        ) : null}

        {renderChunks.map((chunk) => {
          if (chunk.type === 'activity-group') {
            return <ToolActivityGroup key={chunk.id} items={chunk.items} onDetailsToggle={afterCollapsibleLayout} />;
          }
          if (chunk.type === 'activity-solo') {
            return (
              <CollapsibleActivityBlock
                key={chunk.entry.id}
                activity={chunk.entry.activity}
                onDetailsToggle={afterCollapsibleLayout}
              />
            );
          }

          const { entry } = chunk;
          const { message } = entry;
          if (
            message.role === 'assistant' &&
            message.status === 'streaming' &&
            !message.content.trim() &&
            !message.attachments?.length &&
            !message.reasoning?.trim()
          ) {
            return null;
          }

          return (
            <motion.article
              animate={{ opacity: 1, y: 0 }}
              className={`chat-bubble chat-bubble--${message.role}`}
              initial={{ opacity: 0, y: 8 }}
              key={entry.id}
              transition={{ duration: 0.22, ease: 'easeOut' }}
            >
              <header className="chat-bubble__header">
                <span className="chat-bubble__header-title">
                  {message.role === 'user'
                    ? 'You'
                    : message.assistantDisplayName?.trim() || 'Assistant'}
                </span>
                {getCopyableMessageText(message.content).length > 0 ? (
                  <button
                    className={`chat-bubble__copy${copiedMessageId === entry.id ? ' is-done' : ''}`}
                    aria-label={copiedMessageId === entry.id ? 'Copied' : 'Copy message'}
                    title={copiedMessageId === entry.id ? 'Copied' : 'Copy'}
                    type="button"
                    onClick={() => void handleCopyMessage(entry.id, message.content)}
                  >
                    <CopyMessageIcon copied={copiedMessageId === entry.id} />
                  </button>
                ) : null}
              </header>
              {message.role === 'assistant' && message.reasoning?.trim() ? (
                <ThinkingBlock reasoning={message.reasoning.trim()} />
              ) : null}
              {message.attachments?.length ? (
                <div className="chat-attachments">
                  {message.attachments.map((att) => (
                    <figure className="chat-attachment" key={att.id}>
                      <img alt={att.name} src={att.dataUrl} />
                      <figcaption>{att.name}</figcaption>
                    </figure>
                  ))}
                </div>
              ) : null}
              {message.content !== '' || message.status === 'done' || message.status === 'error' ? (
                <div className="chat-bubble__text">
                  {message.role === 'assistant' ? (
                    <AssistantMessageContent
                      onSessionModeToggle={onSessionModeToggle}
                      onWebSearchChange={onWebSearchChange}
                      sessionMode={sessionMode}
                      sessionModeToggleDisabled={sessionModeToggleDisabled}
                      text={message.content}
                      webSearch={webSearch}
                      webSearchDisabled={webSearchDisabled}
                    />
                  ) : (
                    <ChatMarkdown text={getCopyableMessageText(message.content)} />
                  )}
                </div>
              ) : null}
            </motion.article>
          );
        })}
        <div aria-hidden className="chat-scroll__bottom" ref={bottomRef} />
        </div>
      </div>

      <AnimatePresence initial={false}>
        {terminalOpen && (
          <motion.div
            key="inline-terminal"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div className="chat-terminal">
              <div className="chat-terminal__header">
                <span className="chat-terminal__title">Terminal</span>
                <div className="chat-terminal__actions">
                  {terminalJobId && (
                    <button
                      className="chat-terminal__kill"
                      onClick={onTerminalKill}
                      type="button"
                      title="Stop"
                    >
                      Stop
                    </button>
                  )}
                  <button
                    className="chat-terminal__close"
                    onClick={() => setTerminalOpen(false)}
                    type="button"
                    title="Close terminal"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  </button>
                </div>
              </div>
              <pre ref={terminalLogRef} className="chat-terminal__log">
                {terminalLogs || 'No output yet.\n'}
              </pre>
              <div className="chat-terminal__input-bar">
                <span className="chat-terminal__prompt">&gt;_</span>
                <input
                  className="chat-terminal__input"
                  value={terminalInput}
                  onChange={(e) => setTerminalInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && terminalInput.trim()) {
                      onTerminalRun(terminalInput);
                      setTerminalInput('');
                    }
                  }}
                  placeholder="Enter command..."
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="chat-compose">
        {nexusRelayProgress ? <NexusRelayProgressBar {...nexusRelayProgress} /> : null}
        {workspaceGateNotice ? (
          <div className="chat-compose__notice" role="alert">
            <p className="chat-compose__notice-text">{workspaceGateNotice}</p>
            <button
              type="button"
              className="chat-compose__notice-dismiss"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={dismissWorkspaceGateNotice}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ) : null}
        {attachments.length ? (
          <div className="composer-attachments">
            {attachments.map((att) => (
              <div className="composer-attachment" key={att.id}>
                <img alt={att.name} src={att.dataUrl} />
                <span>{att.name}</span>
                <button onClick={() => onRemoveAttachment(att.id)} type="button">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="chat-compose__bar">
          <label className="chat-compose__attach" title="Attach images">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14 10l-3.5-3.5a2 2 0 00-2.83 0L2 12M14 10v4H2v-2M14 10V5a2 2 0 00-2-2H4a2 2 0 00-2 2v7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/><circle cx="5.5" cy="6.5" r="1.5" stroke="currentColor" strokeWidth="1.3"/></svg>
            <input
              accept="image/*"
              multiple
              onChange={(e) => { onAttachImages(e.target.files); e.target.value = ''; }}
              type="file"
            />
          </label>
          <textarea
            ref={textareaRef}
            className="chat-compose__input"
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const canSend =
                  !isStreaming ||
                  (nexusRelayQueueDuringStream && (input.trim().length > 0 || attachments.length > 0));
                if (canSend) {
                  onSend();
                }
              }
            }}
            placeholder="Type a message..."
            rows={1}
            value={input}
          />
          <ChatContextMeter limit={contextLimit} used={contextUsedEstimate} />
          <button
            className={`chat-compose__terminal-toggle ${terminalOpen ? 'is-active' : ''}`}
            onClick={handleTerminalToggle}
            type="button"
            title={terminalOpen ? 'Close terminal' : 'Open terminal'}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M9 12h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
          {isStreaming ? (
            <>
              {nexusRelayQueueDuringStream ? (
                <button
                  className="chat-compose__send chat-compose__send--alongside-stop"
                  disabled={input.trim().length === 0 && attachments.length === 0}
                  onClick={onSend}
                  type="button"
                  title="Queue message for next teammate turn"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M14 2L7 9M14 2l-5 12-2-5-5-2 12-5z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ) : null}
              <button className="chat-compose__stop" onClick={onStop} type="button" title="Stop">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            </>
          ) : (
            <button
              className="chat-compose__send"
              disabled={input.trim().length === 0 && attachments.length === 0}
              onClick={onSend}
              type="button"
              title="Send"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14 2L7 9M14 2l-5 12-2-5-5-2 12-5z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          )}
        </div>
      </div>
        </>
      )}
    </section>
  );
}

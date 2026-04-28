import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { OPENKIWI_SESSION_MODE_TOGGLE, OPENKIWI_WEB_SEARCH_TOGGLE } from '@shared/openkiwi-embeds';
import { AssistantMessageContent } from './AssistantMessageContent';
import { ChatMarkdown } from './ChatMarkdown';

function getCopyableMessageText(content: string): string {
  return content
    .replaceAll(OPENKIWI_SESSION_MODE_TOGGLE, '')
    .replaceAll(OPENKIWI_WEB_SEARCH_TOGGLE, '')
    .trim();
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

function ThinkingBlock({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`chat-thinking ${open ? 'is-open' : ''}`}>
      <button
        className="chat-thinking__summary"
        onClick={() => {
          setOpen((v) => !v);
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
  sessionModeToggleDisabled = false
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
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
  /** User is within this many px of the bottom, or we just forced scroll (e.g. new content). */
  const userNearBottomRef = useRef(true);

  const clampAndMaybeStickToBottom = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const max = Math.max(0, node.scrollHeight - node.clientHeight);
    if (node.scrollTop > max) {
      node.scrollTop = max;
    }
    if (userNearBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, []);

  /** Collapsible <details> toggles (Thinking, tool blocks) do not change React state; the scroll range can go stale. */
  const afterCollapsibleLayout = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        clampAndMaybeStickToBottom();
      });
    });
  }, [clampAndMaybeStickToBottom]);

  const handleScroll = useCallback(() => {
    const n = scrollRef.current;
    if (!n) return;
    const nearBottom = n.scrollHeight - n.clientHeight - n.scrollTop < 120;
    userNearBottomRef.current = nearBottom;
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

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const n = scrollRef.current;
        if (!n) return;
        n.scrollTop = n.scrollHeight;
        userNearBottomRef.current = true;
      });
    });
  }, [timeline, isStreaming]);

  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    /** Batched scroll fix: avoid pinning “to bottom” on every sub-frame of a height animation (e.g. Thinking collapse) — that fight causes the bubble to shudder. */
    let raf = 0;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const scheduleClamp = () => {
      if (isStreaming) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          raf = 0;
          clampAndMaybeStickToBottom();
        });
        return;
      }
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(
        () => {
          debounce = undefined;
          requestAnimationFrame(() => {
            clampAndMaybeStickToBottom();
          });
        },
        100
      );
    };
    const ro = new ResizeObserver(() => {
      scheduleClamp();
    });
    ro.observe(inner);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      if (debounce) clearTimeout(debounce);
    };
  }, [clampAndMaybeStickToBottom, isStreaming, timeline.length]);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [input, autoResize]);

  const isTalk = sessionMode === 'talk';

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

      <div className="chat-scroll" onScroll={handleScroll} ref={scrollRef}>
        <div className="chat-scroll__inner" ref={innerRef}>
        {timeline.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty__icon">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <rect x="4" y="6" width="24" height="18" rx="4" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M4 12h24M10 18h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <h3 className="chat-empty__title">
              {isTalk ? 'Start a conversation' : 'Ready to build'}
            </h3>
            <p className="chat-empty__desc">
              {providerConnected
                ? isTalk
                  ? 'You\'re in Chat mode. Ask anything or switch to Agent for tools and file access.'
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
                <span className="chat-bubble__header-title">{message.role === 'user' ? 'You' : 'Assistant'}</span>
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
                    <ChatMarkdown
                      text={message.content
                        .replaceAll(OPENKIWI_SESSION_MODE_TOGGLE, '')
                        .replaceAll(OPENKIWI_WEB_SEARCH_TOGGLE, '')}
                    />
                  )}
                </div>
              ) : null}
            </motion.article>
          );
        })}
        </div>
      </div>

      <div className="chat-compose">
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
                if (!isStreaming) {
                  onSend();
                }
              }
            }}
            placeholder="Type a message..."
            rows={1}
            value={input}
          />
          <ChatContextMeter limit={contextLimit} used={contextUsedEstimate} />
          {isStreaming ? (
            <button className="chat-compose__stop" onClick={onStop} type="button" title="Stop">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor"/></svg>
            </button>
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
    </section>
  );
}

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactElement, type WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import type {
  ChatActivity,
  ChatAttachment,
  ChatCompletionTokenUsage,
  ChatMessage,
  ChatTimelineEntry,
  ModelInfo,
  OpenRouterReasoningEffort,
  ProviderKind,
  SessionMode
} from '@shared/types';
import {
  DEFAULT_HIDDEN_SYSTEM_OVERHEAD_TOKENS,
  roughTokensForDraft,
  roughTokensFromMessages
} from '@renderer/lib/estimate-context-tokens';
import { ALL_EMBED_STRIP_STRINGS } from '@shared/mythra-embeds';
import { isChartDetailsLayoutLocked } from '@renderer/lib/chart-details-scroll';
import { AssistantMessageContent } from './AssistantMessageContent';
import { ChatMarkdown } from './ChatMarkdown';

/** How close to the true bottom counts as “pinned” for auto-follow while the model streams. */
const CHAT_BOTTOM_STICK_EPSILON_PX = 4;
const CHAT_VIRTUALIZATION_THRESHOLD = 80;
const CHAT_VIRTUALIZATION_OVERSCAN_PX = 1200;
const CHAT_VIRTUALIZATION_DEFAULT_ROW_PX = 170;
const CHAT_VIRTUALIZATION_GAP_PX = 8;
const IMAGE_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;

export interface ChatMentionOption {
  id: string;
  name: string;
  role?: 'leader' | 'member';
}

export interface ChatContextMeterOption {
  id: string;
  name: string;
  role?: 'leader' | 'member';
  limit: number;
  model?: string;
  providerLabel?: string;
}

interface MentionTrigger {
  start: number;
  end: number;
  query: string;
}

const reasoningEffortOptions: Array<{ value: OpenRouterReasoningEffort; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: 'Use the model default' },
  { value: 'none', label: 'Off', hint: 'Disable reasoning' },
  { value: 'minimal', label: 'Minimal', hint: 'Small reasoning budget' },
  { value: 'low', label: 'Low', hint: 'Light reasoning' },
  { value: 'medium', label: 'Medium', hint: 'Balanced reasoning' },
  { value: 'high', label: 'High', hint: 'Deeper reasoning' },
  { value: 'xhigh', label: 'XHigh', hint: 'Maximum reasoning' }
];

function reasoningEffortLabel(value: OpenRouterReasoningEffort): string {
  return reasoningEffortOptions.find((option) => option.value === value)?.label ?? 'Auto';
}

function findMentionTrigger(value: string, caret: number): MentionTrigger | null {
  const beforeCaret = value.slice(0, caret);
  const at = beforeCaret.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/[\s([{]/.test(value[at - 1] ?? '')) return null;
  const query = beforeCaret.slice(at + 1);
  if (query.includes('@') || query.includes('\n')) return null;
  return { start: at, end: caret, query };
}

function normalizedMentionText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function mentionHighlightRanges(value: string, options: ChatMentionOption[]) {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const option of options) {
    const name = option.name.trim();
    if (name.length < 2) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`@${escaped}(?=$|\\s|[,:;.!?])`, 'gi');
    for (const match of value.matchAll(pattern)) {
      const start = match.index ?? 0;
      ranges.push({ start, end: start + match[0].length });
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && range.start < prev.end) continue;
    merged.push(range);
  }
  return merged;
}

type NexusRelayProgress = {
  requestId: string;
  wizardName: string;
  segmentStartedAt: number;
  phase: 'responding' | 'routing';
};

function NexusRelayProgressBar(props: NexusRelayProgress) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, [props.segmentStartedAt, props.wizardName, props.phase]);
  const sec = Math.max(0, Math.floor((Date.now() - props.segmentStartedAt) / 1000));
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  const elapsed = mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${sec}s`;
  const isRouting = props.phase === 'routing';

  return (
    <div className={`chat-compose__relay-status ${isRouting ? 'is-routing' : ''}`} role="status">
      <span className="chat-compose__relay-pulse" aria-hidden />
      <span className="chat-compose__relay-primary">
        <strong>{props.wizardName}</strong>
        <span className="chat-compose__relay-muted">
          {isRouting ? ' · choosing next wizard' : ' · responding'}
        </span>
      </span>
      <span className="chat-compose__relay-elapsed">{elapsed}</span>
      <span className="chat-compose__relay-hint">
        {isRouting ? (
          <>
            Deciding whether another teammate should speak next. You can queue a follow-up or name someone (
            <strong>@WizardName</strong> or their display name) to route the next reply.
          </>
        ) : (
          <>
            Still working — queue a message for the next teammate. Name someone (<strong>@WizardName</strong> or their display name) so Mythra routes the next reply to them.
          </>
        )}
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

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_FILE_EXT_RE.test(file.name);
}

function hasFileDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function parseSubmittedQuizSelections(content: string): Record<number, number> | null {
  if (!content.trimStart().startsWith('Quiz answers:')) return null;
  const selected: Record<number, number> = {};
  const answerRe = /^Answer:\s*([A-H?])\./gim;
  let questionIndex = 0;
  for (let match = answerRe.exec(content); match; match = answerRe.exec(content)) {
    const label = match[1]?.toUpperCase();
    if (label && label !== '?') {
      selected[questionIndex] = label.charCodeAt(0) - 65;
    }
    questionIndex += 1;
  }
  return Object.keys(selected).length > 0 ? selected : null;
}

function completedQuizSelectionsAfterMessage(messages: ChatMessage[], assistantMessageId: string): Record<number, Record<number, number>> | undefined {
  const messageIndex = messages.findIndex((message) => message.id === assistantMessageId);
  if (messageIndex < 0) return undefined;
  for (let i = messageIndex + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) break;
    if (message.role === 'assistant') return undefined;
    if (message.role !== 'user') continue;
    const selected = parseSubmittedQuizSelections(message.content);
    return selected ? { 0: selected } : undefined;
  }
  return undefined;
}

function attachmentKind(mimeType: string): 'image' | 'video' | 'audio' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

function AttachmentPreview({ attachment, compact = false }: { attachment: ChatAttachment; compact?: boolean }) {
  const kind = attachmentKind(attachment.mimeType);
  const label = attachment.name || 'Attachment';
  const saveAttachment = () => {
    void window.electronAPI.saveGeneratedMedia(attachment.dataUrl, label, attachment.filePath);
  };
  const openImagePreview = () => {
    if (kind !== 'image') return;
    void window.electronAPI.openGeneratedImage(attachment.dataUrl, label, attachment.mimeType, attachment.filePath);
  };
  if (compact) {
    return (
      <>
        {kind === 'image' ? <img alt={label} src={attachment.dataUrl} /> : null}
        {kind === 'video' ? <video muted preload="metadata" src={attachment.dataUrl} /> : null}
        {kind === 'audio' ? <span className="composer-attachment__icon">Audio</span> : null}
        {kind === 'file' ? <span className="composer-attachment__icon">File</span> : null}
      </>
    );
  }

  return (
    <figure className={`chat-attachment chat-attachment--${kind}`}>
      <div className="chat-attachment__preview">
        {kind === 'image' ? (
          <button className="chat-attachment__image-button" onClick={openImagePreview} title="Open full size" type="button">
            <img alt={label} src={attachment.dataUrl} />
          </button>
        ) : null}
        {kind === 'video' ? <video controls preload="metadata" src={attachment.dataUrl} /> : null}
        {kind === 'audio' ? <audio controls preload="metadata" src={attachment.dataUrl} /> : null}
        {kind === 'file' ? <span className="chat-attachment__file-icon">File</span> : null}
      </div>
      <figcaption title={label}>{label}</figcaption>
      <div className="chat-attachment__actions">
        <button onClick={saveAttachment} type="button">
          Save
        </button>
      </div>
    </figure>
  );
}

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatTokensExact(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString();
}

function formatUsdEstimate(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  if (value === 0) return '$0.00';
  if (value < 0.000001) return '<$0.000001';
  if (value < 0.01) return `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function messageCostTitle(cost: NonNullable<ChatMessage['costEstimate']>): string {
  return [
    `Estimated response cost: ${cost.display}`,
    `Model: ${cost.model}`,
    `Input/context/tool tokens: ${formatTokensExact(cost.inputTokens)}`,
    `Completion tokens: ${formatTokensExact(cost.outputTokens)}`,
    cost.reasoningTokens != null ? `Reasoning tokens: ${formatTokensExact(cost.reasoningTokens)}` : null,
    `Total reported tokens: ${formatTokensExact(cost.totalTokens)}`,
    cost.note
  ]
    .filter(Boolean)
    .join('\n');
}

interface DraftCostTooltip {
  heading: string;
  rows: Array<{ label: string; value: string }>;
  note: string;
  title: string;
  unavailable?: boolean;
}

function ChatContextMeter({
  used,
  limit,
  options = []
}: {
  used: number;
  limit: number;
  options?: ChatContextMeterOption[];
}) {
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const selectedOption = options.find((option) => option.id === selectedOptionId) ?? options[0] ?? null;
  const activeLimit = selectedOption?.limit ?? limit;
  const safeLimit = Math.max(activeLimit, 1);
  const usedRounded = Math.max(0, Math.round(used));
  const available = Math.max(0, safeLimit - usedRounded);
  const pct = Math.min(100, Math.max(0, (usedRounded / safeLimit) * 100));
  const r = 9;
  const c = 2 * Math.PI * r;
  const dashOffset = c * (1 - pct / 100);
  const activeName = selectedOption?.name ?? 'Current chat';
  const activeRole = selectedOption?.role === 'leader' ? 'Leader' : selectedOption?.role === 'member' ? 'Member' : null;
  const ariaSummary = `${activeName}: ${pct.toFixed(1)}% context used. ${formatTokensExact(usedRounded)} of ${formatTokensExact(safeLimit)} tokens.`;
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
    if (options.length === 0) {
      setSelectedOptionId(null);
      return;
    }
    setSelectedOptionId((current) => (current && options.some((option) => option.id === current) ? current : options[0]!.id));
  }, [options]);

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
    typeof document !== 'undefined' &&
    createPortal(
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="chat-context-meter__popup"
            exit={{ opacity: 0 }}
            id={tooltipId}
            initial={{ opacity: 0 }}
            onMouseEnter={handleOpen}
            onMouseLeave={handleScheduleClose}
            role="tooltip"
            style={{
              left: anchor.left,
              top: anchor.top - 8,
              transform: 'translate(-50%, -100%)'
            }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
          >
            <div className="chat-context-meter__popup-inner">
              <div className="chat-context-meter__heading">
                <span className="chat-context-meter__label">Viewing</span>
                <span className="chat-context-meter__name">
                  {activeName}
                  {activeRole ? <span>{activeRole}</span> : null}
                </span>
              </div>
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
                {selectedOption?.model ? (
                  <>
                    <br />
                    {selectedOption.providerLabel ? `${selectedOption.providerLabel} · ` : ''}
                    {selectedOption.model}
                  </>
                ) : null}
              </div>
              {options.length > 1 ? (
                <div className="chat-context-meter__options" aria-label="Choose wizard context display">
                  {options.map((option) => {
                    const optionLimit = Math.max(option.limit, 1);
                    const optionPct = Math.min(100, Math.max(0, (usedRounded / optionLimit) * 100));
                    return (
                      <button
                        className={`chat-context-meter__option ${option.id === selectedOption?.id ? 'is-active' : ''}`}
                        key={option.id}
                        onClick={() => setSelectedOptionId(option.id)}
                        type="button"
                      >
                        <span className="chat-context-meter__option-name">
                          {option.name}
                          {option.role === 'leader' ? <span>Leader</span> : null}
                        </span>
                        <span className="chat-context-meter__option-value">{optionPct.toFixed(0)}%</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>,
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

function OpenRouterReasoningButton({
  effort,
  model,
  supported,
  disabled,
  onChange
}: {
  effort: OpenRouterReasoningEffort;
  model: string;
  supported: boolean;
  disabled: boolean;
  onChange: (effort: OpenRouterReasoningEffort) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  const currentLabel = reasoningEffortLabel(effort);
  const unavailable = disabled || !supported;

  const updateAnchor = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    setAnchor({ top: b.top, left: b.left + b.width / 2 });
  }, []);

  const toggleOpen = useCallback(() => {
    if (unavailable) return;
    updateAnchor();
    setOpen((value) => !value);
  }, [unavailable, updateAnchor]);

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
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || popoverRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const popover =
    open &&
    typeof document !== 'undefined' &&
    createPortal(
      <div
        ref={popoverRef}
        className="chat-reasoning-popover"
        role="menu"
        style={{
          left: anchor.left,
          top: anchor.top - 8,
          transform: 'translate(-50%, -100%)'
        }}
      >
        <div className="chat-reasoning-popover__header">
          <strong>Reasoning</strong>
          <span>{model}</span>
        </div>
        <div className="chat-reasoning-popover__options">
          {reasoningEffortOptions.map((option) => (
            <button
              className={`chat-reasoning-popover__option ${effort === option.value ? 'is-active' : ''}`}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              role="menuitemradio"
              aria-checked={effort === option.value}
              type="button"
            >
              <span>{option.label}</span>
              <small>{option.hint}</small>
            </button>
          ))}
        </div>
      </div>,
      document.body
    );

  return (
    <>
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-label={`OpenRouter reasoning: ${currentLabel}`}
        className={`chat-compose__reasoning ${effort !== 'auto' ? 'is-active' : ''}`}
        disabled={unavailable}
        onClick={toggleOpen}
        title={
          supported
            ? `OpenRouter reasoning: ${currentLabel}`
            : 'This OpenRouter model does not advertise reasoning controls'
        }
        type="button"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M9 18h6M10 22h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path
            d="M8.2 14.5c-1.4-1.1-2.2-2.7-2.2-4.5a6 6 0 1112 0c0 1.8-.8 3.4-2.2 4.5-.7.6-.8 1.3-.8 2H9c0-.7-.1-1.4-.8-2z"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
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
  selectedProviderKind: ProviderKind;
  selectedModel: string;
  modelPricing?: ModelInfo['pricing'];
  openRouterReasoningEffort: OpenRouterReasoningEffort;
  openRouterReasoningSupported: boolean;
  onOpenRouterReasoningEffortChange: (effort: OpenRouterReasoningEffort) => void;
  openRouterCredits?: HeaderCreditsDisplay | null;
  showModelOutputCosts: boolean;
  sessionMode: SessionMode;
  isWizard?: boolean;
  isNexus?: boolean;
  /** True after first model-list fetch (so we can show "Disconnected" vs initial "Waiting"). */
  modelCatalogSettled: boolean;
  providerConnected: boolean;
  isStreaming: boolean;
  composerDisabled?: boolean;
  composerDisabledPlaceholder?: string;
  webSearch: boolean;
  onWebSearchChange: (next: boolean) => void;
  /** True while settings have not loaded yet */
  webSearchDisabled?: boolean;
  onInputChange: (value: string) => void;
  mentionOptions?: ChatMentionOption[];
  onAttachImages: (files: FileList | File[] | null) => void;
  onRemoveAttachment: (id: string) => void;
  /** Nexus relay only: footer progress while one teammate streams (live elapsed timer). */
  nexusRelayProgress?: NexusRelayProgress | null;
  /** Nexus relay only: allow Send during streaming (queues user turns for the next teammate). */
  nexusRelayQueueDuringStream?: boolean;
  onSend: () => void;
  onSubmitQuizAnswers: (answersText: string) => void;
  onStop: () => void;
  /** Messages in the active thread (for rough context estimate). */
  chatMessages: ChatMessage[];
  /** Max context from model catalog, or a default when unknown. */
  contextLimit: number;
  /** Nexus-only: alternate wizard context windows that can be shown in the footer meter. */
  contextMeterOptions?: ChatContextMeterOption[];
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
  /** `blob:` URL from App (Settings → Theme background); shown behind the thread. */
  chatThreadBackgroundUrl?: string | null;
  /** Applies a soft Gaussian blur to the chat thread background art. */
  chatThreadBackgroundBlur?: boolean;
}

export interface HeaderCreditsDisplay {
  label: string;
  title: string;
  loading?: boolean;
  error?: boolean;
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

function renderChunkKey(chunk: RenderChunk): string {
  if (chunk.type === 'activity-group') return chunk.id;
  return chunk.entry.id;
}

function estimateRenderChunkHeight(chunk: RenderChunk): number {
  if (chunk.type === 'activity-group') return 74 + Math.min(120, chunk.items.length * 18) + CHAT_VIRTUALIZATION_GAP_PX;
  if (chunk.type === 'activity-solo') return 72 + CHAT_VIRTUALIZATION_GAP_PX;
  const message = chunk.entry.message;
  const textLength = Math.max(message.content.length, message.reasoning?.length ?? 0);
  const attachmentBoost = (message.attachments?.length ?? 0) * 90;
  return Math.min(
    720,
    Math.max(
      CHAT_VIRTUALIZATION_DEFAULT_ROW_PX,
      90 + Math.ceil(textLength / 95) * 22 + attachmentBoost
    )
  ) + CHAT_VIRTUALIZATION_GAP_PX;
}

function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((values[mid] ?? 0) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

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
  const handleToggle = () => {
    setOpen((v) => !v);
    onDetailsToggle?.();
  };

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="chat-activity-wrap"
      initial={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      <div className={`chat-activity chat-activity--collapsible chat-activity--${activity.kind}${open ? ' is-open' : ''}`}>
        <button
          aria-expanded={open}
          className="chat-activity__summary"
          onClick={handleToggle}
          type="button"
        >
          {label}
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="activity-body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              style={{ overflow: 'hidden' }}
            >
              <div className="chat-activity__body">
                <p>{activity.message}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function ToolActivityGroup({ items, onDetailsToggle }: { items: ActivityTimelineEntry[]; onDetailsToggle?: () => void }) {
  const [open, setOpen] = useState(false);
  const handleToggle = () => {
    setOpen((v) => !v);
    onDetailsToggle?.();
  };

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="chat-activity-wrap"
      initial={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      <div className={`chat-activity chat-activity--collapsible chat-activity--grouped-tools${open ? ' is-open' : ''}`}>
        <button
          aria-expanded={open}
          className="chat-activity__summary"
          onClick={handleToggle}
          type="button"
        >
          Tool activity · {items.length} steps
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="tool-activity-body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              style={{ overflow: 'hidden' }}
            >
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
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function VirtualMeasuredChunk({
  children,
  chunkKey,
  enabled,
  onMeasure
}: {
  children: ReactElement;
  chunkKey: string;
  enabled: boolean;
  onMeasure: (key: string, height: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!enabled || !ref.current) return;
    const node = ref.current;
    const measure = () => {
      onMeasure(chunkKey, Math.ceil(node.getBoundingClientRect().height) + CHAT_VIRTUALIZATION_GAP_PX);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [chunkKey, enabled, onMeasure]);

  return (
    <div className="chat-virtual-item" ref={ref}>
      {children}
    </div>
  );
}

/** Match ThinkingBlock motion.transition duration (+ small buffer). */
const THINKING_LAYOUT_MS = 240;

/** `data-thinking-layout-lock-until` on `.chat-scroll` blocks ResizeObserver auto-clamp mid-animation (prevents jitter). */
function ThinkingBlock({ active, reasoning }: { active: boolean; reasoning: string }) {
  const [open, setOpen] = useState(false);
  const summaryRef = useRef<HTMLButtonElement>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasReasoning = reasoning.trim().length > 0;

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
    <div className={`chat-thinking ${open ? 'is-open' : ''}${active ? ' is-active' : ''}`}>
      <button
        ref={summaryRef}
        aria-disabled={!hasReasoning}
        className={`chat-thinking__summary${hasReasoning ? '' : ' is-empty'}`}
        onClick={hasReasoning ? handleToggleThinking : undefined}
        type="button"
      >
        {hasReasoning ? <span className="chat-thinking__chevron" aria-hidden>&#x25B6;</span> : null}
        <span className="chat-thinking__label">{hasReasoning ? 'Thinking' : 'Working'}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && hasReasoning && (
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
  selectedProviderKind,
  selectedModel,
  modelPricing,
  openRouterReasoningEffort,
  openRouterReasoningSupported,
  onOpenRouterReasoningEffortChange,
  openRouterCredits,
  showModelOutputCosts,
  sessionMode,
  isWizard = false,
  isNexus = false,
  modelCatalogSettled,
  providerConnected,
  isStreaming,
  composerDisabled = false,
  composerDisabledPlaceholder,
  webSearch,
  onWebSearchChange,
  webSearchDisabled = false,
  onInputChange,
  mentionOptions = [],
  onAttachImages,
  onRemoveAttachment,
  onSend,
  onSubmitQuizAnswers,
  onStop,
  chatMessages,
  contextLimit,
  contextMeterOptions = [],
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
  nexusRelayQueueDuringStream = false,
  chatThreadBackgroundUrl = null,
  chatThreadBackgroundBlur = false
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionBackdropRef = useRef<HTMLDivElement>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const copyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendCostTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composerDragDepthRef = useRef(0);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [sendCostTooltipOpen, setSendCostTooltipOpen] = useState(false);
  const [sendCostTooltipAnchor, setSendCostTooltipAnchor] = useState({ top: 0, left: 0 });
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [mentionCaret, setMentionCaret] = useState(0);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [dismissedMentionStart, setDismissedMentionStart] = useState<number | null>(null);

  const rawMentionTrigger = useMemo(
    () => (isNexus && mentionOptions.length > 0 ? findMentionTrigger(input, mentionCaret) : null),
    [input, isNexus, mentionCaret, mentionOptions.length]
  );
  const mentionTrigger =
    rawMentionTrigger && rawMentionTrigger.start !== dismissedMentionStart ? rawMentionTrigger : null;
  const filteredMentionOptions = useMemo(() => {
    if (!mentionTrigger) return [];
    const needle = normalizedMentionText(mentionTrigger.query);
    if (!needle) return mentionOptions;
    return mentionOptions.filter((option) => normalizedMentionText(option.name).includes(needle));
  }, [mentionOptions, mentionTrigger]);
  const visibleMentionOptions = useMemo(() => filteredMentionOptions.slice(0, 8), [filteredMentionOptions]);
  const mentionMenuOpen = Boolean(mentionTrigger && visibleMentionOptions.length > 0);
  const mentionNames = useMemo(() => mentionOptions.map((option) => option.name), [mentionOptions]);
  const mentionHighlightNodes = useMemo(() => {
    if (!isNexus || mentionOptions.length === 0 || input.length === 0) return null;
    const ranges = mentionHighlightRanges(input, mentionOptions);
    if (ranges.length === 0) return null;
    const nodes: Array<string | ReactElement> = [];
    let cursor = 0;
    ranges.forEach((range, index) => {
      if (range.start > cursor) nodes.push(input.slice(cursor, range.start));
      nodes.push(
        <mark className="chat-compose__mention-highlight" key={`${range.start}-${range.end}-${index}`}>
          {input.slice(range.start, range.end)}
        </mark>
      );
      cursor = range.end;
    });
    if (cursor < input.length) nodes.push(input.slice(cursor));
    return nodes;
  }, [input, isNexus, mentionOptions]);
  const shouldShowMentionBackdrop = Boolean(mentionHighlightNodes);

  useEffect(() => {
    setMentionSelectedIndex(0);
  }, [mentionTrigger?.query, visibleMentionOptions.length]);

  const updateMentionCaretFromTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (el) setMentionCaret(el.selectionStart);
  }, []);

  const insertMention = useCallback(
    (option: ChatMentionOption) => {
      const trigger = mentionTrigger;
      if (!trigger) return;
      const mention = `@${option.name} `;
      const next = `${input.slice(0, trigger.start)}${mention}${input.slice(trigger.end)}`;
      const nextCaret = trigger.start + mention.length;
      onInputChange(next);
      setMentionCaret(nextCaret);
      setDismissedMentionStart(null);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [input, mentionTrigger, onInputChange]
  );

  const syncMentionBackdropScroll = useCallback(() => {
    const textarea = textareaRef.current;
    const backdrop = mentionBackdropRef.current;
    if (!textarea || !backdrop) return;
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  }, []);

  const contextUsedEstimate = useMemo(() => {
    const threadRough =
      roughTokensFromMessages(chatMessages) + DEFAULT_HIDDEN_SYSTEM_OVERHEAD_TOKENS;
    const draftRough = roughTokensForDraft(input, attachments);
    const rough = threadRough + draftRough;
    if (lastTokenUsage == null) return rough;
    return Math.max(rough, lastTokenUsage.totalTokens);
  }, [attachments, chatMessages, input, lastTokenUsage]);

  const draftCostTooltip = useMemo<DraftCostTooltip | null>(() => {
    if (selectedProviderKind !== 'openrouter') return null;
    const inputTokens = roughTokensForDraft(input, attachments);
    if (inputTokens <= 0) return null;
    const promptRate = Number(modelPricing?.prompt ?? NaN);
    const requestRate = Number(modelPricing?.request ?? 0);
    const modelLabel = selectedModel || 'OpenRouter model';
    if (!Number.isFinite(promptRate)) {
      return {
        heading: 'Cost estimate unavailable',
        rows: [
          { label: 'Model', value: modelLabel },
          { label: 'Draft tokens', value: formatTokensExact(inputTokens) }
        ],
        note: 'OpenRouter did not return prompt pricing for this model.',
        title: `Cost estimate unavailable\nModel: ${modelLabel}\nDraft tokens: ${formatTokensExact(inputTokens)}\nOpenRouter did not return prompt pricing for this model.`,
        unavailable: true
      };
    }
    const requestCost = Number.isFinite(requestRate) ? requestRate : 0;
    const total = inputTokens * promptRate + requestCost;
    const display = formatUsdEstimate(total);
    return {
      heading: 'Estimated draft input cost',
      rows: [
        { label: 'Cost', value: display },
        { label: 'Model', value: modelLabel },
        { label: 'Draft tokens', value: formatTokensExact(inputTokens) }
      ],
      note: 'Excludes reply, reasoning, and tool-call tokens.',
      title: `Estimated draft input cost: ${display}\nModel: ${modelLabel}\nDraft tokens: ${formatTokensExact(inputTokens)}\nExcludes reply, reasoning, and tool-call tokens.`
    };
  }, [attachments, input, modelPricing?.prompt, modelPricing?.request, selectedModel, selectedProviderKind]);
  const sendButtonTitle = draftCostTooltip ? `Send\n${draftCostTooltip.title}` : 'Send';
  const queueSendButtonTitle = draftCostTooltip
    ? `Queue message for next teammate turn\n${draftCostTooltip.title}`
    : 'Queue message for next teammate turn';

  const clearSendCostTooltipTimer = useCallback(() => {
    if (sendCostTooltipTimerRef.current != null) {
      clearTimeout(sendCostTooltipTimerRef.current);
      sendCostTooltipTimerRef.current = null;
    }
  }, []);

  const updateSendCostTooltipAnchor = useCallback(() => {
    const el = sendButtonRef.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    setSendCostTooltipAnchor({ top: b.top, left: b.left + b.width / 2 });
  }, []);

  const showSendCostTooltip = useCallback(() => {
    if (!draftCostTooltip) return;
    clearSendCostTooltipTimer();
    updateSendCostTooltipAnchor();
    setSendCostTooltipOpen(true);
  }, [clearSendCostTooltipTimer, draftCostTooltip, updateSendCostTooltipAnchor]);

  const scheduleHideSendCostTooltip = useCallback(() => {
    clearSendCostTooltipTimer();
    sendCostTooltipTimerRef.current = setTimeout(() => setSendCostTooltipOpen(false), 120);
  }, [clearSendCostTooltipTimer]);

  const handleComposerDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current += 1;
    setComposerDragActive(true);
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleComposerDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleComposerDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) {
      setComposerDragActive(false);
    }
  }, []);

  const handleComposerDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = 0;
    setComposerDragActive(false);
    const imageFiles = Array.from(event.dataTransfer.files).filter(isImageFile);
    if (imageFiles.length) {
      onAttachImages(imageFiles);
    }
  }, [onAttachImages]);

  useLayoutEffect(() => {
    if (!sendCostTooltipOpen) return;
    updateSendCostTooltipAnchor();
    const onReposition = () => updateSendCostTooltipAnchor();
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    return () => {
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };
  }, [sendCostTooltipOpen, updateSendCostTooltipAnchor]);

  useEffect(() => {
    if (!draftCostTooltip) setSendCostTooltipOpen(false);
  }, [draftCostTooltip]);
  /** When true and the model grows the thread height, snap scroll only if still within epsilon of bottom. */
  const userPinnedToBottomRef = useRef(true);
  const scheduleVirtualWindowUpdateRef = useRef<() => void>(() => undefined);

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

  /** Collapsible activity blocks animate height changes, so the scroll range may need a follow-up clamp. */
  const afterCollapsibleLayout = useCallback(() => {
    afterScrollLayout();
  }, [afterScrollLayout]);

  const handleScroll = useCallback(() => {
    const n = scrollRef.current;
    if (!n) return;
    userPinnedToBottomRef.current = distanceFromChatBottom(n) <= CHAT_BOTTOM_STICK_EPSILON_PX;
    scheduleVirtualWindowUpdateRef.current();
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
      if (sendCostTooltipTimerRef.current) clearTimeout(sendCostTooltipTimerRef.current);
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
      if (isChartDetailsLayoutLocked(scroll)) {
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

  const statusLabel = nexusRelayProgress?.phase === 'routing'
    ? 'Routing'
    : isStreaming
    ? 'Working'
    : providerConnected
      ? 'Connected'
      : modelCatalogSettled
        ? 'Disconnected'
        : 'Waiting';

  const statusModifierClass = isStreaming || providerConnected ? 'is-live' : modelCatalogSettled ? 'is-disconnected' : '';
  const openRouterModelUrl =
    selectedProviderKind === 'openrouter' && selectedModel.trim()
      ? `https://openrouter.ai/${selectedModel.split('/').map((part) => encodeURIComponent(part)).join('/')}`
      : null;

  const renderChunks = useMemo(() => buildRenderChunks(timeline), [timeline]);
  const chunkHeightMapRef = useRef<Map<string, number>>(new Map());
  const virtualizationRafRef = useRef(0);
  const [virtualScrollVersion, setVirtualScrollVersion] = useState(0);
  const [virtualMeasureVersion, setVirtualMeasureVersion] = useState(0);
  const virtualizationEnabled = renderChunks.length > CHAT_VIRTUALIZATION_THRESHOLD;
  const renderChunkKeys = useMemo(() => renderChunks.map(renderChunkKey), [renderChunks]);

  useEffect(() => {
    const liveKeys = new Set(renderChunkKeys);
    for (const key of chunkHeightMapRef.current.keys()) {
      if (!liveKeys.has(key)) chunkHeightMapRef.current.delete(key);
    }
  }, [renderChunkKeys]);

  const virtualPrefix = useMemo(() => {
    const prefix = new Array(renderChunks.length + 1).fill(0);
    for (let i = 0; i < renderChunks.length; i += 1) {
      const key = renderChunkKeys[i] ?? '';
      const measured = chunkHeightMapRef.current.get(key);
      prefix[i + 1] = (prefix[i] ?? 0) + (measured ?? estimateRenderChunkHeight(renderChunks[i]!));
    }
    return prefix;
  }, [renderChunks, renderChunkKeys, virtualMeasureVersion]);

  const virtualWindow = useMemo(() => {
    if (!virtualizationEnabled) {
      return {
        enabled: false,
        start: 0,
        end: renderChunks.length,
        top: 0,
        bottom: 0
      };
    }
    const node = scrollRef.current;
    const scrollTop = node?.scrollTop ?? Math.max(0, (virtualPrefix[renderChunks.length] ?? 0) - 900);
    const viewportHeight = node?.clientHeight ?? 900;
    const firstVisible = lowerBound(virtualPrefix, Math.max(0, scrollTop - CHAT_VIRTUALIZATION_OVERSCAN_PX));
    const lastVisible = lowerBound(
      virtualPrefix,
      scrollTop + viewportHeight + CHAT_VIRTUALIZATION_OVERSCAN_PX
    );
    const start = Math.max(0, Math.min(renderChunks.length, firstVisible - 1));
    const end = Math.max(start, Math.min(renderChunks.length, lastVisible + 1));
    const totalHeight = virtualPrefix[renderChunks.length] ?? 0;
    return {
      enabled: true,
      start,
      end,
      top: virtualPrefix[start] ?? 0,
      bottom: Math.max(0, totalHeight - (virtualPrefix[end] ?? totalHeight))
    };
  }, [renderChunks.length, virtualPrefix, virtualScrollVersion, virtualizationEnabled]);

  const visibleRenderChunks = virtualizationEnabled
    ? renderChunks.slice(virtualWindow.start, virtualWindow.end)
    : renderChunks;

  const scheduleVirtualWindowUpdate = useCallback(() => {
    if (!virtualizationEnabled) return;
    if (virtualizationRafRef.current) return;
    virtualizationRafRef.current = requestAnimationFrame(() => {
      virtualizationRafRef.current = 0;
      setVirtualScrollVersion((version) => version + 1);
    });
  }, [virtualizationEnabled]);
  scheduleVirtualWindowUpdateRef.current = scheduleVirtualWindowUpdate;

  useEffect(() => {
    if (!virtualizationEnabled) return;
    scheduleVirtualWindowUpdate();
  }, [renderChunks.length, scheduleVirtualWindowUpdate, threadHeadKey, timelineTailKey, virtualizationEnabled]);

  useEffect(() => {
    return () => {
      if (virtualizationRafRef.current) cancelAnimationFrame(virtualizationRafRef.current);
    };
  }, []);

  const handleVirtualChunkMeasure = useCallback((key: string, nextHeight: number) => {
    const prevHeight = chunkHeightMapRef.current.get(key);
    if (Math.abs((prevHeight ?? 0) - nextHeight) <= 2) return;
    chunkHeightMapRef.current.set(key, nextHeight);
    setVirtualMeasureVersion((version) => version + 1);
  }, []);

  const chatBgLayers =
    chatThreadBackgroundUrl != null && chatThreadBackgroundUrl !== '' ? (
      <>
        <div className={`chat-scroll__bg ${chatThreadBackgroundBlur ? 'is-blurred' : ''}`} aria-hidden>
          <img
            alt=""
            className="chat-scroll__bg-img"
            decoding="async"
            draggable={false}
            src={chatThreadBackgroundUrl}
          />
        </div>
        <div className="chat-scroll__bg-scrim" aria-hidden />
      </>
    ) : null;

  const sendCostTooltipPopover =
    sendCostTooltipOpen &&
    draftCostTooltip &&
    typeof document !== 'undefined' &&
    createPortal(
      <div
        className={`chat-send-cost-popover${draftCostTooltip.unavailable ? ' is-unavailable' : ''}`}
        onMouseEnter={showSendCostTooltip}
        onMouseLeave={scheduleHideSendCostTooltip}
        role="tooltip"
        style={{
          left: sendCostTooltipAnchor.left,
          top: sendCostTooltipAnchor.top - 10,
          transform: 'translate(-50%, -100%)'
        }}
      >
        <div className="chat-send-cost-popover__inner">
          <div className="chat-send-cost-popover__heading">{draftCostTooltip.heading}</div>
          <div className="chat-send-cost-popover__rows">
            {draftCostTooltip.rows.map((row) => (
              <div className="chat-send-cost-popover__row" key={row.label}>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            ))}
          </div>
          <div className="chat-send-cost-popover__note">{draftCostTooltip.note}</div>
        </div>
      </div>,
      document.body
    );

  const wizardHubScrollInner = (
    <div className="chat-scroll__inner wizard-hub-scroll__inner" ref={innerRef}>
      <div className="chat-scroll__stack">
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
  );

  const threadScrollInner = (
    <div className="chat-scroll__inner" ref={innerRef}>
      <div className="chat-scroll__stack">
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

        {virtualWindow.enabled && virtualWindow.top > 0 ? (
          <div aria-hidden className="chat-virtual-spacer" style={{ height: virtualWindow.top }} />
        ) : null}

        {visibleRenderChunks.map((chunk) => {
          const chunkKey = renderChunkKey(chunk);
          const wrapVirtual = (element: ReactElement) =>
            virtualizationEnabled ? (
              <VirtualMeasuredChunk
                chunkKey={chunkKey}
                enabled={virtualizationEnabled}
                key={chunkKey}
                onMeasure={handleVirtualChunkMeasure}
              >
                {element}
              </VirtualMeasuredChunk>
            ) : (
              element
            );

          if (chunk.type === 'activity-group') {
            return wrapVirtual(
              <ToolActivityGroup key={chunk.id} items={chunk.items} onDetailsToggle={afterCollapsibleLayout} />
            );
          }
          if (chunk.type === 'activity-solo') {
            return wrapVirtual(
              <CollapsibleActivityBlock
                key={chunk.entry.id}
                activity={chunk.entry.activity}
                onDetailsToggle={afterCollapsibleLayout}
              />
            );
          }

          const { entry } = chunk;
          const { message } = entry;
          const assistantWaitingForFirstOutput =
            message.role === 'assistant' &&
            message.status === 'streaming' &&
            !message.content.trim() &&
            !message.attachments?.length;

          return wrapVirtual(
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
              {message.role === 'assistant' && (message.reasoning?.trim() || assistantWaitingForFirstOutput) ? (
                <ThinkingBlock active={message.status === 'streaming'} reasoning={message.reasoning?.trim() ?? ''} />
              ) : null}
              {message.attachments?.length ? (
                <div className="chat-attachments">
                  {message.attachments.map((att) => (
                    <AttachmentPreview attachment={att} key={att.id} />
                  ))}
                </div>
              ) : null}
              {message.content !== '' || message.status === 'done' || message.status === 'error' ? (
                <div className="chat-bubble__text">
                  {message.role === 'assistant' ? (
                    <AssistantMessageContent
                      completedQuizSelections={completedQuizSelectionsAfterMessage(chatMessages, message.id)}
                      onSessionModeToggle={onSessionModeToggle}
                      onSubmitQuizAnswers={onSubmitQuizAnswers}
                      onWebSearchChange={onWebSearchChange}
                      quizSubmitDisabled={message.status === 'streaming'}
                      sessionMode={sessionMode}
                      sessionModeToggleDisabled={sessionModeToggleDisabled}
                      mentionNames={mentionNames}
                      text={message.content}
                      webSearch={webSearch}
                      webSearchDisabled={webSearchDisabled}
                    />
                  ) : (
                    <ChatMarkdown mentionNames={mentionNames} text={getCopyableMessageText(message.content)} />
                  )}
                </div>
              ) : null}
              {showModelOutputCosts && message.role === 'assistant' && message.costEstimate ? (
                <div className="chat-bubble__cost" title={messageCostTitle(message.costEstimate)}>
                  Estimated cost: {message.costEstimate.display}
                </div>
              ) : null}
            </motion.article>
          );
        })}
        {virtualWindow.enabled && virtualWindow.bottom > 0 ? (
          <div aria-hidden className="chat-virtual-spacer" style={{ height: virtualWindow.bottom }} />
        ) : null}
        <div aria-hidden className="chat-scroll__bottom" ref={bottomRef} />
      </div>
    </div>
  );

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
            {openRouterModelUrl ? (
              <a
                className="chat-panel__model chat-panel__model-link"
                href={openRouterModelUrl}
                onClick={(event) => {
                  event.preventDefault();
                  void window.electronAPI.openExternalUrl(openRouterModelUrl);
                }}
                rel="noreferrer"
                target="_blank"
                title={`Open ${selectedModel} on OpenRouter`}
              >
                {selectedModel}
              </a>
            ) : (
              <span className="chat-panel__model">{selectedModel || 'No model selected'}</span>
            )}
          </div>
          <span className="chat-panel__session" title={sessionSubheading}>
            {sessionSubheading}
          </span>
        </div>
        <div className="chat-panel__header-right">
          {openRouterCredits ? (
            <div
              className={[
                'chat-panel__credits',
                openRouterCredits.loading ? 'is-loading' : '',
                openRouterCredits.error ? 'is-error' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              title={openRouterCredits.title}
            >
              {openRouterCredits.label}
            </div>
          ) : null}
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
        chatBgLayers ? (
          <div className="chat-scroll-shell">
            {chatBgLayers}
            <div
              className="chat-scroll wizard-hub-scroll"
              onScroll={handleScroll}
              onWheelCapture={handleWheelCapture}
              ref={scrollRef}
            >
              {wizardHubScrollInner}
            </div>
          </div>
        ) : (
          <div
            className="chat-scroll wizard-hub-scroll"
            onScroll={handleScroll}
            onWheelCapture={handleWheelCapture}
            ref={scrollRef}
          >
            {wizardHubScrollInner}
          </div>
        )
      ) : (
        <>
          {chatBgLayers ? (
            <div className="chat-scroll-shell">
              {chatBgLayers}
              <div
                className="chat-scroll"
                onScroll={handleScroll}
                onWheelCapture={handleWheelCapture}
                ref={scrollRef}
              >
                {threadScrollInner}
              </div>
            </div>
          ) : (
            <div
              className="chat-scroll"
              onScroll={handleScroll}
              onWheelCapture={handleWheelCapture}
              ref={scrollRef}
            >
              {threadScrollInner}
            </div>
          )}

      <AnimatePresence initial={false}>
        {terminalOpen && (
          <motion.div
            className="chat-terminal-overlay"
            key="inline-terminal"
            initial={{ opacity: 0, y: 10, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.99 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
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
        <AnimatePresence>
          {workspaceGateNotice ? (
            <motion.div
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="chat-compose__notice"
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              role="alert"
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
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
            </motion.div>
          ) : null}
        </AnimatePresence>
        {attachments.length ? (
          <div className="composer-attachments">
            {attachments.map((att) => (
              <div className="composer-attachment" key={att.id}>
                <AttachmentPreview attachment={att} compact />
                <span>{att.name}</span>
                <button onClick={() => onRemoveAttachment(att.id)} type="button">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div
          className={`chat-compose__bar ${isStreaming ? 'is-working' : ''} ${composerDragActive ? 'is-drag-over' : ''}`}
          onDragEnter={handleComposerDragEnter}
          onDragLeave={handleComposerDragLeave}
          onDragOver={handleComposerDragOver}
          onDrop={handleComposerDrop}
        >
          <span className="chat-compose__drop-hint" aria-hidden>
            Drop image to attach
          </span>
          <label className="chat-compose__attach" title="Attach images">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14 10l-3.5-3.5a2 2 0 00-2.83 0L2 12M14 10v4H2v-2M14 10V5a2 2 0 00-2-2H4a2 2 0 00-2 2v7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/><circle cx="5.5" cy="6.5" r="1.5" stroke="currentColor" strokeWidth="1.3"/></svg>
            <input
              accept="image/*"
              disabled={composerDisabled}
              multiple
              onChange={(e) => { onAttachImages(e.target.files); e.target.value = ''; }}
              type="file"
            />
          </label>
          {selectedProviderKind === 'openrouter' ? (
            <OpenRouterReasoningButton
              disabled={isStreaming || composerDisabled}
              effort={openRouterReasoningEffort}
              model={selectedModel || 'No model selected'}
              onChange={onOpenRouterReasoningEffortChange}
              supported={openRouterReasoningSupported}
            />
          ) : null}
          <div className={`chat-compose__input-wrap ${shouldShowMentionBackdrop ? 'has-mention-highlights' : ''}`}>
            {shouldShowMentionBackdrop ? (
              <div className="chat-compose__mention-backdrop" ref={mentionBackdropRef} aria-hidden>
                {mentionHighlightNodes}
              </div>
            ) : null}
            <textarea
              ref={textareaRef}
              className="chat-compose__input"
              aria-autocomplete={mentionOptions.length > 0 ? 'list' : undefined}
              aria-controls={mentionMenuOpen ? 'nexus-mention-list' : undefined}
              onChange={(e) => {
                if (composerDisabled) return;
                onInputChange(e.target.value);
                setMentionCaret(e.target.selectionStart);
                setDismissedMentionStart(null);
              }}
              onKeyDown={(e) => {
                if (composerDisabled) return;
                if (mentionMenuOpen) {
                  if (e.key === 'Tab' || e.key === 'Enter') {
                    e.preventDefault();
                    insertMention(visibleMentionOptions[mentionSelectedIndex] ?? visibleMentionOptions[0]!);
                    return;
                  }
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setMentionSelectedIndex((current) => (current + 1) % visibleMentionOptions.length);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMentionSelectedIndex((current) => (current - 1 + visibleMentionOptions.length) % visibleMentionOptions.length);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setDismissedMentionStart(mentionTrigger?.start ?? null);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  const canSend =
                    !composerDisabled &&
                    (!isStreaming ||
                      (nexusRelayQueueDuringStream && (input.trim().length > 0 || attachments.length > 0)));
                  if (canSend) {
                    onSend();
                  }
                }
              }}
              onKeyUp={updateMentionCaretFromTextarea}
              onScroll={syncMentionBackdropScroll}
              onSelect={updateMentionCaretFromTextarea}
              placeholder={composerDisabledPlaceholder ?? 'Type a message...'}
              rows={1}
              value={input}
              disabled={composerDisabled}
            />
          </div>
          {mentionMenuOpen ? (
            <div className="chat-compose__mention-menu" id="nexus-mention-list" role="listbox">
              {visibleMentionOptions.map((option, index) => (
                <button
                  aria-selected={index === mentionSelectedIndex}
                  className={`chat-compose__mention-option ${index === mentionSelectedIndex ? 'is-active' : ''}`}
                  key={option.id}
                  onClick={() => insertMention(option)}
                  onMouseDown={(e) => e.preventDefault()}
                  role="option"
                  type="button"
                >
                  <span className="chat-compose__mention-at">@</span>
                  <span className="chat-compose__mention-name">{option.name}</span>
                  {option.role === 'leader' ? <span className="chat-compose__mention-role">Leader</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          <ChatContextMeter limit={contextLimit} options={contextMeterOptions} used={contextUsedEstimate} />
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
                  ref={sendButtonRef}
                  className="chat-compose__send chat-compose__send--alongside-stop"
                  disabled={composerDisabled || (input.trim().length === 0 && attachments.length === 0)}
                  onBlur={scheduleHideSendCostTooltip}
                  onFocus={showSendCostTooltip}
                  onMouseEnter={showSendCostTooltip}
                  onMouseLeave={scheduleHideSendCostTooltip}
                  onClick={() => onSend()}
                  type="button"
                  title={queueSendButtonTitle}
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
              ref={sendButtonRef}
              className="chat-compose__send"
              disabled={composerDisabled || (input.trim().length === 0 && attachments.length === 0)}
              onBlur={scheduleHideSendCostTooltip}
              onFocus={showSendCostTooltip}
              onMouseEnter={showSendCostTooltip}
              onMouseLeave={scheduleHideSendCostTooltip}
              onClick={() => onSend()}
              type="button"
              title={sendButtonTitle}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14 2L7 9M14 2l-5 12-2-5-5-2 12-5z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          )}
        </div>
      </div>
      {sendCostTooltipPopover}
        </>
      )}
    </section>
  );
}

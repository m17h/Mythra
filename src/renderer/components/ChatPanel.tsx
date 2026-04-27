import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { ChatActivity, ChatAttachment, ChatTimelineEntry, SessionMode } from '@shared/types';
import { ChatMarkdown } from './ChatMarkdown';

interface ChatPanelProps {
  timeline: ChatTimelineEntry[];
  input: string;
  attachments: ChatAttachment[];
  selectedProviderLabel: string;
  selectedModel: string;
  sessionMode: SessionMode;
  providerConnected: boolean;
  isStreaming: boolean;
  onInputChange: (value: string) => void;
  onAttachImages: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  onSend: () => void;
  onStop: () => void;
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

function CollapsibleActivityBlock({ activity }: { activity: ChatActivity }) {
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
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
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

function ToolActivityGroup({ items }: { items: ActivityTimelineEntry[] }) {
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
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
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

export function ChatPanel({
  timeline,
  input,
  attachments,
  selectedProviderLabel,
  selectedModel,
  sessionMode,
  providerConnected,
  isStreaming,
  onInputChange,
  onAttachImages,
  onRemoveAttachment,
  onSend,
  onStop
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [timeline]);

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

  const renderChunks = useMemo(() => buildRenderChunks(timeline), [timeline]);

  return (
    <section className="chat-panel">
      <div className="chat-panel__header">
        <div className="chat-panel__header-left">
          <h2 className="chat-panel__title">{isTalk ? 'Chat' : 'Agent'}</h2>
          <span className="chat-panel__model">{selectedModel || 'No model selected'}</span>
        </div>
        <div className={`chat-panel__status ${isStreaming || providerConnected ? 'is-live' : ''}`}>
          <span className="chat-panel__status-dot" />
          {isStreaming ? 'Working' : providerConnected ? 'Connected' : 'Waiting'}
        </div>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
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
                  ? 'You\'re in Talk mode. Ask anything or switch to Agent for tools and file access.'
                  : `${selectedProviderLabel} is connected. Ask for code, architecture, or refactors.`
                : 'Connect a provider in Settings, then click Test + Refresh to get started.'}
            </p>
          </div>
        ) : null}

        {renderChunks.map((chunk) => {
          if (chunk.type === 'activity-group') {
            return <ToolActivityGroup key={chunk.id} items={chunk.items} />;
          }
          if (chunk.type === 'activity-solo') {
            return <CollapsibleActivityBlock key={chunk.entry.id} activity={chunk.entry.activity} />;
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
              <header>{message.role === 'user' ? 'You' : 'Assistant'}</header>
              {message.role === 'assistant' && message.reasoning?.trim() ? (
                <details className="chat-thinking">
                  <summary>Thinking</summary>
                  <pre className="chat-thinking__body">{message.reasoning.trim()}</pre>
                </details>
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
                  <ChatMarkdown text={message.content} />
                </div>
              ) : null}
            </motion.article>
          );
        })}
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
                onSend();
              }
            }}
            placeholder="Type a message..."
            rows={1}
            value={input}
          />
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

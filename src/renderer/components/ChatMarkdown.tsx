import type { Components } from 'react-markdown';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

type MediaKind = 'image' | 'video' | 'audio';
type ChatColorName = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'gray';
type ChatColorTone = 'light' | 'normal' | 'dark';

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(?:[?#].*)?$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv|ogg)(?:[?#].*)?$/i;
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|flac|opus|oga|ogg|webm)(?:[?#].*)?$/i;
const COLOR_TAG_PATTERN =
  String.raw`\[color=([a-z][a-z0-9_-]*)(?:\s+tone=(light|normal|dark))?\]([\s\S]*?)\[\/color\]`;
const CHAT_COLOR_ALIASES: Record<string, ChatColorName> = {
  danger: 'red',
  error: 'red',
  warning: 'orange',
  success: 'green',
  info: 'blue',
  muted: 'gray'
};

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

function normalizeChatColor(raw: string): ChatColorName | null {
  const value = raw.trim().toLowerCase();
  if (value in CHAT_COLOR_ALIASES) return CHAT_COLOR_ALIASES[value];
  if (['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray'].includes(value)) {
    return value as ChatColorName;
  }
  return null;
}

function normalizeChatColorTone(raw: string | undefined): ChatColorTone {
  const value = raw?.trim().toLowerCase();
  return value === 'light' || value === 'dark' ? value : 'normal';
}

function parseColorText(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let lastIndex = 0;
  const colorTagRe = new RegExp(COLOR_TAG_PATTERN, 'gi');
  for (let match = colorTagRe.exec(value); match; match = colorTagRe.exec(value)) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    }
    const color = normalizeChatColor(match[1]);
    const tone = normalizeChatColorTone(match[2]);
    const content = match[3] ?? '';
    if (color && content) {
      nodes.push({
        type: 'chatColor',
        data: {
          hName: 'span',
          hProperties: {
            className: ['chat-color-text', `chat-color-text--${color}`, `chat-color-text--${tone}`]
          }
        },
        children: parseColorText(content)
      });
    } else if (content) {
      nodes.push({ type: 'text', value: content });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) {
    nodes.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return nodes.length ? nodes : [{ type: 'text', value }];
}

function remarkChatColorText() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      const nextChildren: MarkdownNode[] = [];
      for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('[color=')) {
          nextChildren.push(...parseColorText(child.value));
        } else {
          visit(child);
          nextChildren.push(child);
        }
      }
      node.children = nextChildren;
    };
    visit(tree);
  };
}

function mediaKindFromHref(rawHref: unknown): MediaKind | null {
  if (typeof rawHref !== 'string') return null;
  const href = rawHref.trim();
  if (!href) return null;
  if (/^data:image\//i.test(href)) return 'image';
  if (/^data:video\//i.test(href)) return 'video';
  if (/^data:audio\//i.test(href)) return 'audio';
  if (!/^(https?:|blob:|data:)/i.test(href)) return null;
  if (IMAGE_EXT_RE.test(href)) return 'image';
  if (VIDEO_EXT_RE.test(href)) return 'video';
  if (AUDIO_EXT_RE.test(href)) return 'audio';
  return null;
}

function mediaDownloadName(href: string, fallback = 'media') {
  try {
    const url = new URL(href);
    const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    return name || fallback;
  } catch {
    return fallback;
  }
}

function MediaMarkdownLink({ href, children }: { href: string; children: ReactNode }) {
  const kind = mediaKindFromHref(href);
  if (!kind) {
    return (
      <a href={href} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    );
  }

  const label = String(children).trim() || mediaDownloadName(href);
  const saveMedia = () => {
    void window.electronAPI.saveGeneratedMedia(href, mediaDownloadName(href, label));
  };
  return (
    <span className="chat-media-link">
      <span className="chat-media-link__frame">
        {kind === 'image' ? <img alt={label} src={href} /> : null}
        {kind === 'video' ? <video controls preload="metadata" src={href} /> : null}
        {kind === 'audio' ? <audio controls preload="metadata" src={href} /> : null}
      </span>
      <span className="chat-media-link__meta">
        <span className="chat-media-link__name">{label}</span>
        <span className="chat-media-link__actions">
          <button onClick={saveMedia} type="button">
            Save
          </button>
        </span>
      </span>
    </span>
  );
}

const markdownComponents: Components = {
  a: ({ children, node, href, ...rest }) =>
    href ? (
      <MediaMarkdownLink href={href}>{children}</MediaMarkdownLink>
    ) : (
      <a {...rest} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    ),
  table: ({ children, node, ...rest }) => (
    <div className="table-wrap">
      <table {...rest}>{children}</table>
    </div>
  )
};

interface ChatMarkdownProps {
  text: string;
}

export function ChatMarkdown({ text }: ChatMarkdownProps) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm, remarkBreaks, remarkChatColorText]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

import type { Components } from 'react-markdown';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
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

function mentionRanges(value: string, names: string[]) {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const rawName of names) {
    const name = rawName.trim();
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
    const previous = merged[merged.length - 1];
    if (previous && range.start < previous.end) continue;
    merged.push(range);
  }
  return merged;
}

function parseMentionText(value: string, names: string[]): MarkdownNode[] {
  const ranges = mentionRanges(value, names);
  if (ranges.length === 0) return [{ type: 'text', value }];
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) nodes.push({ type: 'text', value: value.slice(cursor, range.start) });
    nodes.push({
      type: 'chatMention',
      data: {
        hName: 'span',
        hProperties: {
          className: ['chat-mention-text']
        }
      },
      children: [{ type: 'text', value: value.slice(range.start, range.end) }]
    });
    cursor = range.end;
  }
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) });
  return nodes;
}

function remarkChatMentionText(names: string[]) {
  return () => {
    const mentionNames = names.map((name) => name.trim()).filter((name) => name.length >= 2);
    return (tree: MarkdownNode) => {
      if (mentionNames.length === 0) return;
      const visit = (node: MarkdownNode) => {
        if (!node.children) return;
        const nextChildren: MarkdownNode[] = [];
        for (const child of node.children) {
          if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('@')) {
            nextChildren.push(...parseMentionText(child.value, mentionNames));
          } else {
            visit(child);
            nextChildren.push(child);
          }
        }
        node.children = nextChildren;
      };
      visit(tree);
    };
  };
}

// Reject SVG (and XML) data URLs: they can carry inline scripts/event handlers
// that execute in the Electron renderer. Only allow raster/known-safe media data.
const SAFE_IMAGE_DATA_RE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)[;,]/i;
const SAFE_VIDEO_DATA_RE = /^data:video\/(mp4|webm|ogg|quicktime)[;,]/i;
const SAFE_AUDIO_DATA_RE = /^data:audio\/(mpeg|mp3|wav|x-wav|ogg|webm|aac|flac|mp4)[;,]/i;

// Schemes considered safe for plain (non-media) links rendered in the renderer.
const SAFE_LINK_SCHEME_RE = /^(https?|mailto|tel):/i;

function isSafeLinkHref(rawHref: unknown): boolean {
  if (typeof rawHref !== 'string') return false;
  const href = rawHref.trim();
  if (!href) return false;
  // Allow in-app/relative and fragment links.
  if (/^(#|\/|\.\.?\/)/.test(href)) return true;
  // Block dangerous schemes like javascript:, data:, vbscript:, file:, blob:.
  return SAFE_LINK_SCHEME_RE.test(href);
}

function mediaKindFromHref(rawHref: unknown): MediaKind | null {
  if (typeof rawHref !== 'string') return null;
  const href = rawHref.trim();
  if (!href) return null;
  if (/^data:/i.test(href)) {
    if (SAFE_IMAGE_DATA_RE.test(href)) return 'image';
    if (SAFE_VIDEO_DATA_RE.test(href)) return 'video';
    if (SAFE_AUDIO_DATA_RE.test(href)) return 'audio';
    return null;
  }
  if (!/^(https?:|blob:)/i.test(href)) return null;
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
    if (!isSafeLinkHref(href)) {
      // Unsafe scheme (e.g. javascript:, data:, file:) — render inert text so it
      // can never navigate or execute in the Electron renderer.
      return <span className="chat-unsafe-link">{children}</span>;
    }
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
      <span className="chat-unsafe-link">{children}</span>
    ),
  img: ({ node, src, alt, ...rest }) => {
    // Only allow raster/safe media; block javascript:, svg data URLs, etc.
    if (typeof src === 'string' && mediaKindFromHref(src) === 'image') {
      return <img {...rest} alt={alt ?? ''} src={src} />;
    }
    return <span className="chat-unsafe-link">{alt || ''}</span>;
  },
  table: ({ children, node, ...rest }) => (
    <div className="table-wrap">
      <table {...rest}>{children}</table>
    </div>
  )
};

interface ChatMarkdownProps {
  text: string;
  mentionNames?: string[];
}

export function ChatMarkdown({ text, mentionNames = [] }: ChatMarkdownProps) {
  const mentionPlugin = useMemo(() => remarkChatMentionText(mentionNames), [mentionNames]);
  return (
    <div className="chat-markdown">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm, remarkBreaks, remarkChatColorText, mentionPlugin]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

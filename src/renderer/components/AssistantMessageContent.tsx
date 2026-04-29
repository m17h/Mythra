import { Fragment } from 'react';
import type { SessionMode } from '@shared/types';
import {
  SESSION_MODE_EMBED_STRINGS,
  WEB_SEARCH_EMBED_STRINGS
} from '@shared/mythra-embeds';
import { ChatMarkdown } from './ChatMarkdown';
import { SessionModeMessageEmbed } from './SessionModeMessageEmbed';
import { WebSearchMessageEmbed } from './WebSearchMessageEmbed';

type Props = {
  text: string;
  sessionMode: SessionMode;
  onSessionModeToggle: () => void;
  sessionModeToggleDisabled?: boolean;
  webSearch: boolean;
  onWebSearchChange: (next: boolean) => void;
  webSearchDisabled?: boolean;
};

type EmbedSegment = { type: 'md'; text: string } | { type: 'session' } | { type: 'web' };

function textHasAnyEmbedToken(text: string): boolean {
  return [...SESSION_MODE_EMBED_STRINGS, ...WEB_SEARCH_EMBED_STRINGS].some((t) => text.includes(t));
}

function findNextEmbed(rest: string): { i: number; len: number; kind: 'session' | 'web' } | null {
  let best: { i: number; len: number; kind: 'session' | 'web' } | null = null;
  for (const s of SESSION_MODE_EMBED_STRINGS) {
    const i = rest.indexOf(s);
    if (i >= 0 && (!best || i < best.i)) best = { i, len: s.length, kind: 'session' };
  }
  for (const s of WEB_SEARCH_EMBED_STRINGS) {
    const i = rest.indexOf(s);
    if (i >= 0 && (!best || i < best.i)) best = { i, len: s.length, kind: 'web' };
  }
  return best;
}

function parseAssistantEmbeds(text: string): EmbedSegment[] {
  if (!textHasAnyEmbedToken(text)) {
    return [{ type: 'md', text }];
  }

  const out: EmbedSegment[] = [];
  let rest = text;
  while (rest.length > 0) {
    const next = findNextEmbed(rest);

    if (!next) {
      out.push({ type: 'md', text: rest });
      break;
    }
    if (next.i > 0) {
      out.push({ type: 'md', text: rest.slice(0, next.i) });
    }
    out.push({ type: next.kind });
    rest = rest.slice(next.i + next.len);
  }
  return out;
}

/**
 * Renders assistant markdown, replacing model-emitted embed tokens with live controls
 * (`MYTHRA_*` tokens and legacy `OPENKIWI_*` placeholders).
 */
export function AssistantMessageContent({
  text,
  sessionMode,
  onSessionModeToggle,
  sessionModeToggleDisabled = false,
  webSearch,
  onWebSearchChange,
  webSearchDisabled = false
}: Props) {
  const segments = parseAssistantEmbeds(text);
  if (segments.length === 1 && segments[0]!.type === 'md') {
    return <ChatMarkdown text={segments[0]!.text} />;
  }

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'md') {
          return <Fragment key={i}>{seg.text ? <ChatMarkdown text={seg.text} /> : null}</Fragment>;
        }
        if (seg.type === 'session') {
          return (
            <SessionModeMessageEmbed
              key={i}
              disabled={sessionModeToggleDisabled}
              onSessionModeToggle={onSessionModeToggle}
              sessionMode={sessionMode}
            />
          );
        }
        /* Inline Web toggle is only useful when Web is off; if it is already on, do not duplicate the header control. */
        if (webSearch) {
          return null;
        }
        return (
          <WebSearchMessageEmbed
            key={i}
            disabled={webSearchDisabled}
            onWebSearchChange={onWebSearchChange}
            webSearch={webSearch}
          />
        );
      })}
    </>
  );
}

import { Fragment } from 'react';
import type { SessionMode } from '@shared/types';
import { OPENKIWI_SESSION_MODE_TOGGLE, OPENKIWI_WEB_SEARCH_TOGGLE } from '@shared/openkiwi-embeds';
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

function parseAssistantEmbeds(text: string): EmbedSegment[] {
  if (!text.includes(OPENKIWI_SESSION_MODE_TOGGLE) && !text.includes(OPENKIWI_WEB_SEARCH_TOGGLE)) {
    return [{ type: 'md', text }];
  }

  const out: EmbedSegment[] = [];
  let rest = text;
  while (rest.length > 0) {
    const iSession = rest.indexOf(OPENKIWI_SESSION_MODE_TOGGLE);
    const iWeb = rest.indexOf(OPENKIWI_WEB_SEARCH_TOGGLE);
    const next =
      iSession < 0 && iWeb < 0
        ? null
        : iSession < 0
          ? { i: iWeb, kind: 'web' as const, len: OPENKIWI_WEB_SEARCH_TOGGLE.length }
          : iWeb < 0
            ? { i: iSession, kind: 'session' as const, len: OPENKIWI_SESSION_MODE_TOGGLE.length }
            : iSession <= iWeb
              ? { i: iSession, kind: 'session' as const, len: OPENKIWI_SESSION_MODE_TOGGLE.length }
              : { i: iWeb, kind: 'web' as const, len: OPENKIWI_WEB_SEARCH_TOGGLE.length };

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
 * ([[OPENKIWI_SESSION_MODE_TOGGLE]], [[OPENKIWI_WEB_SEARCH_TOGGLE]]).
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

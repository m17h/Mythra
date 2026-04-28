import type { ChatAttachment, ChatMessage } from '@shared/types';

/** Rough OpenAI-style token estimate (~4 chars per English token; good for UI, not billing). */
export function roughTokensFromText(text: string): number {
  if (!text.length) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function attachmentHeuristicTokens(att: ChatAttachment): number {
  const len = att.dataUrl?.length ?? 0;
  if (len === 0) return 0;
  /** Vision-style inputs are token-heavy; coarse lower bound from payload size. */
  return Math.ceil(len / 96);
}

/** User/assistant messages as sent to the API (rough). */
export function roughTokensFromMessages(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += roughTokensFromText(m.content);
    if (m.reasoning?.length) n += roughTokensFromText(m.reasoning);
    for (const a of m.attachments ?? []) {
      n += attachmentHeuristicTokens(a);
    }
  }
  return n;
}

export function roughTokensForDraft(input: string, attachments: ChatAttachment[]): number {
  let n = roughTokensFromText(input);
  for (const a of attachments) n += attachmentHeuristicTokens(a);
  return n;
}

/**
 * Underside of what the main process adds: two system prompts + tool/system routing.
 * Kept as a constant so the ring is in the right ballpark between API responses.
 */
export const DEFAULT_HIDDEN_SYSTEM_OVERHEAD_TOKENS = 8200;

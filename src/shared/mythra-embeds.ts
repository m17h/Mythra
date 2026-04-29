/**
 * Inline placeholder tokens the model may emit in assistant messages; the UI replaces them with controls.
 */

/** Current Mythra tokens (referenced in Agent system prompts). */
export const MYTHRA_SESSION_MODE_TOGGLE = '[[MYTHRA_SESSION_MODE_TOGGLE]]';
export const MYTHRA_WEB_SEARCH_TOGGLE = '[[MYTHRA_WEB_SEARCH_TOGGLE]]';

/** Legacy OpenKiwi-era tokens — still stripped and rendered for older transcripts. */
export const LEGACY_OPENKIWI_SESSION_MODE_TOGGLE = '[[OPENKIWI_SESSION_MODE_TOGGLE]]';
export const LEGACY_OPENKIWI_WEB_SEARCH_TOGGLE = '[[OPENKIWI_WEB_SEARCH_TOGGLE]]';

export const SESSION_MODE_EMBED_STRINGS = [
  MYTHRA_SESSION_MODE_TOGGLE,
  LEGACY_OPENKIWI_SESSION_MODE_TOGGLE
] as const;

export const WEB_SEARCH_EMBED_STRINGS = [MYTHRA_WEB_SEARCH_TOGGLE, LEGACY_OPENKIWI_WEB_SEARCH_TOGGLE] as const;

export const ALL_EMBED_STRIP_STRINGS = [...SESSION_MODE_EMBED_STRINGS, ...WEB_SEARCH_EMBED_STRINGS] as const;

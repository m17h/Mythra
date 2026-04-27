/**
 * Assistant messages may include this exact token; the client replaces it with a live Session mode control.
 * Kept in shared so the model system prompt in `model-service` and the renderer stay in sync.
 */
export const OPENKIWI_SESSION_MODE_TOGGLE = '[[OPENKIWI_SESSION_MODE_TOGGLE]]';

/**
 * Replaced with the same Web (search) toggle as the chat header, so the user can turn web_search on or off in context.
 */
export const OPENKIWI_WEB_SEARCH_TOGGLE = '[[OPENKIWI_WEB_SEARCH_TOGGLE]]';

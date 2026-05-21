import { randomUUID } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import OpenAI from 'openai';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions/completions';
import { app, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type {
  AppSettings,
  ChatActivity,
  ChatMessageCostEstimate,
  ChatCompletionTokenUsage,
  ChatAttachment,
  ChatMessage,
  ChatStreamDone,
  ChatStreamError,
  ModelInfo,
  ModelListOptions,
  NexusTeamWorkspaceReference,
  OpenRouterReasoningEffort,
  ProviderKind,
  SavedChat,
  SavedChatMeta,
  SessionMode,
  WizardProfile
} from '@shared/types';
import { MYTHRA_SESSION_MODE_TOGGLE, MYTHRA_WEB_SEARCH_TOGGLE } from '@shared/mythra-embeds';
import { syncProviderSystemPromptFields } from '@shared/provider-profile';
import {
  isPresetThemeId,
  isThemeId,
  MERGE_THEME_PALETTE_IDS,
  PRESET_THEME_IDS,
  SEMANTIC_CUSTOM_THEME_MODE_IDS,
  SEMANTIC_CUSTOM_THEME_PALETTE_IDS
} from '@shared/themes';
import { CommandService } from './command-service';
import { formatToolActivityDone, formatToolActivityStart } from './tool-activity-phrases';
import { searchWeb } from './web-search';
import { WorkspaceService } from './workspace-service';

function safeJsonParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isToolApprovalDeniedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ToolApprovalDeniedError' || /\bdenied\b.*\b(user|leader)\b/i.test(error.message))
  );
}

function toolApprovalDeniedResult(tool: string, rawArgs: string, error: unknown): string {
  const message = error instanceof Error ? error.message : 'The requested tool action was denied.';
  return JSON.stringify(
    {
      ok: false,
      error: 'tool_approval_denied',
      tool,
      message,
      attempted_arguments: safeJsonParse(rawArgs) ?? rawArgs,
      guidance:
        'The user denied this tool action. Do not stop. Explain what you were trying to do and why, ask for approval with clearer context if the action is still needed, or choose a safer alternate approach that does not require the denied action.'
    },
    null,
    2
  );
}

function mapCompletionUsage(
  u:
    | {
        prompt_tokens?: number | null;
        completion_tokens?: number | null;
        total_tokens?: number | null;
        completion_tokens_details?: { reasoning_tokens?: number | null } | null;
      }
    | null
    | undefined
): ChatCompletionTokenUsage | undefined {
  if (!u) return undefined;
  const pt = u.prompt_tokens ?? 0;
  const ct = u.completion_tokens ?? 0;
  const tt = u.total_tokens ?? pt + ct;
  const rt = u.completion_tokens_details?.reasoning_tokens ?? undefined;
  return {
    promptTokens: pt,
    completionTokens: ct,
    totalTokens: tt,
    reasoningTokens: typeof rt === 'number' && Number.isFinite(rt) ? Math.max(0, rt) : undefined
  };
}

function addCompletionUsage(
  current: ChatCompletionTokenUsage | undefined,
  next: ChatCompletionTokenUsage | undefined
): ChatCompletionTokenUsage | undefined {
  if (!next) return current;
  if (!current) return next;
  return {
    promptTokens: current.promptTokens + next.promptTokens,
    completionTokens: current.completionTokens + next.completionTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    reasoningTokens:
      current.reasoningTokens != null || next.reasoningTokens != null
        ? (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0)
        : undefined
  };
}

/** When the Wizard workspace folder is renamed mid-turn, keep tool paths consistent for the rest of the stream. */
function remapActiveFilePathAfterWorkspaceRootChange(
  prevRoot: string | undefined,
  nextRoot: string,
  activeFilePath: string | undefined
): string | undefined {
  if (!prevRoot?.trim() || !activeFilePath?.trim()) return activeFilePath;
  const prevR = resolve(prevRoot.trim());
  const nextR = resolve(nextRoot.trim());
  if (prevR === nextR) return activeFilePath;
  const af = resolve(activeFilePath);
  const prefix = prevR.endsWith(sep) ? prevR : `${prevR}${sep}`;
  if (af === prevR || af.startsWith(prefix)) {
    return resolve(join(nextR, relative(prevR, af)));
  }
  return activeFilePath;
}

const normalizeBaseUrl = (kind: ProviderKind, baseUrl: string) => {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  if (kind === 'openrouter') {
    return trimmed;
  }

  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
};

const nativeOllamaBaseUrl = (baseUrl: string) => {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3).replace(/\/$/, '') : trimmed;
};

const createClient = (settings: AppSettings, kind: ProviderKind = settings.selectedProvider) => {
  const provider = settings.providers[kind];
  const headers =
    kind === 'openrouter'
      ? {
          'HTTP-Referer': provider.appUrl || 'https://example.local',
          'X-OpenRouter-Title': provider.appName || 'Mythra'
        }
      : undefined;

  return new OpenAI({
    baseURL: normalizeBaseUrl(kind, provider.baseUrl),
    apiKey: provider.apiKey || (kind === 'openrouter' ? 'openrouter' : kind),
    defaultHeaders: headers,
    dangerouslyAllowBrowser: false
  });
};

const openRouterReasoningPayload = (
  settings: AppSettings,
  kind: ProviderKind = settings.selectedProvider
): { reasoning?: { effort: Exclude<OpenRouterReasoningEffort, 'auto'> } } => {
  if (kind !== 'openrouter') return {};
  const effort = settings.providers.openrouter.reasoningEffort ?? 'auto';
  if (effort === 'auto') return {};
  return { reasoning: { effort } };
};

const withOpenRouterReasoning = <T extends Record<string, unknown>>(
  settings: AppSettings,
  kind: ProviderKind,
  body: T
): T => ({ ...body, ...openRouterReasoningPayload(settings, kind) });

const mapModelEntry = (entry: { id?: unknown; owned_by?: unknown }): ModelInfo => {
  const raw = entry as {
    context_length?: unknown;
    supported_parameters?: unknown;
    architecture?: {
      input_modalities?: unknown;
      output_modalities?: unknown;
    };
    pricing?: {
      prompt?: unknown;
      completion?: unknown;
      request?: unknown;
      image?: unknown;
      web_search?: unknown;
      internal_reasoning?: unknown;
      input_cache_read?: unknown;
      input_cache_write?: unknown;
    };
  };
  const inputModalities = Array.isArray(raw.architecture?.input_modalities)
    ? raw.architecture.input_modalities.filter((modality): modality is string => typeof modality === 'string')
    : undefined;
  const outputModalities = Array.isArray(raw.architecture?.output_modalities)
    ? raw.architecture.output_modalities.filter((modality): modality is string => typeof modality === 'string')
    : undefined;
  const supportedParameters = Array.isArray(raw.supported_parameters)
    ? raw.supported_parameters.filter((parameter): parameter is string => typeof parameter === 'string')
    : undefined;

  return {
    id: String(entry.id ?? ''),
    contextLength: typeof raw.context_length === 'number' ? raw.context_length : undefined,
    ownedBy: typeof entry.owned_by === 'string' ? entry.owned_by : undefined,
    inputModalities,
    outputModalities,
    supportedParameters,
    pricing: raw.pricing
      ? {
          prompt: typeof raw.pricing.prompt === 'string' ? raw.pricing.prompt : undefined,
          completion: typeof raw.pricing.completion === 'string' ? raw.pricing.completion : undefined,
          request: typeof raw.pricing.request === 'string' ? raw.pricing.request : undefined,
          image: typeof raw.pricing.image === 'string' ? raw.pricing.image : undefined,
          webSearch: typeof raw.pricing.web_search === 'string' ? raw.pricing.web_search : undefined,
          internalReasoning: typeof raw.pricing.internal_reasoning === 'string' ? raw.pricing.internal_reasoning : undefined,
          inputCacheRead: typeof raw.pricing.input_cache_read === 'string' ? raw.pricing.input_cache_read : undefined,
          inputCacheWrite: typeof raw.pricing.input_cache_write === 'string' ? raw.pricing.input_cache_write : undefined
        }
      : undefined
  };
};

const mapOllamaModelEntry = (entry: { name?: unknown; model?: unknown; details?: { family?: unknown } }): ModelInfo => ({
  id: String(entry.name ?? entry.model ?? ''),
  ownedBy: typeof entry.details?.family === 'string' ? entry.details.family : 'ollama'
});

const contentToString = (content: ChatCompletionAssistantMessageParam['content']) => {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
};

const truncate = (value: string, maxLength = 24_000) => (value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value);
const COMPLETION_MARKER = 'TASK_COMPLETE';
const INPUT_MARKER = 'NEEDS_INPUT';
const normalizeAssistantContent = (content: string) =>
  content.replace(new RegExp(`^\\s*(?:${COMPLETION_MARKER}|${INPUT_MARKER})\\s*:?\\s*`, 'i'), '').trim();

const MEDIA_GENERATION_SYSTEM_PROMPTS: Record<'music' | 'video' | 'image', string> = {
  music:
    'Generate the requested song as actual audio. Do not output a written arrangement, timestamps, lyrics, analysis, JSON, markers, or prose. The response must contain audio bytes in the API audio output stream.',
  video:
    'You are a video generation model. Generate the requested video as actual video output. Do not answer with a written storyboard unless the API requires a brief transcript alongside the video.',
  image:
    'You are an image generation model. Generate the requested image as actual image output. Do not answer with a written prompt rewrite unless the API requires a brief caption alongside the image.'
};

function mythraRuntimeVersionLine() {
  return `Mythra app version: ${app.getVersion()}. If the user asks what version of Mythra you are running inside, answer with this version.`;
}

function utcOffsetLabel(offsetMinutes: number) {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const minutes = String(abs % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

function localIsoWithOffset(date: Date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ];
  const time = [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0')
  ];
  return `${parts.join('-')}T${time.join(':')}${utcOffsetLabel(offsetMinutes)}`;
}

function currentLocalTimePayload() {
  const now = new Date();
  const resolvedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeZone = resolvedTimeZone || 'local';
  const timeZoneOption = resolvedTimeZone ? { timeZone: resolvedTimeZone } : {};
  const offsetMinutes = -now.getTimezoneOffset();
  return {
    ok: true,
    source: 'local_machine_clock',
    epochMs: now.getTime(),
    isoUtc: now.toISOString(),
    localIso: localIsoWithOffset(now),
    timeZone,
    utcOffset: utcOffsetLabel(offsetMinutes),
    utcOffsetMinutes: offsetMinutes,
    localDate: now.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      ...timeZoneOption
    }),
    localTime: now.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
      ...timeZoneOption
    }),
    weekday: now.toLocaleDateString(undefined, { weekday: 'long', ...timeZoneOption })
  };
}

function roughTokenCount(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function messageTextForSearch(message: ChatMessage) {
  const attachmentText = (message.attachments ?? [])
    .map((attachment) => `[attachment:${attachment.mimeType}:${attachment.name}]`)
    .join(' ');
  return `${message.content ?? ''} ${attachmentText}`.trim();
}

function chatMessagesText(chat: SavedChat) {
  return chat.messages.map(messageTextForSearch).join('\n');
}

function chatPreview(chat: SavedChat, max = 260) {
  const text = chatMessagesText(chat).replace(/\s+/g, ' ').trim();
  return truncate(text, max);
}

function chatKindLabel(chat: SavedChat | SavedChatMeta) {
  switch (chat.kind ?? 'normal') {
    case 'wizard-session':
      return 'wizard session';
    case 'nexus-session':
      return 'nexus session';
    case 'wizard':
      return 'wizard profile';
    case 'nexus':
      return 'nexus project';
    default:
      return 'normal chat';
  }
}

function safeChatToolLimit(value: unknown, fallback: number, max: number) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback;
}

function formatUsd(value: number) {
  if (!Number.isFinite(value)) return null;
  if (value === 0) return '$0.00';
  if (value < 0.0001) return `$${value.toFixed(8)}`;
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

function buildOpenRouterCostEstimate(
  model: string,
  usage: ChatCompletionTokenUsage | undefined,
  pricing: ModelInfo['pricing'] | undefined
): ChatMessageCostEstimate | undefined {
  if (!usage || !pricing) return undefined;
  const promptRate = Number(pricing.prompt ?? NaN);
  const completionRate = Number(pricing.completion ?? NaN);
  const internalReasoningRate = Number(pricing.internalReasoning ?? NaN);
  const requestRate = Number(pricing.request ?? 0);
  if (!Number.isFinite(promptRate) || !Number.isFinite(completionRate)) return undefined;
  const reasoningTokens = usage.reasoningTokens ?? 0;
  const hasSeparateReasoningRate = reasoningTokens > 0 && Number.isFinite(internalReasoningRate);
  const outputTokensForCompletionRate = hasSeparateReasoningRate
    ? Math.max(0, usage.completionTokens - reasoningTokens)
    : usage.completionTokens;
  const inputCostUsd = usage.promptTokens * promptRate;
  const outputCostUsd = outputTokensForCompletionRate * completionRate;
  const reasoningCostUsd = hasSeparateReasoningRate ? reasoningTokens * internalReasoningRate : undefined;
  const requestCostUsd = Number.isFinite(requestRate) ? requestRate : 0;
  const totalCostUsd = inputCostUsd + outputCostUsd + (reasoningCostUsd ?? 0) + requestCostUsd;
  return {
    provider: 'openrouter',
    model,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    inputCostUsd,
    outputCostUsd,
    reasoningCostUsd,
    requestCostUsd,
    totalCostUsd,
    display: formatUsd(totalCostUsd) ?? '$0.00',
    note:
      'Estimate from OpenRouter-reported token usage and model pricing. Prompt tokens include conversation context and tool-call rounds; completion tokens include visible output and provider-reported reasoning tokens when included upstream.'
  };
}

const GENERATED_MEDIA_DIR = 'generated-media';
const MEDIA_CHAT_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(resolveWait, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });

function safeGeneratedMediaChatId(conversationId: string | undefined, requestId: string) {
  const candidate = conversationId?.trim();
  return candidate && MEDIA_CHAT_ID_RE.test(candidate) ? candidate : requestId;
}

function extensionForMimeType(mimeType: string) {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('quicktime')) return 'mov';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  if (mimeType.includes('flac')) return 'flac';
  return 'bin';
}

function detectMediaMimeType(bytes: Buffer, declaredMimeType: string) {
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') {
    return 'audio/wav';
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  return declaredMimeType;
}

function parseDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  return {
    mimeType: match[1] || 'application/octet-stream',
    bytes: Buffer.from(match[2] || '', 'base64')
  };
}

function lastUserPrompt(messages: ChatMessage[]) {
  return [...messages].reverse().find((message) => message.role === 'user')?.content.trim() || '';
}

function resolveProviderUrl(pathOrUrl: string, baseUrl: string) {
  return new URL(pathOrUrl, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href;
}

function parseOpenRouterSseEvent(raw: string): unknown | null {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (!data || data === '[DONE]') return null;
  return JSON.parse(data);
}

/** Shown in the second system block so models can emit a placeholder replaced by a real UI control in the client. */
const mythraSessionModeEmbedInstruction = `Mythra inline control: you may place this exact token alone on its own line in your reply. The app will replace it with a real Chat/Agent switch. Do not change characters, add spaces inside the token, or put other text on the same line. Use only when the user needs to change session mode. If this prompt already includes "UI session mode: Agent", do not ask them to switch to Agent and do not include this token. Token: ${MYTHRA_SESSION_MODE_TOGGLE}`;

const mythraWebSearchEmbedInstruction = `Mythra inline Web toggle token ${MYTHRA_WEB_SEARCH_TOGGLE}: use ONLY when the chat header "Web" switch is OFF and you want an in-message control so the user can turn web_search on. When "Web" is already ON (see the UI state line in this prompt), do NOT include this token—it would duplicate the header and must not appear. If Web is on, use web_search directly for lookups. Do not change characters or spacing inside the token.`;

/** Lets the model know whether emitting the web embed token is appropriate. */
const webHeaderUiStateLine = (webOn: boolean) =>
  webOn
    ? `UI: Chat header "Web" is ON; web_search is available. Do not put ${MYTHRA_WEB_SEARCH_TOGGLE} in your message.`
    : `UI: Chat header "Web" is OFF; web_search is disabled until the user enables "Web". You may use ${MYTHRA_WEB_SEARCH_TOGGLE} on its own line to show an inline switch, or tell them to use the header toggle.`;

const sessionModeUiStateLine = (mode: SessionMode) =>
  mode === 'agent'
    ? 'UI session mode: Agent (authoritative for this request). Files, shell, workspace, and theme tools may be used when listed below. Do not tell the user to switch to Agent mode or say they must enable Agent—the UI line above the chat already reflects their choice.'
    : 'UI session mode: Chat. You cannot use workspace files, shell, or theme-change tools; invite the user to switch with the Chat/Agent control only if they need those features.';

/** Shown when web_search is enabled; DuckDuckGo instant answers are not full search pages. */
const mythraWebSearchToolRoutingHint = `web_search: Mythra follows your Web Search provider choice (Settings): DuckDuckGo only, or Tavily-then-Brave / Brave-then-Tavily for whichever API keys are saved—each failure (including quota) skips to the next step, ending on DuckDuckGo instant answers. Failed steps appear in the tool result. DuckDuckGo only returns short blurbs and links, not full pages. For weather, include a resolvable place (city/region) in the query; when DuckDuckGo has no answer, a built-in Open-Meteo fallback may return approximate current conditions (not GPS/“here”). Write tight, distinctive queries: key nouns, exact product or library names, error strings in quotes, or a year for time-sensitive items. If the result is empty or off-topic, call web_search again with different wording before giving up. If still nothing, say that honestly; do not invent URLs or facts the tool did not return.`;

const mythraThemeInChatModeInstruction = `App theme: In Chat mode you cannot read or change the theme (no get_app_theme, set_custom_theme, set_app_theme, revert_app_theme, merge_custom_theme_tokens). You cannot call get_tool_access, get_system_prompt, or change tool permissions—switch to Agent mode first. If the user asks what theme is active, to change the theme, palette, or to revert a theme, say they need Agent mode first, and include the session-mode line so they get an inline switch: ${MYTHRA_SESSION_MODE_TOGGLE}`;

const mythraSetAppThemeAgentInstruction =
  'App theme (Agent only): For full custom colors call set_custom_theme with an explicit palette from ' +
  `(${SEMANTIC_CUSTOM_THEME_PALETTE_IDS.join(', ')}) and mode light or dark when brightness matters—do not rely only on the description string for routing (e.g. user asks for **red** → palette **red**, not pink). ` +
  'For targeted recolors ("sidebar only", exact hex), use merge_custom_theme_tokens with slots or whitelisted CSS variables. ' +
  `set_app_theme only applies fixed preset tiles (${PRESET_THEME_IDS.join(', ')}). revert_app_theme undoes the last change. After a successful theme change, reply in one short sentence and do not describe colors that differ from the tool result. ` +
  '**Mystic chat background:** When Settings → chat background is **Mythic**, artwork tracks the UI theme. For **Custom** app themes, **light** custom uses the **ice** Mystic image and **dark** custom uses the **neon** Mystic image; the UI layers **--chat-thread-bg** and bubble-related tokens (**--chat-assistant-bg**, **--chat-user-bg**, **--thinking-bg**) on top so the conversation area tints to match the palette. Prefer this coordinated look—after set_custom_theme you may call merge_custom_theme_tokens on **chatThread** / **assistantMessage** / **userMessage** with rgba washes of the accent if the user wants a stronger match.';

const mythraModelSystemPromptInstruction =
  'System prompt: in Agent mode you may always call get_system_prompt to read the stored global assistant instructions—it works even when “AI can change system prompt” is off and does not modify settings. If Tool access allows `set_system_prompt`, call it only when the user explicitly asks you to replace those instructions; it overwrites the full global prompt and saves to disk. Call get_tool_access to read Tool access toggles.';

const mythraToolAccessReadInstruction =
  'Tool access: call get_tool_access when the user asks which capabilities are enabled or disabled in Settings → Tool access (files, workspace search, commands, changing the stored system prompt via set_system_prompt). Reading the stored prompt is always done with get_system_prompt in Agent mode, independent of those toggles.';

const mythraCurrentTimeInstruction =
  'Current time/date: If the user asks for the current time, date, weekday, timezone, today/tomorrow/yesterday, deadlines, schedules, logs “from today”, or anything that depends on the local clock, call get_current_time first. Use its local machine time as authoritative; do not guess from model training data.';

const mythraAppToolInstruction = [
  'Mythra app tools: use search_chat_history when the user asks about prior conversations, asks where something was discussed, or needs context from another saved Chat/Wizard/Nexus session; use read_chat_messages when you need exact turns from the current chat or a specific saved chat returned by search. Use these instead of claiming you cannot access saved chat history.',
  'Use get_app_settings_summary when the user asks what provider/model/mode/tools/version/workspace state Mythra is using, what features are currently enabled, or what this app can do in the current context. Mention the Mythra version from the runtime line when asked. Use estimate_model_cost before unusually large OpenRouter requests or whenever the user asks about pricing/cost.',
  'Use get_current_time for any time/date/week/day/deadline question. In Agent/Wizard/Nexus sessions with a workspace, use list_recent_files to orient around recently changed files, summarize_file for long documents/code/PDFs instead of manually reading huge files, describe_image for local image files, and transcribe_audio for local audio files. read_file can extract PDF text, automatically OCR low/no-text pages, and OCR requested page ranges; summarize_file is better for broad "what is this file about?" requests.',
  'Use rename_current_chat when the user asks to rename the current Chat/Wizard/Nexus session or when a concise title would clearly help organization. In Wizard sessions, call create_wizard_memory proactively when the user states a durable preference, correction, identity fact, project fact, workflow rule, or reusable lesson that should persist across future sessions.'
].join(' ');

/** Grounds answers about Mythra itself so models do not deny sidebar features that always exist in this app. */
const mythraProductFeaturesInstruction = [
  'Mythra product knowledge (describe accurately when users ask how Mythra works, what you can do, where something is, or what the app is for; do **not** say Mythra has no Wizards, no Nexus, no media chats, no file tools, no PDF tools, no chat history search, or no local-time access): Mythra is a desktop AI workspace for normal chat, Agent work on local files, media generation chats, persistent Wizards, and multi-Wizard Nexus projects.',
  'If the user asks "what can you do for me?", give a useful overview tailored to the active mode and mention relevant UI locations. In Chat mode, you can converse, search saved chat history, read prior chat messages, check local time/date, create interactive multiple-choice quizzes with clickable answer bubbles, render interactive charts/tables/stat cards for financial or numerical data, answer with safe colored text tags when requested, estimate OpenRouter model cost, and explain Mythra settings/features. Tell them Agent mode is needed for local file edits, shell commands, PDF/file inspection, image/audio inspection, and workspace operations.',
  'Main UI map: the left sidebar has **New**, **Open workspace**, **Open last workspace**, sometimes **Clear workspace**, and tabs for **CHATS**, **WIZARDS**, and **FILES**. The middle is the chat/thread area. The right Inspector has **EDITOR**, **CHANGES**, and **SETTINGS** tabs. The top chat header has the only normal Chat/Agent mode switch, active model name, Web toggle, connection status, and OpenRouter credits when enabled. The bottom message bar has image attach, OpenRouter reasoning lightbulb when supported, context meter, terminal button, and send/stop controls.',
  'Chats UI: **New** opens choices for a normal chat, Wizard, or Nexus project, and clicking elsewhere closes that menu. Normal chats can be renamed, deleted with confirmation, pinned to the top, and reordered by dragging within their pinned or unpinned group; pinned chats stay above unpinned chats. Chats with a per-chat model override show a visual indicator before opening, and media chats show Music/Video/Image badges in the sidebar.',
  'Providers and model controls: Mythra supports OpenRouter cloud models, LM Studio local/server models, and Ollama local models. The active model name in the header opens the OpenRouter model page when available. OpenRouter models can show remaining credits in the chat header when enabled in Settings, and some OpenRouter models expose reasoning levels through the lightbulb next to the image-attach button.',
  'Media chats: in normal **CHATS** mode, the bottom-left corner has **Music**, **Video**, and **Images** buttons. If a user asks to generate an image, song/music/audio, or video in a regular text chat, tell them they can start the matching media chat from those bottom-left buttons, choose an appropriate model, then prompt there. Mythra stores generated media locally inside that chat; users can play/view it in the chat, save it out, and deleting the chat deletes its local generated media. Generated images can open in a separate full-size viewer.',
  'Files, PDFs, and terminal: in Agent/Wizard/Nexus sessions with a workspace, Mythra can list/search/read files, read PDFs with embedded text plus selective OCR page ranges, summarize long files and PDFs, inspect local images/audio, edit files with approval controls, run tests/commands, show git diffs, and list recent files. The **FILES** tab shows the active workspace files; in Wizard files, clicking the workspace header opens that Wizard folder in Finder/Explorer. The terminal button is in the message bar and requires an open workspace.',
  'Wizards UI and behavior: the **WIZARDS** tab lists saved Wizards. Wizards can be pinned to the top and reordered by dragging within pinned or unpinned groups; pinned Wizards stay above unpinned Wizards. Each Wizard has its own local workspace folder, model, system prompt in Inspector → Settings → Wizard, and five default core Markdown files: identity.md, personality.md, tools.md, memory.md, corrections.md. Legacy Wizards may still have soul.md. Mythra injects every `.md` file in a Wizard workspace into each Wizard message. Wizard sessions can be renamed, can rename the Wizard/profile/workspace with approval, can create durable memories, and can be exported/imported as `.mythwiz` bundles.',
  'Good Wizard examples to suggest when useful: a writing-style or brand-voice assistant; a complex note system (PARA/Zettelkasten/second brain); a project or coding-stack specialist; meeting/research/journal workflows with dated notes; a creative persona or role-play character with a lore bible. Mythra does **not** create todo.md by default; users or Wizards can add extra `.md` guides/tasks if wanted.',
  'Nexus UI and behavior: the Wizards area has a **Wizards / Nexus** switch. New → Nexus creates a shared project workspace for two or more Wizards; the user picks one parent folder and Mythra creates a named project folder. Nexus projects can be pinned. Each member keeps private identity/personality/memory docs, while Nexus has a leader Wizard, mission text, relay mode, parallel mode, team/leader approval options, and a shared project workspace for file tools.',
  'Settings UI exact order in the right Inspector **SETTINGS** tab: **App Updates**, collapsible **Theme**, **Connection**, **System Prompt**, **Web Search**, **Tool Access**, then **Agent Autonomy** at the bottom. Do not tell users Session mode is under Theme; it is controlled from the Chat/Agent switch in the chat header or from the inline switch you can embed when appropriate.',
  'Settings details: App Updates has Check for updates, Release notes, install update when available, and an info icon for support. Theme has app theme tiles, chat background source, Gaussian blur, and custom image controls. Connection keeps the model selector visible and has collapsible details for provider, OpenRouter credits toggle, output cost estimates toggle, API key/base URL, and Test + Refresh for LM Studio/Ollama. System Prompt has preset controls and prompt editor. Web Search keeps the search provider visible and has collapsible details for provider notes plus Tavily/Brave keys. Tool Access has Read files, Write files, Workspace search, Command deck, and AI can change system prompt. Agent Autonomy at the very bottom has Full access mode, Continue until done, and Auto Step Limit.',
  'Full access mode location: if a user asks where to turn on Full access mode, say: open the right Inspector → SETTINGS, scroll to the bottom, find **Agent Autonomy**, then toggle **Full access mode**. It is not inside Theme and not one of the Tool Access checkboxes. Explain that Full access lets AI write/delete files and run commands without per-action approval.',
  'Message formatting: Mythra supports safe colored text tags in assistant output, so when users ask for green/orange/red/etc. text, use the supported `[color=... tone=...]...[/color]` syntax rather than HTML. Mythra also supports interactive multiple-choice quiz blocks with clickable answer bubbles, interactive data tables, summary stat cards, and inline chart blocks for financial/numerical data; mention those features when users ask about studying, practice, quizzes, analysis, finance, reports, dashboards, or what Mythra can do. Thinking content appears in collapsible Thinking blocks while capable models stream reasoning.'
].join(' ');

const mythraColoredTextInstruction =
  'Colored text: Mythra supports safe color tags in assistant markdown when the user asks for colored text or when a short label/status genuinely benefits from color. Syntax: `[color=green tone=normal]text[/color]`. Supported colors: red, orange, yellow, green, blue, purple, pink, gray, plus aliases danger, warning, success, info, muted. Supported tones: light, normal, dark. Do not use raw HTML, CSS, hex colors, or unsupported color names; otherwise write normal markdown. Use colored text sparingly unless the user specifically requests a whole section, quiz, or list in a color.';

const mythraQuizEmbedInstruction =
  'Interactive quizzes: when the user asks for a multiple-choice quiz, asks you to quiz them, asks for practice questions, asks for selectable answers, or asks to study with a quiz, create an interactive quiz instead of a plain Markdown list. Emit a `mythra-quiz` fenced JSON block so Mythra renders clickable answer bubbles. Format exactly: ```mythra-quiz\\n{"title":"Optional title","questions":[{"question":"Question text","choices":["Answer A","Answer B","Answer C","Answer D"]}]}\\n```. The JSON root must contain `questions`; each question must contain `question` and `choices`. Use plain strings only, valid JSON with double quotes, 2-8 choices per question, and usually 3-10 questions unless the user asks otherwise. Do not include correct answers, answer letters, explanations, or an answer key in the JSON or visible text unless the user explicitly asks for an answer key. After the user selects one answer for every question, Mythra automatically sends their numbered answers back to you; then grade, explain missed answers, and continue the study flow.';

const mythraDataEmbedInstruction =
  'Data embeds: when users ask for finance, budgets, portfolios, numerical reports, CSV/table analysis, forecasting, scenario comparison, spending categories, recurring expenses, or "make this easier to understand", use Mythra structured embeds when they clarify the answer. Use `mythra-stats` for small KPI cards, `mythra-table` for sortable/hideable row data, and `mythra-chart` for visual patterns. Do not over-visualize: skip charts for one or two numbers, very uncertain data, or when a short paragraph/table is clearer. Valid JSON only: double quotes, no comments/trailing commas, no invented numbers unless clearly labeled as assumptions in normal text. Stat cards format: ```mythra-stats\\n{"title":"Monthly snapshot","cards":[{"label":"Net cash flow","value":"$840","delta":"+12% vs last month","tone":"success"},{"label":"Largest expense","value":"Rent","detail":"$1,650"}]}\\n```. Card tones: neutral, success, warning, danger, info. Interactive table format: ```mythra-table\\n{"title":"Transactions","columns":[{"key":"date","label":"Date"},{"key":"category","label":"Category"},{"key":"amount","label":"Amount","align":"right"}],"rows":[{"date":"May 1","category":"Groceries","amount":84.23}]}\\n```. Tables are best for transactions, budget line items, comparisons, imports from CSV/spreadsheets, and drilldown details. Keep tables focused (usually under 100 rows and 12 columns). Charts: emit `mythra-chart` fenced JSON, not a plain `json` code block. Supported types: `bar` for category comparisons (use `data` for one series or `series` for grouped side-by-side bars), `line` for trends/forecasts/time series, `pie`/`donut` for allocation/composition, `stacked-bar` for category totals across periods only when the stack helps (monthly spending by category, revenue mix by quarter; avoid stacked charts when precise comparison of individual series matters), and `budget` for planned vs actual. Basic chart: ```mythra-chart\\n{"type":"bar","title":"Expenses by category","valuePrefix":"$","data":[{"label":"Food","value":420},{"label":"Gas","value":110}]}\\n```. Grouped bar chart for comparing multiple series per category: ```mythra-chart\n{"type":"bar","title":"Income vs expenses","valuePrefix":"$","series":[{"name":"Income","data":[{"label":"Jan","value":4500},{"label":"Feb","value":4500}]},{"name":"Expenses","data":[{"label":"Jan","value":3140},{"label":"Feb","value":3045}]}]}\n```. Multi-line chart for trends, forecasts, and scenarios: ```mythra-chart\\n{"type":"line","title":"Savings scenarios","valuePrefix":"$","series":[{"name":"Save $500/mo","data":[{"label":"Jun","value":2500},{"label":"Dec","value":5500}]},{"name":"Save $800/mo","data":[{"label":"Jun","value":2800},{"label":"Dec","value":7600}]}]}\\n```. Stacked bar: ```mythra-chart\\n{"type":"stacked-bar","title":"Monthly spending mix","valuePrefix":"$","series":[{"name":"Food","data":[{"label":"Jan","value":420},{"label":"Feb","value":390}]},{"name":"Transport","data":[{"label":"Jan","value":160},{"label":"Feb","value":180}]}]}\\n```. Budget chart: ```mythra-chart\\n{"type":"budget","title":"Budget vs actual","valuePrefix":"$","data":[{"label":"Food","budget":400,"actual":465},{"label":"Gas","budget":150,"actual":132}]}\\n```. Chart `data` items and series may include `details` arrays for hover/drilldown notes. Use `valuePrefix":"$"` for currency and `valueSuffix":"%"` for percentages. For recurring expense detection, forecast, and scenario work, present assumptions, then use stats/cards and charts/tables when helpful.';

const mythraCodingToolInstruction =
  'Mythra coding tools (apply_patch is validated by `git apply` from the workspace root — malformed hunks become “corrupt patch”): Before any edit, read_file the target so line context matches the file on disk. read_file can also extract readable text from PDF files in Agent/Wizard sessions; Mythra returns embedded PDF text by page and automatically OCRs low/no-text pages. For long PDFs, continue with pdf_start_page and pdf_page_count. If a page has embedded text but may also contain an image/table/scan with text, reread that page range with pdf_ocr=on. PDF results are read-only extracted text, not editable PDF content. apply_patch must be a single plain-text unified diff (no markdown fences, no prose). First line: `diff --git a/relative/path b/relative/path`; then `--- a/relative/path` and `+++ b/relative/path`; use one hunk per change with `@@ -start,count +start,count @@` where counts are line counts (single-line change is often `@@ -N,1 +N,1 @@`). Paths use forward slashes and match the repo relative to workspace root. Do not include `\\ No newline` unless the file truly needs it. If apply_patch fails, switch to replace_in_file (one exact contiguous match) or write_file for new/small files, then retry. Also use replace_in_file for one exact replacement, insert_after for small anchored inserts, rename_file for moves, get_git_diff after edits, search_symbols/get_file_outline to navigate, run_tests when useful. Every tool call: strict JSON only (double quotes, escape newlines in strings as \\n). Fix malformed JSON and retry; do not blame “relay” or Mythra for corrupt diffs.';

type StreamingToolAcc = Map<number, { id: string; name: string; args: string }>;

function mergeStreamingToolDelta(
  acc: StreamingToolAcc,
  delta: ChatCompletionChunk.Choice.Delta.ToolCall
) {
  const i = delta.index;
  const cur = acc.get(i) ?? { id: '', name: '', args: '' };
  if (delta.id) cur.id = delta.id;
  if (delta.function?.name) cur.name = delta.function.name;
  if (delta.function?.arguments) cur.args += delta.function.arguments;
  acc.set(i, cur);
}

function streamingToolAccToFunctionCalls(acc: StreamingToolAcc): ChatCompletionMessageFunctionToolCall[] {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, { id, name, args }]) => ({
      id: id || `call_${i}`,
      type: 'function' as const,
      function: { name, arguments: args }
    }));
}

/**
 * Some providers/models emit markdown fences or minor garbage around tool JSON; others stream broken JSON.
 * When this returns `ok: false`, the host returns a synthetic tool error so the model can self-correct instead of aborting the whole stream.
 */
function parseToolCallArgumentsJson(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false } {
  let candidate = raw.trim();
  if (!candidate) {
    return { ok: true, args: {} };
  }
  if (candidate.startsWith('```')) {
    const close = candidate.lastIndexOf('```');
    const firstNl = candidate.indexOf('\n');
    if (firstNl !== -1 && close > firstNl) {
      candidate = candidate.slice(firstNl + 1, close).trim();
    }
  }
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, args: parsed as Record<string, unknown> };
    }
  } catch {
    // fall through
  }
  return { ok: false };
}

/** Default 30 minutes per `streamChat` invocation; override with `MYTHRA_STREAM_CHAT_WALL_MS` (milliseconds). */
function resolveStreamChatWallMs(): number {
  const raw = process.env.MYTHRA_STREAM_CHAT_WALL_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1_800_000;
}

/** Abort when either the user stops the request or the wall-clock deadline is reached (requires runtime AbortSignal.timeout/any). */
function mergeStreamDeadline(controller: AbortController, wallMs: number): AbortSignal {
  if (wallMs <= 0) {
    return controller.signal;
  }
  try {
    const AS = AbortSignal as typeof AbortSignal & {
      timeout?: (ms: number) => AbortSignal;
      any?: (signals: AbortSignal[]) => AbortSignal;
    };
    if (typeof AS.timeout === 'function' && typeof AS.any === 'function') {
      return AS.any([controller.signal, AS.timeout(wallMs)]);
    }
  } catch {
    // ignore — fall back to user abort only
  }
  return controller.signal;
}

/** Leader APPROVE/DENY mini-call deadline (`MYTHRA_LEADER_APPROVAL_MS`, default 90s). */
function mergeLeaderApprovalDeadline(user: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (timeoutMs <= 0) {
    return user;
  }
  try {
    const AS = AbortSignal as typeof AbortSignal & {
      timeout?: (ms: number) => AbortSignal;
      any?: (signals: AbortSignal[]) => AbortSignal;
    };
    if (typeof AS.timeout !== 'function' || typeof AS.any !== 'function') {
      return user;
    }
    const wall = AS.timeout(timeoutMs);
    if (!user) {
      return wall;
    }
    return AS.any([user, wall]);
  } catch {
    return user;
  }
}

function resolveLeaderApprovalWallMs(): number {
  const raw = process.env.MYTHRA_LEADER_APPROVAL_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 90_000;
}

const extractModelReasoning = (message: unknown): string | undefined => {
  if (!message || typeof message !== 'object') {
    return;
  }

  const m = message as Record<string, unknown>;
  if (typeof m.reasoning === 'string' && m.reasoning.trim()) {
    return m.reasoning.trim();
  }

  if (m.reasoning_details != null) {
    if (typeof m.reasoning_details === 'string') {
      return m.reasoning_details.trim() || undefined;
    }

    try {
      return JSON.stringify(m.reasoning_details, null, 2);
    } catch {
      return String(m.reasoning_details);
    }
  }

  return;
};

const toApiMessage = (message: ChatMessage): ChatCompletionMessageParam => {
  if (message.role === 'user' && message.attachments?.length) {
    return {
      role: 'user',
      content: [
        ...(message.content
          ? [
              {
                type: 'text' as const,
                text: message.content
              }
            ]
          : []),
        ...message.attachments.map((attachment) => ({
          type: 'image_url' as const,
          image_url: {
            url: attachment.dataUrl,
            detail: 'auto' as const
          }
        }))
      ]
    };
  }

  return {
    role: message.role,
    content: message.content
  };
};

interface ChatRuntimeContext {
  workspaceRoot?: string;
  activeFilePath?: string;
  /** Opaque id for this chat thread; new on “New chat”, stable when loading a saved chat. */
  conversationId?: string;
  wizardId?: string;
  wizardName?: string;
  wizardSystemPrompt?: string;
  /** Per-Wizard Full access; when present (wizard sessions), gates approvals instead of global Settings.agent.fullAccess. */
  wizardFullAccess?: boolean;
  /** Per-Wizard: file tools may resolve paths outside workspaceRoot (local paths only). */
  wizardAllowOutsideWorkspace?: boolean;
  /** Nexus sessions: grant Full-access-equivalent tool approvals for every teammate stream. */
  nexusTeamFullAccess?: boolean;
  /** Nexus sessions: read-only references to teammate Wizard workspaces. */
  nexusTeamWorkspaces?: NexusTeamWorkspaceReference[];
  /** Nexus sessions: resolve risky tools via leader mini-completion instead of the human modal (ignored when nexusTeamFullAccess). */
  nexusLeaderApprovesTools?: boolean;
  nexusLeaderProvider?: ProviderKind;
  nexusLeaderModel?: string;
  nexusLeaderName?: string;
  mediaGenerationKind?: 'music' | 'video' | 'image';
}

/** Hidden Agent routing tokens that must never be pasted into `set_wizard_system_prompt`. */
function wizardPromptLooksLikeInjectedRouting(text: string): string | undefined {
  const markers: Array<[string, string]> = [
    ['[Mythra model routing', 'Mythra routing header'],
    ['[OpenKiwi model routing', 'legacy routing header'],
    ['[Mythra] Thread id:', 'thread routing line'],
    ['[OpenKiwi] Thread id:', 'legacy thread routing line'],
    ['Non-Wizard Tool access lines elsewhere in this prompt', 'routing reminder copied from this message']
  ];
  for (const [needle, label] of markers) {
    if (text.includes(needle)) return label;
  }
  return undefined;
}

/** Agent-mode lines about get_system_prompt / set_system_prompt vs Wizard-specific routing (set_wizard_system_prompt). */
function agentModeSystemPromptInstructions(settings: AppSettings, runtime: ChatRuntimeContext): string[] {
  if (runtime.wizardId) {
    const label = runtime.wizardName?.trim() || 'this Wizard';
    return [
      `Wizard session: you are running inside the "${label}" Wizard profile. The app merges this Wizard’s private instructions into the request; they are separate from the global System Prompt preset in Settings.`,
      'To change **this Wizard’s own** long-term instructions when the user asks, call `set_wizard_system_prompt` with the full new text. Mythra opens a before/after approval dialog—the user approves or rejects there. Do **not** tell them to enable “AI can change system prompt” under Settings → Tool access for Wizard instruction edits; that toggle only gates `set_system_prompt` (global provider prompt). `set_system_prompt` is not offered in Wizard chats.',
      '`get_wizard_system_prompt` reads this Wizard’s stored private instructions (read-only). Call it before small edits or `set_wizard_system_prompt`. `get_system_prompt` reads the separate **global System Prompt** preset in Settings—do not confuse the two.',
      '`set_wizard_display_name` updates the Wizard **shown name** in the sidebar and Inspector (stored profile). Mythra also renames the Wizard workspace folder on disk when the sanitized name no longer matches the folder name. When the user asks to rename you completely, call `set_wizard_display_name`, then edit identity.md and adjust `set_wizard_system_prompt` so identity text matches. For legacy Wizards, update soul.md if that is where identity still lives.',
      'Non-Wizard Tool access lines elsewhere in this prompt still apply to files, workspace search, and commands; Wizard prompt edits bypass the “AI can change system prompt” toggle.',
      '`set_wizard_system_prompt` must be **only** your Wizard’s authored persona/instructions text—the same kind of content shown in the Wizard editor—not hidden routing copied from this chat (never paste lines starting with `[Mythra model routing`, `[Mythra] Thread id`, workspace listings, or “Enabled tools:”). For small edits, call `get_wizard_system_prompt` first (and `read_file` on identity.md or personality.md when facts live there), then minimally adjust—do not paste large unrelated blocks.',
      'Identity belongs in identity.md, personality belongs in personality.md, and durable memory belongs in memory.md. For legacy Wizards, soul.md may still contain identity/personality. When the user revises who you are, how you should behave, or what to remember, update the relevant files with `write_file` so they stay authoritative.',
      'The app already appends a “Mythra Wizard runtime” reminder at send time; you usually should not duplicate long runtime explanations inside `system_prompt` unless the user explicitly asks.'
    ];
  }
  return [
    mythraModelSystemPromptInstruction,
    settings.tools.allowModelSystemPrompt
      ? 'set_system_prompt is enabled in Settings → you may update the system prompt when the user asks.'
      : 'set_system_prompt is disabled; the user can enable “AI can change system prompt” under Tool access. You can still call get_system_prompt anytime in Agent mode to read the stored prompt.'
  ];
}

interface ActiveRequest {
  controller: AbortController;
  stopped: boolean;
}

export class ModelService {
  private readonly activeRequests = new Map<string, ActiveRequest>();
  private readonly openRouterCostModelCache = new Map<string, { expiresAt: number; models: ModelInfo[] }>();

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly commandService: CommandService,
    /** Apply theme from `set_app_theme` / `revert_app_theme`; returns JSON string for the tool result. */
    private readonly applyAppTheme?: (rawThemeId: string) => Promise<string>,
    /** Current + previous theme for `get_app_theme` / `revert_app_theme`; returns JSON string. */
    private readonly getAppThemeState?: () => string,
    /** Merge whitelist token overrides into Custom theme; returns JSON for the tool result. */
    private readonly mergeCustomThemeTokens?: (incoming: Record<string, unknown>) => Promise<string>,
    /** Apply a complete semantic custom theme; returns JSON for the tool result. */
    private readonly setCustomTheme?: (incoming: Record<string, unknown>) => Promise<string>,
    /** Persist full settings (e.g. set_system_prompt); returns saved settings from disk. */
    private readonly persistAppSettings?: (updater: (base: AppSettings) => AppSettings) => Promise<AppSettings>,
    /** Persist one Wizard profile prompt without touching global provider prompts. */
    private readonly persistWizardSystemPrompt?: (wizardId: string, systemPrompt: string) => Promise<void>,
    /** Persist Wizard display name (sidebar + Wizard settings title); returns updated profile after possible folder rename. */
    private readonly persistWizardDisplayName?: (wizardId: string, displayName: string) => Promise<WizardProfile>,
    /** Renderer-hosted before/after approval for Wizard prompt edits. */
    private readonly requestWizardPromptApproval?: (window: BrowserWindow, wizardName: string, before: string, after: string) => Promise<void>,
    /** Renderer-hosted approval for file/command tools when Full access is off. */
    private readonly requestToolApprovalUi?: (
      window: BrowserWindow,
      title: string,
      detail: string,
      diff?: { before: string; after: string }
    ) => Promise<void>,
    /** Saved chat access for chat-history tools. */
    private readonly listSavedChats?: () => Promise<SavedChatMeta[]>,
    private readonly loadSavedChat?: (id: string) => Promise<SavedChat | null>,
    private readonly persistChatTitle?: (id: string, title: string) => Promise<void>
  ) {}

  async listModels(settings: AppSettings, providerKind?: ProviderKind, options?: ModelListOptions): Promise<ModelInfo[]> {
    const kind = providerKind ?? settings.selectedProvider;
    const outputModalities = options?.outputModalities?.filter((modality) => modality.trim()).map((modality) => modality.trim());
    if (kind === 'openrouter' && outputModalities?.length) {
      const provider = settings.providers.openrouter;
      const url = new URL(`${normalizeBaseUrl(kind, provider.baseUrl)}/models`);
      url.searchParams.set('output_modalities', outputModalities.join(','));
      const response = await fetch(url, {
        headers: {
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
          'HTTP-Referer': provider.appUrl || 'https://example.local',
          'X-OpenRouter-Title': provider.appName || 'Mythra'
        }
      });
      if (!response.ok) {
        throw new Error(`OpenRouter model list failed (${response.status}).`);
      }
      const body = (await response.json()) as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
      return (body.data ?? []).map(mapModelEntry);
    }

    if (kind === 'ollama') {
      const provider = settings.providers.ollama;
      try {
        const client = createClient(settings, kind);
        const response = await client.models.list();
        const openAiModels = (response.data ?? []).map(mapModelEntry).filter((model) => model.id);
        if (openAiModels.length > 0) return openAiModels;
      } catch {
        /* Older Ollama installs may not expose /v1/models; fall back to the native tags endpoint. */
      }

      const response = await fetch(`${nativeOllamaBaseUrl(provider.baseUrl)}/api/tags`);
      if (!response.ok) {
        throw new Error(`Ollama model list failed (${response.status}).`);
      }
      const body = (await response.json()) as { models?: Array<{ name?: unknown; model?: unknown; details?: { family?: unknown } }> };
      return (body.models ?? []).map(mapOllamaModelEntry).filter((model) => model.id);
    }

    const client = createClient(settings, kind);
    const response = await client.models.list();

    return (response.data ?? []).map(mapModelEntry);
  }

  private async getOpenRouterModelsForCost(settings: AppSettings): Promise<ModelInfo[]> {
    const provider = settings.providers.openrouter;
    const key = normalizeBaseUrl('openrouter', provider.baseUrl);
    const now = Date.now();
    const cached = this.openRouterCostModelCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.models;
    }
    const models = await this.listModels(settings, 'openrouter');
    this.openRouterCostModelCache.set(key, { expiresAt: now + 5 * 60 * 1000, models });
    return models;
  }

  private async estimateOpenRouterResponseCost(
    settings: AppSettings,
    model: string,
    usage: ChatCompletionTokenUsage | undefined
  ): Promise<ChatMessageCostEstimate | undefined> {
    if (!usage || settings.selectedProvider !== 'openrouter') return undefined;
    try {
      const models = await this.getOpenRouterModelsForCost(settings);
      const pricing = models.find((item) => item.id === model)?.pricing;
      return buildOpenRouterCostEstimate(model, usage, pricing);
    } catch {
      return undefined;
    }
  }

  stopRequest(requestId: string) {
    const active = this.activeRequests.get(requestId);
    if (!active) {
      return false;
    }

    active.stopped = true;
    active.controller.abort();
    this.activeRequests.delete(requestId);
    return true;
  }

  async streamChat(
    _event: IpcMainInvokeEvent,
    window: BrowserWindow,
    requestId: string,
    settings: AppSettings,
    messages: ChatMessage[],
    runtime: ChatRuntimeContext
  ) {
    const provider = settings.providers[settings.selectedProvider];
    if (!provider.model) {
      throw new Error('Select a model before sending a chat request.');
    }

    const controller = new AbortController();
    this.activeRequests.set(requestId, { controller, stopped: false });

    try {
      const client = createClient(settings);
      const isTalk = settings.ui.sessionMode === 'talk';
      const sessionContext = await this.buildSessionContext(settings, runtime);
      let lastVisibleAssistantContent = '';
      const streamDeadlineSignal = mergeStreamDeadline(controller, resolveStreamChatWallMs());

      const apiMessages: ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: runtime.mediaGenerationKind
            ? `${MEDIA_GENERATION_SYSTEM_PROMPTS[runtime.mediaGenerationKind]}\n${mythraRuntimeVersionLine()}`
            : provider.systemPrompt
        },
        ...(runtime.mediaGenerationKind ? [] : [{ role: 'system' as const, content: sessionContext }]),
        ...messages.map((message) => toApiMessage(message))
      ];

      const toolDefinitions = this.buildToolDefinitions(settings, runtime);

      if (isTalk && toolDefinitions.length === 0) {
        if (runtime.mediaGenerationKind === 'music') {
          await this.runAudioGenerationStream(settings, window, requestId, provider.model, apiMessages, controller, runtime.conversationId);
        } else if (runtime.mediaGenerationKind === 'image') {
          await this.runImageGeneration(settings, client, window, requestId, provider.model, apiMessages, controller, runtime.conversationId);
        } else if (runtime.mediaGenerationKind === 'video') {
          await this.runVideoGeneration(window, requestId, settings, provider.model, lastUserPrompt(messages), controller, runtime.conversationId);
        } else {
          await this.runTalkStream(client, window, requestId, settings, provider.model, apiMessages, controller);
        }
        return;
      }

      const maxAutoSteps = settings.agent.autoContinue ? Math.max(4, settings.agent.maxAutoSteps || 24) : 1;

      let turnUsage: ChatCompletionTokenUsage | undefined;
      let lastRoundUsage: ChatCompletionTokenUsage | undefined;

      for (let step = 0; step < maxAutoSteps; step += 1) {
        this.assertNotStopped(requestId);

        const stream = await client.chat.completions.create(
          withOpenRouterReasoning(settings, settings.selectedProvider, {
            model: provider.model,
            messages: apiMessages,
            tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
            tool_choice: toolDefinitions.length > 0 ? 'auto' : undefined,
            stream: true,
            stream_options: { include_usage: true }
          }) as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
          {
            signal: streamDeadlineSignal
          }
        );

        let assembled = '';
        let assembledReasoning = '';
        const toolAcc: StreamingToolAcc = new Map();
        let lastFinish: ChatCompletionChunk.Choice['finish_reason'] = null;
        let lastStreamUsage: ChatCompletionTokenUsage | undefined;

        for await (const chunk of stream) {
          this.assertNotStopped(requestId);
          if (chunk.usage) {
            const mapped = mapCompletionUsage(chunk.usage);
            if (mapped) {
              lastStreamUsage = mapped;
            }
          }
          const ch = chunk.choices[0];
          if (!ch) {
            continue;
          }
          if (ch.finish_reason) {
            lastFinish = ch.finish_reason;
          }
          const { delta } = ch;
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            assembled += delta.content;
            window.webContents.send('chat:delta', { requestId, delta: delta.content });
          }
          const dAny = delta as Record<string, unknown>;
          if (typeof dAny.reasoning === 'string' && dAny.reasoning.length > 0) {
            const r = dAny.reasoning;
            assembledReasoning += r;
            window.webContents.send('chat:delta', { requestId, delta: '', reasoningDelta: r });
          }
          if (delta.tool_calls?.length) {
            for (const tc of delta.tool_calls) {
              mergeStreamingToolDelta(toolAcc, tc);
            }
          }
        }

        this.assertNotStopped(requestId);
        if (lastStreamUsage) {
          lastRoundUsage = lastStreamUsage;
          turnUsage = addCompletionUsage(turnUsage, lastStreamUsage);
        }

        const toolCallsFromStream = streamingToolAccToFunctionCalls(toolAcc);
        if (lastFinish === 'tool_calls' && toolCallsFromStream.length === 0) {
          throw new Error('The model requested tools but the streamed tool payload was incomplete. Try again.');
        }

        if (toolCallsFromStream.length) {
          apiMessages.push({
            role: 'assistant',
            content: assembled || null,
            tool_calls: toolCallsFromStream
          });

          for (const toolCall of toolCallsFromStream) {
            if (toolCall.type !== 'function') {
              continue;
            }

            const rawArgs = toolCall.function.arguments ?? '';
            const parsedArgs = parseToolCallArgumentsJson(rawArgs);
            if (!parsedArgs.ok) {
              this.emitActivity(
                window,
                requestId,
                'warning',
                `${toolCall.function.name}: invalid JSON tool arguments — sending recovery hint to the model.`
              );
              apiMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: truncate(
                  JSON.stringify(
                    {
                      ok: false,
                      error: 'invalid_tool_arguments_json',
                      tool: toolCall.function.name,
                      guidance:
                        'Arguments must be one JSON object with double-quoted keys and strings. For write_file use {"path":"relative/path.ext","content":"<file body as an escaped JSON string>"}. Escape literal quotes as \\", tabs/newlines as \\t / \\n.',
                      raw_preview: truncate(rawArgs, 2000)
                    },
                    null,
                    2
                  ),
                  18_000
                )
              });
              continue;
            }

            this.emitActivity(
              window,
              requestId,
              toolCall.function.name === 'run_command' ? 'command' : 'tool',
              formatToolActivityStart(toolCall.function.name, rawArgs, settings)
            );

            let toolResult: string;
            let approvalDenied = false;
            try {
              toolResult = await this.executeToolCall(
                window,
                requestId,
                settings,
                runtime,
                toolCall,
                parsedArgs.args,
                messages
              );
            } catch (error) {
              if (!isToolApprovalDeniedError(error)) {
                throw error;
              }
              approvalDenied = true;
              toolResult = toolApprovalDeniedResult(toolCall.function.name, rawArgs, error);
              this.emitActivity(
                window,
                requestId,
                'warning',
                `${toolCall.function.name}: denied; returning denial to the model so it can continue.`
              );
            }
            this.assertNotStopped(requestId);

            apiMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: truncate(toolResult, 18_000)
            });

            if (!approvalDenied) {
              this.emitActivity(window, requestId, 'success', formatToolActivityDone(toolCall.function.name, rawArgs));
            }
          }

          continue;
        }

        const content = contentToString(assembled);
        const normalizedContent = normalizeAssistantContent(content);

        if (!normalizedContent) {
          apiMessages.push({
            role: 'assistant',
            content: assembled
          });
          apiMessages.push({
            role: 'user',
            content:
              `Your last assistant message was empty in the user’s chat. Write a short, natural visible reply. If you just used tools, summarize what you found or did in plain language.`
          });
          this.emitActivity(window, requestId, 'warning', 'The model returned a blank message. Requesting a visible summary.');
          continue;
        }

        lastVisibleAssistantContent = normalizedContent;

        const done: ChatStreamDone = {
          requestId,
          content: normalizedContent,
          reasoning: assembledReasoning.trim() || undefined,
          usage: turnUsage ?? lastStreamUsage,
          costEstimate: await this.estimateOpenRouterResponseCost(settings, provider.model, turnUsage ?? lastStreamUsage)
        };
        window.webContents.send('chat:done', done);
        this.activeRequests.delete(requestId);
        return;
      }

      this.emitActivity(
        window,
        requestId,
        'warning',
        `Step limit (${maxAutoSteps} tool rounds) reached. Returning the latest reply instead of failing.`
      );
      const done: ChatStreamDone = {
        requestId,
        content:
          lastVisibleAssistantContent ||
          `I hit the per-message step limit (${maxAutoSteps} tool rounds) before finishing. Ask me to continue and I can pick up from here.`,
        usage: turnUsage ?? lastRoundUsage,
        costEstimate: await this.estimateOpenRouterResponseCost(settings, provider.model, turnUsage ?? lastRoundUsage)
      };
      window.webContents.send('chat:done', done);
      this.activeRequests.delete(requestId);
      return;
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  private async runTalkStream(
    client: OpenAI,
    window: BrowserWindow,
    requestId: string,
    settings: AppSettings,
    model: string,
    apiMessages: ChatCompletionMessageParam[],
    controller: AbortController
  ) {
    const finish = async (done: ChatStreamDone) => {
      window.webContents.send('chat:done', {
        ...done,
        costEstimate:
          done.costEstimate ??
          (await this.estimateOpenRouterResponseCost(settings, model, done.usage))
      } satisfies ChatStreamDone);
      this.activeRequests.delete(requestId);
    };

    try {
      const streamSignal = mergeStreamDeadline(controller, resolveStreamChatWallMs());
      const stream = await client.chat.completions.create(
        withOpenRouterReasoning(settings, settings.selectedProvider, {
          model,
          messages: apiMessages,
          stream: true,
          stream_options: { include_usage: true }
        }) as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        { signal: streamSignal }
      );

      let assembled = '';
      let assembledReasoning = '';
      let sawTool = false;
      let lastStreamUsage: ChatCompletionTokenUsage | undefined;

      for await (const chunk of stream) {
        this.assertNotStopped(requestId);
        if (chunk.usage) {
          const mapped = mapCompletionUsage(chunk.usage);
          if (mapped) {
            lastStreamUsage = mapped;
          }
        }
        const ch = chunk.choices[0];
        if (ch?.finish_reason === 'tool_calls') {
          sawTool = true;
          break;
        }

        if (!ch?.delta) {
          continue;
        }

        const d = ch.delta as Record<string, unknown>;
        if (d.tool_calls) {
          sawTool = true;
        }

        const text = d.content;
        if (typeof text === 'string' && text) {
          assembled += text;
          window.webContents.send('chat:delta', { requestId, delta: text });
        }

        const r = d.reasoning;
        if (typeof r === 'string' && r) {
          assembledReasoning += r;
          window.webContents.send('chat:delta', { requestId, delta: '', reasoningDelta: r });
        }
      }

      if (sawTool) {
        await finish({
          requestId,
          content:
            'In Chat mode the assistant cannot use file or shell tools. If you need those, switch to Agent with the Chat/Agent control at the top of the chat, then use Open Workspace to mount a folder if you need the project, and try again.',
          usage: lastStreamUsage
        });
        return;
      }

      const talkNorm = normalizeAssistantContent(assembled);
      if (!talkNorm) {
        await finish({ requestId, content: 'The model returned an empty reply. Try your message again.', usage: lastStreamUsage });
        return;
      }

      const reasoning = assembledReasoning.trim() || undefined;
      await finish({ requestId, content: talkNorm, reasoning, usage: lastStreamUsage });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }

      const completion = await client.chat.completions.create(
        withOpenRouterReasoning(settings, settings.selectedProvider, { model, messages: apiMessages }) as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        { signal: mergeStreamDeadline(controller, resolveStreamChatWallMs()) }
      );
      this.assertNotStopped(requestId);
      const fallbackUsage = mapCompletionUsage(completion.usage ?? undefined);
      const assistantMessage = completion.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error('The model returned no message.');
      }

      if (assistantMessage.tool_calls?.length) {
        await finish({
          requestId,
          content:
            'In Chat mode the assistant cannot use file or shell tools. If you need those, switch to Agent with the Chat/Agent control at the top of the chat, then use Open Workspace to mount a folder if you need the project, and try again.',
          usage: fallbackUsage
        });
        return;
      }

      const talkContent = contentToString(assistantMessage.content);
      const talkNorm = normalizeAssistantContent(talkContent);
      if (!talkNorm) {
        await finish({ requestId, content: 'The model returned an empty reply. Try your message again.', usage: fallbackUsage });
        return;
      }

      const reasoning = extractModelReasoning(assistantMessage);
      await finish({ requestId, content: talkNorm, reasoning, usage: fallbackUsage });
    }
  }

  private async saveGeneratedMediaFile(
    conversationId: string | undefined,
    requestId: string,
    baseName: string,
    mimeType: string,
    bytes: Buffer
  ): Promise<ChatAttachment> {
    const chatId = safeGeneratedMediaChatId(conversationId, requestId);
    const mediaDir = join(app.getPath('userData'), GENERATED_MEDIA_DIR, chatId);
    await mkdir(mediaDir, { recursive: true });
    const safeBase = baseName.replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'generated-media';
    const actualMimeType = detectMediaMimeType(bytes, mimeType);
    const fileName = `${Date.now()}-${requestId}-${safeBase}.${extensionForMimeType(actualMimeType)}`;
    const filePath = join(mediaDir, fileName);
    await writeFile(filePath, bytes);
    return {
      id: randomUUID(),
      name: fileName,
      mimeType: actualMimeType,
      dataUrl: `data:${actualMimeType};base64,${bytes.toString('base64')}`,
      filePath
    };
  }

  private async saveGeneratedDataUrl(
    conversationId: string | undefined,
    requestId: string,
    baseName: string,
    dataUrl: string
  ): Promise<ChatAttachment | null> {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return null;
    return this.saveGeneratedMediaFile(conversationId, requestId, baseName, parsed.mimeType, parsed.bytes);
  }

  private async collectAudioGenerationChunks(
    settings: AppSettings,
    requestId: string,
    model: string,
    messages: ChatCompletionMessageParam[],
    controller: AbortController,
    modalities: string[]
  ): Promise<{ audioChunks: string[]; transcript: string; text: string; usage?: ChatCompletionTokenUsage }> {
    const provider = settings.providers[settings.selectedProvider];
    const baseUrl = normalizeBaseUrl(settings.selectedProvider, provider.baseUrl);
    const streamSignal = mergeStreamDeadline(controller, resolveStreamChatWallMs());
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
        ...(settings.selectedProvider === 'openrouter'
          ? {
              'HTTP-Referer': provider.appUrl || 'https://example.local',
              'X-OpenRouter-Title': provider.appName || 'Mythra'
            }
          : {})
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        modalities,
        audio: { format: 'mp3' }
      }),
      signal: streamSignal
    });

    if (!response.ok) {
      throw new Error(`Audio generation request failed (${response.status}).`);
    }
    if (!response.body) {
      throw new Error('Audio generation returned no response stream.');
    }

    let text = '';
    let transcript = '';
    const audioChunks: string[] = [];
    let usage: ChatCompletionTokenUsage | undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      this.assertNotStopped(requestId);
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const event of events) {
        if (!event.trim()) continue;
        const parsed = parseOpenRouterSseEvent(event) as
          | {
              usage?: {
                prompt_tokens?: number | null;
                completion_tokens?: number | null;
                total_tokens?: number | null;
                completion_tokens_details?: { reasoning_tokens?: number | null } | null;
              } | null;
              choices?: Array<{
                delta?: {
                  content?: unknown;
                  audio?: { data?: unknown; transcript?: unknown };
                };
              }>;
            }
          | null;
        if (!parsed) continue;
        const mappedUsage = parsed.usage ? mapCompletionUsage(parsed.usage) : undefined;
        if (mappedUsage) usage = mappedUsage;
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string') text += delta.content;
        if (typeof delta.audio?.data === 'string' && delta.audio.data.length > 0) audioChunks.push(delta.audio.data);
        if (typeof delta.audio?.transcript === 'string' && delta.audio.transcript.length > 0) transcript += delta.audio.transcript;
      }
    }

    return { audioChunks, transcript, text, usage };
  }

  private async runAudioGenerationStream(
    settings: AppSettings,
    window: BrowserWindow,
    requestId: string,
    model: string,
    apiMessages: ChatCompletionMessageParam[],
    controller: AbortController,
    conversationId: string | undefined
  ) {
    let result = await this.collectAudioGenerationChunks(settings, requestId, model, apiMessages, controller, ['text', 'audio']);

    this.assertNotStopped(requestId);

    if (result.audioChunks.length === 0) {
      this.emitActivity(window, requestId, 'warning', 'The first audio attempt returned text only. Retrying as audio-only.');
      result = await this.collectAudioGenerationChunks(settings, requestId, model, apiMessages, controller, ['audio']);
    }

    this.assertNotStopped(requestId);

    if (result.audioChunks.length === 0) {
      const textPreview = normalizeAssistantContent(result.transcript || result.text).slice(0, 320);
      window.webContents.send('chat:done', {
        requestId,
        content: textPreview
          ? `The model returned text instead of an audio file. Preview: ${textPreview}${textPreview.length === 320 ? '...' : ''}`
          : 'The model did not return an audio file. Try again or choose another music model.',
        usage: result.usage,
        costEstimate: await this.estimateOpenRouterResponseCost(settings, model, result.usage)
      } satisfies ChatStreamDone);
      this.activeRequests.delete(requestId);
      return;
    }

    const attachment = await this.saveGeneratedMediaFile(
      conversationId,
      requestId,
      model,
      'audio/mpeg',
      Buffer.from(result.audioChunks.join(''), 'base64')
    );

    window.webContents.send('chat:done', {
      requestId,
      content: 'Generated audio.',
      attachments: [attachment],
      usage: result.usage,
      costEstimate: await this.estimateOpenRouterResponseCost(settings, model, result.usage)
    } satisfies ChatStreamDone);
    this.activeRequests.delete(requestId);
  }

  private async runImageGeneration(
    settings: AppSettings,
    client: OpenAI,
    window: BrowserWindow,
    requestId: string,
    model: string,
    apiMessages: ChatCompletionMessageParam[],
    controller: AbortController,
    conversationId: string | undefined
  ) {
    const streamSignal = mergeStreamDeadline(controller, resolveStreamChatWallMs());
    const create = async (modalities: string[]) =>
      client.chat.completions.create(
        {
          model,
          messages: apiMessages,
          stream: false,
          modalities
        } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        { signal: streamSignal }
      );

    let completion: Awaited<ReturnType<typeof create>>;
    try {
      completion = await create(['image', 'text']);
    } catch (error) {
      this.assertNotStopped(requestId);
      completion = await create(['image']);
    }

    this.assertNotStopped(requestId);
    const message = completion.choices[0]?.message as
      | (ChatCompletionAssistantMessageParam & {
          images?: Array<{ image_url?: { url?: unknown }; imageUrl?: { url?: unknown } }>;
        })
      | undefined;
    const imageUrls =
      message?.images
        ?.map((image) => image.image_url?.url ?? image.imageUrl?.url)
        .filter((url): url is string => typeof url === 'string' && url.startsWith('data:image/')) ?? [];

    const attachments = (
      await Promise.all(
        imageUrls.map((url, index) => this.saveGeneratedDataUrl(conversationId, requestId, `${model}-image-${index + 1}`, url))
      )
    ).filter((attachment): attachment is ChatAttachment => attachment != null);

    if (attachments.length === 0) {
      const text = normalizeAssistantContent(contentToString(message?.content));
      const usage = mapCompletionUsage(completion.usage ?? undefined);
      window.webContents.send('chat:done', {
        requestId,
        content: text
          ? `The model returned text instead of an image file:\n\n${text}`
          : 'The model did not return an image file. Try again or choose another image model.',
        usage,
        costEstimate: await this.estimateOpenRouterResponseCost(settings, model, usage)
      } satisfies ChatStreamDone);
      this.activeRequests.delete(requestId);
      return;
    }

    const usage = mapCompletionUsage(completion.usage ?? undefined);
    window.webContents.send('chat:done', {
      requestId,
      content: attachments.length === 1 ? 'Generated image.' : `Generated ${attachments.length} images.`,
      attachments,
      usage,
      costEstimate: await this.estimateOpenRouterResponseCost(settings, model, usage)
    } satisfies ChatStreamDone);
    this.activeRequests.delete(requestId);
  }

  private async runVideoGeneration(
    window: BrowserWindow,
    requestId: string,
    settings: AppSettings,
    model: string,
    prompt: string,
    controller: AbortController,
    conversationId: string | undefined
  ) {
    if (settings.selectedProvider !== 'openrouter') {
      throw new Error('Video generation is currently supported for OpenRouter models only.');
    }
    if (!prompt) {
      throw new Error('Enter a video prompt before generating.');
    }

    const provider = settings.providers.openrouter;
    const baseUrl = normalizeBaseUrl('openrouter', provider.baseUrl);
    const headers = {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': provider.appUrl || 'https://example.local',
      'X-OpenRouter-Title': provider.appName || 'Mythra'
    };
    const signal = mergeStreamDeadline(controller, resolveStreamChatWallMs());

    this.emitActivity(window, requestId, 'tool', 'Submitting video generation job.');
    const submitResponse = await fetch(`${baseUrl}/videos`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, prompt }),
      signal
    });
    if (!submitResponse.ok) {
      throw new Error(`Video generation request failed (${submitResponse.status}).`);
    }
    const submitted = (await submitResponse.json()) as {
      id?: string;
      polling_url?: string;
      status?: string;
    };
    const jobId = submitted.id;
    if (!jobId) {
      throw new Error('Video generation did not return a job id.');
    }

    const pollUrl = submitted.polling_url ? resolveProviderUrl(submitted.polling_url, baseUrl) : `${baseUrl}/videos/${jobId}`;
    let status = submitted.status ?? 'pending';
    let unsignedUrls: string[] = [];
    let lastError = '';
    for (;;) {
      this.assertNotStopped(requestId);
      if (['completed', 'succeeded', 'success', 'finished'].includes(status)) break;
      if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
        throw new Error(lastError || `Video generation ${status}.`);
      }
      this.emitActivity(window, requestId, 'tool', `Video generation status: ${status}.`);
      await wait(5000, signal);
      const pollResponse = await fetch(pollUrl, { headers, signal });
      if (!pollResponse.ok) {
        throw new Error(`Video generation polling failed (${pollResponse.status}).`);
      }
      const polled = (await pollResponse.json()) as {
        status?: string;
        error?: string;
        unsigned_urls?: string[];
      };
      status = polled.status ?? status;
      unsignedUrls = Array.isArray(polled.unsigned_urls) ? polled.unsigned_urls.filter((url): url is string => typeof url === 'string') : [];
      lastError = typeof polled.error === 'string' ? polled.error : '';
    }

    this.emitActivity(window, requestId, 'tool', 'Downloading generated video.');
    const contentUrl = unsignedUrls[0] ?? `${baseUrl}/videos/${jobId}/content`;
    const videoResponse = await fetch(contentUrl, {
      headers: unsignedUrls[0] ? undefined : headers,
      signal
    });
    if (!videoResponse.ok) {
      throw new Error(`Generated video download failed (${videoResponse.status}).`);
    }
    const mimeType = videoResponse.headers.get('content-type')?.split(';')[0]?.trim() || 'video/mp4';
    const bytes = Buffer.from(await videoResponse.arrayBuffer());
    const attachment = await this.saveGeneratedMediaFile(conversationId, requestId, model, mimeType, bytes);

    window.webContents.send('chat:done', {
      requestId,
      content: 'Generated video.',
      attachments: [attachment]
    } satisfies ChatStreamDone);
    this.activeRequests.delete(requestId);
  }

  sendError(window: BrowserWindow, requestId: string, error: unknown) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? 'Request stopped.'
        : error instanceof Error
          ? error.message
          : 'Unknown model error.';
    const payload: ChatStreamError = { requestId, error: message };
    window.webContents.send('chat:error', payload);
  }

  private buildSetAppThemeTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'set_app_theme',
        description:
          `Change the Mythra preset theme (fixed appearances in Settings tiles). Allowed ids: ${PRESET_THEME_IDS.join(', ')}. ` +
          'Use set_custom_theme for custom color families (red, pink, purple, dark blue, icy, white, orange, kiwi, etc.).',
        parameters: {
          type: 'object',
          properties: {
            theme_id: {
              type: 'string',
              enum: [...PRESET_THEME_IDS],
              description: 'Preset theme id (matches Settings theme tiles; use set_custom_theme for custom colors).'
            }
          },
          required: ['theme_id'],
          additionalProperties: false
        }
      }
    };
  }

  private buildGetAppThemeTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'get_app_theme',
        description:
          'Return the currently applied Mythra theme (id and display name) and, if available, the previous theme before the last change ' +
          '(so you can answer what theme is active or whether the user can revert). Agent mode only.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      }
    };
  }

  private buildGetToolAccessTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'get_tool_access',
        description:
          'Return which options are enabled under Settings → Tool access: read files, write files, workspace search, command deck, and whether the model may call set_system_prompt to change the stored system prompt. Read-only. (Reading the prompt uses get_system_prompt; that is not controlled by these toggles.)',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      }
    };
  }

  private buildGetSystemPromptTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'get_system_prompt',
        description:
          'Return the full global system prompt text and preset metadata from Settings (read-only, never writes). It is the same across LM Studio, OpenRouter, and Ollama. Use when the user asks what instructions you were given, what the system prompt says, or to quote the developer prompt. Available in Agent mode even if “AI can change system prompt” is disabled in Tool access. Long prompts may be truncated in the tool result.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      }
    };
  }

  private buildGetWizardSystemPromptTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'get_wizard_system_prompt',
        description:
          'Return this Wizard’s stored **private** system prompt (read-only)—the text edited in the Wizard profile, not Mythra’s hidden routing layers. Call before `set_wizard_system_prompt` whenever you need the exact current text for a precise edit. This is distinct from `get_system_prompt`, which reads the global System Prompt preset in Settings. Long prompts may be truncated.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      }
    };
  }

  private buildRevertAppThemeTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'revert_app_theme',
        description:
          'Set the app theme back to the previous theme (undo the most recent theme change from Settings or set_app_theme). ' +
          'Call get_app_theme first if you need to confirm canRevert. Agent mode only.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      }
    };
  }

  private buildMergeCustomThemeTokensTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'merge_custom_theme_tokens',
        description:
          'Exact Custom theme editor. Use this when the user wants a specific UI area recolored or gives exact colors. Prefer the slots object so you do not need to know CSS. ' +
          'Supported slots include appBackground, titlebar, sidebar, chatPanel, chatThread, assistantMessage, userMessage, thinking, composer, messageInput, inspector, settings, editor, text, mutedText, border, primaryAccent, secondaryAccent, danger, and warning. ' +
          '**Mystic:** If the chat background is Mystic, tint **chatThread** / **assistantMessage** / **userMessage** with rgba accent washes so the thread matches the custom theme (layers on the theme-aware Mystic image). ' +
          'You may also merge exact whitelisted CSS variables such as --accent, --bg-0, or --text-0. For whole-theme requests, use set_custom_theme first with an explicit palette.',
        parameters: {
          type: 'object',
          properties: {
            palette: {
              type: 'string',
              enum: [...MERGE_THEME_PALETTE_IDS, ...SEMANTIC_CUSTOM_THEME_PALETTE_IDS],
              description:
                'Fallback palette if tokens/slots are missing. Semantic ids include red, pink, purple, blue, green, orange, ice, kiwi, slate, white. For full-theme changes prefer set_custom_theme with the same palette id.'
            },
            tokens: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description:
                'CSS variable keys or named UI slots to colors, e.g. { "--accent": "#64748b", "assistantMessage": "rgba(255,182,193,0.20)", "userMessage": "rgba(255,182,193,0.28)" }.'
            },
            slots: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description:
                'Named UI areas to recolor without knowing CSS variables, e.g. { "sidebar": "#ffb3d9", "userMessage": "rgba(236, 72, 153, 0.16)", "editor": "#050505", "text": "#111827" }.'
            }
          },
          required: [],
          additionalProperties: true
        }
      }
    };
  }

  private buildSetCustomThemeTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'set_custom_theme',
        description:
          'Preferred tool for custom theme requests. Sets a complete Custom theme from semantic palette + mode, replacing old custom colors so leftover tokens do not clash. ' +
          'Pass **palette** explicitly (red, pink, purple, blue, green, orange, slate, white, ice, kiwi)—required for correct hue: e.g. **red** is not **pink**. ' +
          '**Mystic:** With Mystic chat background on, the app picks the light Mystic (ice) art for light custom themes and dark Mystic (neon) for dark; chat/thread tokens from this theme tint on top—optionally refine with merge_custom_theme_tokens on chatThread and bubbles. ' +
          'Use merge_custom_theme_tokens only for advanced exact tweaks.',
        parameters: {
          type: 'object',
          properties: {
            palette: {
              type: 'string',
              enum: [...SEMANTIC_CUSTOM_THEME_PALETTE_IDS],
              description:
                'Main color family. **red** = true red/crimson (not pink). **pink** = pink/rose/magenta/fuchsia. **purple**, **blue**, **green**, **orange**, **slate**, **white** (paper), **ice**, **kiwi** as usual.'
            },
            mode: {
              type: 'string',
              enum: [...SEMANTIC_CUSTOM_THEME_MODE_IDS],
              description: 'Use light for bright/pastel/white UI, dark for deep/night/black UI. Omit if the user did not specify.'
            },
            description: {
              type: 'string',
              description: 'Short copy of the user request, e.g. “completely pink theme”. Helps fallback routing.'
            }
          },
          required: ['palette'],
          additionalProperties: false
        }
      }
    };
  }

  private buildWebSearchTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          'Look up public web information via DuckDuckGo (short instant answers, definitions, and a few links—not full page text). ' +
          'Prefer compact queries with distinctive keywords, exact error text in quotes, product/version names, or a year for current events. ' +
          'If the first result is empty or unhelpful, call again with rephrased or narrower terms before concluding failure. ' +
          'Does not read the user’s project; in Agent mode use file tools for local code.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'One focused search string (not a long paragraph unless needed). Use keywords, quoted phrases, years, or official product/repo names; avoid vague one-word questions unless they are unambiguous.'
            }
          },
          required: ['query'],
          additionalProperties: false
        }
      }
    };
  }

  private buildCurrentTimeTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'get_current_time',
        description:
          'Return the current date and time from the user’s local machine clock, including local timezone, UTC timestamp, weekday, and UTC offset. Call this whenever the answer depends on current time/date.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      }
    };
  }

  private buildSearchChatHistoryTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'search_chat_history',
        description:
          'Search saved Mythra chats, Wizard sessions, and Nexus sessions by title and message text. Use when the user asks about previous conversations, asks where something was discussed, or needs context from another saved chat. Returns matching chat ids and snippets; call read_chat_messages for exact turns.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text to search for in chat titles and messages.' },
            limit: { type: 'number', description: 'Maximum matches to return. Default 8, max 25.' }
          },
          required: ['query'],
          additionalProperties: false
        }
      }
    };
  }

  private buildReadChatMessagesTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'read_chat_messages',
        description:
          'Read exact messages from the current chat or a saved chat id returned by search_chat_history. Use for conversation continuity, summaries, or when the user asks what was said before. If chat_id is omitted, reads the current visible chat history for this request.',
        parameters: {
          type: 'object',
          properties: {
            chat_id: { type: 'string', description: 'Optional saved chat id. Omit to read the current chat.' },
            limit: { type: 'number', description: 'Number of most recent messages to return. Default 30, max 120.' }
          },
          additionalProperties: false
        }
      }
    };
  }

  private buildGetAppSettingsSummaryTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'get_app_settings_summary',
        description:
          'Return a safe summary of Mythra app state and UI locations: version, active provider/model, session mode, web toggle, Tool Access toggles, Agent Autonomy toggles, active workspace, Wizard/Nexus context, OpenRouter credits display preference, and the current Settings section order. Never returns API keys.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      }
    };
  }

  private buildEstimateModelCostTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'estimate_model_cost',
        description:
          'Estimate OpenRouter model cost from current model pricing. Use when the user asks about cost/pricing or before very large requests. If token counts are omitted, Mythra estimates input tokens from the current chat and uses a default output estimate.',
        parameters: {
          type: 'object',
          properties: {
            model: { type: 'string', description: 'Optional OpenRouter model id. Defaults to the active model.' },
            input_tokens: { type: 'number', description: 'Estimated input tokens. Omit to estimate from current chat messages.' },
            output_tokens: { type: 'number', description: 'Estimated output tokens. Defaults to 1000.' }
          },
          additionalProperties: false
        }
      }
    };
  }

  private buildRenameCurrentChatTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'rename_current_chat',
        description:
          'Rename the current saved Mythra chat/session in the sidebar. Useful for Wizard and Nexus sessions after you understand the topic. Keep titles short and descriptive. Requires the current thread to be saved.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'New sidebar title for the current chat/session.' }
          },
          required: ['title'],
          additionalProperties: false
        }
      }
    };
  }

  private buildCreateWizardMemoryTool(): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'create_wizard_memory',
        description:
          'Append a durable memory entry to this Wizard’s memory.md. Use proactively when the user states a stable preference, correction, identity fact, project fact, workflow rule, or reusable lesson that should persist across future Wizard sessions. Do not store one-off temporary details.',
        parameters: {
          type: 'object',
          properties: {
            memory: { type: 'string', description: 'Short durable fact or lesson to remember.' },
            category: { type: 'string', description: 'Optional category such as preference, correction, project, identity, workflow.' }
          },
          required: ['memory'],
          additionalProperties: false
        }
      }
    };
  }

  private buildListRecentFilesTool(toolPathPropDesc: string): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'list_recent_files',
        description:
          'List recently modified files in the active workspace. Use to orient yourself before project work, find likely files the user just changed, or decide what to read next. Respects the same workspace scope as list_files.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum recent files. Default 25, max 100.' },
            path_hint: { type: 'string', description: `Optional path or folder hint to mention in your reasoning; listing still uses workspace scope. ${toolPathPropDesc}` }
          },
          additionalProperties: false
        }
      }
    };
  }

  private buildSummarizeFileTool(toolPathPropDesc: string): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'summarize_file',
        description:
          'Summarize a workspace file internally, including long text/code files and PDFs. Prefer this over manually reading huge files when the user asks for a summary, explanation, key points, risks, or structure. For PDFs, use page range and OCR options like read_file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: toolPathPropDesc },
            focus: { type: 'string', description: 'Optional focus for the summary, e.g. “security risks”, “main argument”, or “API surface”.' },
            pdf_start_page: { type: 'number', description: 'PDF-only. 1-based page number to start from.' },
            pdf_page_count: { type: 'number', description: 'PDF-only. Number of pages to summarize.' },
            pdf_ocr: {
              type: 'string',
              enum: ['auto', 'on', 'off'],
              description: 'PDF-only. Same behavior as read_file: auto, on, or off.'
            }
          },
          required: ['path'],
          additionalProperties: false
        }
      }
    };
  }

  private buildDescribeImageTool(toolPathPropDesc: string): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'describe_image',
        description:
          'Inspect and describe a local workspace image file using the active model. Use when the user asks what an image contains, wants visual QA, or needs text/objects/layout described. Requires an image-capable provider/model.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: toolPathPropDesc },
            question: { type: 'string', description: 'Optional specific question about the image.' }
          },
          required: ['path'],
          additionalProperties: false
        }
      }
    };
  }

  private buildTranscribeAudioTool(toolPathPropDesc: string): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: 'transcribe_audio',
        description:
          'Transcribe a local workspace audio file using the active model/provider. Use for voice notes, meeting recordings, generated songs, or audio files the user asks you to understand. Requires an audio-input capable model/provider.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: toolPathPropDesc },
            prompt: { type: 'string', description: 'Optional context or transcription instructions.' }
          },
          required: ['path'],
          additionalProperties: false
        }
      }
    };
  }

  private buildToolDefinitions(settings: AppSettings, runtime: ChatRuntimeContext): ChatCompletionTool[] {
    const tools: ChatCompletionTool[] = [];
    if (runtime.mediaGenerationKind) {
      return tools;
    }
    tools.push(this.buildCurrentTimeTool());
    tools.push(this.buildSearchChatHistoryTool());
    tools.push(this.buildReadChatMessagesTool());
    tools.push(this.buildGetAppSettingsSummaryTool());
    tools.push(this.buildEstimateModelCostTool());
    if (settings.ui.webSearch) {
      tools.push(this.buildWebSearchTool());
    }

    if (settings.ui.sessionMode === 'talk') {
      return tools;
    }

    tools.push(this.buildSetCustomThemeTool());
    tools.push(this.buildSetAppThemeTool());
    tools.push(this.buildMergeCustomThemeTokensTool());
    tools.push(this.buildGetAppThemeTool());
    tools.push(this.buildGetToolAccessTool());
    tools.push(this.buildGetSystemPromptTool());
    tools.push(this.buildRevertAppThemeTool());
    tools.push(this.buildRenameCurrentChatTool());

    // Only set_system_prompt is gated; get_system_prompt above is always offered in Agent mode.
    if (settings.tools.allowModelSystemPrompt) {
      tools.push({
        type: 'function',
        function: {
          name: 'set_system_prompt',
          description:
            'Replace the entire global system prompt in Settings. Use only when the user clearly wants their assistant instructions updated. Saves immediately, syncs across LM Studio/OpenRouter/Ollama, and applies on the next user message. Disabled unless the user turns on “AI can change system prompt” in Settings → Tool access.',
          parameters: {
            type: 'object',
            properties: {
              system_prompt: {
                type: 'string',
                description: 'Full new system prompt text (replaces the previous global prompt).'
              }
            },
            required: ['system_prompt'],
            additionalProperties: false
          }
        }
      });
    }

    if (runtime.wizardId) {
      tools.push(this.buildGetWizardSystemPromptTool());
      tools.push(this.buildCreateWizardMemoryTool());
      tools.push({
        type: 'function',
        function: {
          name: 'set_wizard_system_prompt',
          description:
            'Replace this Wizard’s private system prompt only—not the global System Prompt preset in Settings. Use when the user clearly asks to change this Wizard’s own long-term instructions. Mythra shows a before/after approval dialog automatically. Independent of Settings → Tool access → “AI can change system prompt” (that toggle applies only to `set_system_prompt`, which is not offered in Wizard chats). Never paste Mythra Agent routing text from this chat into system_prompt—only persona/editor-style instructions.',
          parameters: {
            type: 'object',
            properties: {
              system_prompt: {
                type: 'string',
                description:
                  'Full new Wizard-only prompt text (persona / instructions like in the Wizard settings editor). Must not include hidden `[Mythra model routing` blocks, `[Mythra] Thread id` lines, tool/workspace listings from Agent routing, or other pasted system-injection text—only user-facing Wizard instructions.'
              }
            },
            required: ['system_prompt'],
            additionalProperties: false
          }
        }
      });
      tools.push({
        type: 'function',
        function: {
          name: 'set_wizard_display_name',
          description:
            'Change this Wizard’s **display name** in Mythra (sidebar list, chat subtitle, Inspector Wizard settings header). Does not edit identity.md, personality.md, legacy soul.md, or the stored system prompt—after renaming here, update identity.md (or soul.md for legacy Wizards) and use `set_wizard_system_prompt` if your instructions still mention the old name so everything stays consistent.',
          parameters: {
            type: 'object',
            properties: {
              display_name: {
                type: 'string',
                description: 'New short display name for this Wizard (shown in the UI).'
              }
            },
            required: ['display_name'],
            additionalProperties: false
          }
        }
      });
    }

    if (!runtime.workspaceRoot) {
      return tools;
    }

    const wizardOutsideOn = Boolean(runtime.wizardId && runtime.wizardAllowOutsideWorkspace);
    const wizardOutsideOff = Boolean(runtime.wizardId && !runtime.wizardAllowOutsideWorkspace);

    const toolPathPropDesc = wizardOutsideOn
      ? 'Relative workspace path, ../ segment, or absolute local path (Wizard “Allow paths outside workspace” is on). Cloud-sync folders are blocked.'
      : wizardOutsideOff
        ? 'Relative path inside this Wizard workspace. For files elsewhere, ask the user to enable **Allow paths outside workspace** in Wizard settings.'
        : 'Relative path inside the workspace.';

    const readFileToolDesc = wizardOutsideOn
      ? 'Read UTF-8 text or extract text from PDFs. PDFs are read page ranges: embedded text is returned for every page, and OCR runs only on low/no-text pages by default; use pdf_start_page/pdf_page_count to continue long PDFs and pdf_ocr=on for pages/regions that visually contain image text. Paths may be workspace-relative, ../ to reach sibling folders, or absolute local paths.'
      : wizardOutsideOff
        ? 'Read UTF-8 text or extract text from PDFs. PDFs are read page ranges: embedded text is returned for every page, and OCR runs only on low/no-text pages by default; use pdf_start_page/pdf_page_count to continue long PDFs and pdf_ocr=on for pages/regions that visually contain image text. Paths must be relative to this Wizard workspace unless outside access is enabled.'
        : 'Read a UTF-8 text file or extract text from a PDF. PDFs are read page ranges: embedded text is returned for every page, and OCR runs only on low/no-text pages by default; use pdf_start_page/pdf_page_count to continue long PDFs and pdf_ocr=on for pages/regions that visually contain image text.';

    const writeFileToolDesc = wizardOutsideOn
      ? 'Create or overwrite UTF-8 text (creates parent folders). Paths may escape the workspace folder when this Wizard setting allows it—local disks only.'
      : wizardOutsideOff
        ? 'Create or overwrite UTF-8 inside this Wizard workspace. For targets outside it, ask the user to enable **Allow paths outside workspace**.'
        : 'Create or overwrite UTF-8 inside the workspace (creates parent folders).';

    const replaceInFileToolDesc = wizardOutsideOn
      ? 'Replace exact text inside one UTF-8 file. Use after read_file. Paths may use ../ or absolute local targets when allowed (cloud-sync blocked). Set replace_all only when every occurrence should change.'
      : wizardOutsideOff
        ? 'Replace exact text inside one UTF-8 file under this Wizard workspace unless the user enables **Allow paths outside workspace**. Use after read_file.'
        : 'Replace exact text inside one UTF-8 file. Use for small, precise edits after read_file. Set replace_all only when every occurrence should change.';

    const insertAfterToolDesc = wizardOutsideOn
      ? 'Insert text immediately after an exact anchor string in one UTF-8 file (paths may escape workspace when allowed).'
      : wizardOutsideOff
        ? 'Insert text after an anchor in one UTF-8 file under this Wizard workspace unless **Allow paths outside workspace** is enabled.'
        : 'Insert text immediately after an exact anchor string in one UTF-8 file.';

    const renameFileToolDesc = wizardOutsideOn
      ? 'Move or rename a local file or folder; from/to paths follow write_file rules.'
      : wizardOutsideOff
        ? 'Move or rename inside this Wizard workspace unless the user enables **Allow paths outside workspace**.'
        : 'Move or rename a file or folder inside the current workspace.';

    const deletePathToolDesc = wizardOutsideOn
      ? 'Delete a local file or folder; path follows write_file rules.'
      : wizardOutsideOff
        ? 'Delete inside this Wizard workspace unless **Allow paths outside workspace** is enabled.'
        : 'Delete a file or folder inside the current workspace.';

    if (settings.tools.workspaceSearch) {
      tools.push(this.buildListRecentFilesTool(toolPathPropDesc));
      tools.push({
        type: 'function',
        function: {
          name: 'list_files',
          description:
            'List files and directories under the current workspace root only. Does not include other folders on disk or other Wizards’ workspaces.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false
          }
        }
      });
    }

    if (settings.tools.fileRead) {
      tools.push(this.buildSummarizeFileTool(toolPathPropDesc));
      tools.push(this.buildDescribeImageTool(toolPathPropDesc));
      tools.push(this.buildTranscribeAudioTool(toolPathPropDesc));
      tools.push({
        type: 'function',
        function: {
          name: 'read_file',
          description: readFileToolDesc,
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: toolPathPropDesc
              },
              pdf_start_page: {
                type: 'number',
                description: 'PDF-only. 1-based page number to start reading from. Use to continue long PDFs in chunks.'
              },
              pdf_page_count: {
                type: 'number',
                description: 'PDF-only. Number of pages to read from pdf_start_page. Defaults to a bounded chunk.'
              },
              pdf_ocr: {
                type: 'string',
                enum: ['auto', 'on', 'off'],
                description:
                  'PDF-only. auto OCRs pages with little/no embedded text, on OCRs every page in the requested range, off returns embedded text only.'
              }
            },
            required: ['path'],
            additionalProperties: false
          }
        }
      });
      if (runtime.nexusTeamWorkspaces?.length) {
        tools.push(
          {
            type: 'function',
            function: {
              name: 'list_nexus_teammate_workspaces',
              description:
                'List Nexus teammate Wizard workspaces and their Markdown documents. Use this when you need to understand who teammates are or what private docs are available. Returns paths only, not document contents.',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false
              }
            }
          },
          {
            type: 'function',
            function: {
              name: 'read_nexus_teammate_file',
              description:
                'Read a file from a Nexus teammate Wizard workspace by wizard_id or wizard_name. Read-only: cannot write, edit, delete, rename, patch, or run commands in teammate workspaces. Use for identity, personality, memory, and Markdown docs when needed.',
              parameters: {
                type: 'object',
                properties: {
                  wizard_id: {
                    type: 'string',
                    description: 'The teammate wizard id from list_nexus_teammate_workspaces.'
                  },
                  wizard_name: {
                    type: 'string',
                    description: 'The teammate wizard display name. Use if you do not know wizard_id.'
                  },
                  path: {
                    type: 'string',
                    description: 'Workspace-relative path inside that teammate Wizard workspace.'
                  },
                  pdf_start_page: {
                    type: 'number',
                    description: 'PDF-only. 1-based page number to start reading from.'
                  },
                  pdf_page_count: {
                    type: 'number',
                    description: 'PDF-only. Number of pages to read from pdf_start_page.'
                  },
                  pdf_ocr: {
                    type: 'string',
                    enum: ['auto', 'on', 'off'],
                    description: 'PDF-only. auto OCRs pages with little/no embedded text.'
                  }
                },
                required: ['path'],
                additionalProperties: false
              }
            }
          }
        );
      }
    }

    if (settings.tools.fileWrite) {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description:
              'Apply a unified diff with `git apply` from the workspace root. The patch must be valid standard unified diff text only (---/+++/@@ lines, context lines starting with a single space). Context must match the file exactly or git fails with "corrupt patch". Always read_file first. If unsure, use replace_in_file or write_file instead.',
            parameters: {
              type: 'object',
              properties: {
                patch: {
                  type: 'string',
                  description:
                    'Full unified diff as plain text (same as stdin to `git -C <workspace> apply --whitespace=nowarn -`). No markdown fences. Paths like --- a/src/file.ext / +++ b/src/file.ext relative to workspace root.'
                }
              },
              required: ['patch'],
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'write_file',
            description: writeFileToolDesc,
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: toolPathPropDesc
                },
                content: {
                  type: 'string',
                  description: 'Full file contents to write.'
                }
              },
              required: ['path', 'content'],
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'replace_in_file',
            description: replaceInFileToolDesc,
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: toolPathPropDesc },
                search: { type: 'string', description: 'Exact text to find.' },
                replacement: { type: 'string', description: 'Replacement text.' },
                replace_all: { type: 'boolean', description: 'Replace every occurrence instead of just the first.' }
              },
              required: ['path', 'search', 'replacement'],
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'insert_after',
            description: insertAfterToolDesc,
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: toolPathPropDesc },
                anchor: { type: 'string', description: 'Exact text to insert after.' },
                text: { type: 'string', description: 'Text to insert.' }
              },
              required: ['path', 'anchor', 'text'],
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'rename_file',
            description: renameFileToolDesc,
            parameters: {
              type: 'object',
              properties: {
                from: { type: 'string', description: toolPathPropDesc },
                to: { type: 'string', description: toolPathPropDesc }
              },
              required: ['from', 'to'],
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'delete_path',
            description: deletePathToolDesc,
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: toolPathPropDesc
                }
              },
              required: ['path'],
              additionalProperties: false
            }
          }
        }
      );
    }

    if (settings.tools.commandDeck) {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'get_git_diff',
            description: 'Return git status and the current unstaged diff for the active workspace. Use after edits before summarizing changes.',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'run_tests',
            description:
              'Run the project test/build/check command in the current workspace. Prefer this over run_command for verification.',
            parameters: {
              type: 'object',
              properties: {
                command: {
                  type: 'string',
                  description: 'Test/check/build command to run, e.g. npm run check. If omitted, Mythra tries npm test.'
                }
              },
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'run_command',
            description:
              'Run a shell command inside the current workspace and return stdout, stderr, and exit status. Use for commands not covered by run_tests or get_git_diff.',
            parameters: {
              type: 'object',
              properties: {
                command: {
                  type: 'string',
                  description: 'Shell command to run inside the current workspace.'
                }
              },
              required: ['command'],
              additionalProperties: false
            }
          }
        }
      );
    }

    if (settings.tools.workspaceSearch) {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'search_symbols',
            description:
              'Search likely code symbols/declarations across the workspace. Use before reading many files when looking for a function, class, component, type, or constant.',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Symbol or text to search for.' },
                limit: { type: 'number', description: 'Maximum results, default 50.' }
              },
              required: ['query'],
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'get_file_outline',
            description:
              'Return top-level functions/classes/types/constants for a source file (path rules match read_file for this session).',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: toolPathPropDesc }
              },
              required: ['path'],
              additionalProperties: false
            }
          }
        }
      );
    }

    return tools;
  }

  private threadPreamble(runtime: ChatRuntimeContext): string {
    const id = runtime.conversationId?.trim();
    if (!id) return '';
    return [
      `[Mythra] Thread id: ${id}. The messages in this request are the only history you see for this turn—other saved chats in the app are not included.`,
      'If the user just started a new chat, this thread is a fresh session; there are no prior turns in this list unless the user (or you in this thread) put them there.',
      ''
    ].join('\n');
  }

  private async buildSessionContext(settings: AppSettings, runtime: ChatRuntimeContext) {
    if (settings.ui.sessionMode === 'talk') {
      const toolLine = settings.ui.webSearch
        ? 'Chat mode: `get_current_time`, `search_chat_history`, `read_chat_messages`, `get_app_settings_summary`, `estimate_model_cost`, and `web_search` are available while "Web" is enabled in the chat header. You have no read/write for local files, workspace listing, media-file inspection, or shell—even if a folder shows in the UI (ignore it for local work).'
        : 'Chat mode: `get_current_time`, `search_chat_history`, `read_chat_messages`, `get_app_settings_summary`, and `estimate_model_cost` are available. `web_search` is unavailable until the user turns on "Web" in the chat header. You cannot read/write local files, search the workspace, inspect media files, or run shell commands.';

      return (
        this.threadPreamble(runtime) +
        [
          '[Mythra model routing — Chat mode. This is a second system message; it is not shown in the user’s chat transcript. Do not tell the user about "hidden" or internal prompts; describe behavior in plain terms. If they need Agent (files, shell, workspace tools), tell them they can switch using the Chat/Agent control at the top of the chat window. Do not send them to Theme for session mode.]',
          mythraRuntimeVersionLine(),
          sessionModeUiStateLine(settings.ui.sessionMode),
          toolLine,
          mythraCurrentTimeInstruction,
          webHeaderUiStateLine(settings.ui.webSearch),
          ...(settings.ui.webSearch ? [mythraWebSearchToolRoutingHint] : []),
          'For editing files, running commands, or searching the open project, they must be in Agent mode. Tell them to use the Chat/Agent control at the top of the chat window, then open a workspace from the left sidebar if needed.',
          mythraAppToolInstruction,
          mythraProductFeaturesInstruction,
          mythraColoredTextInstruction,
          mythraQuizEmbedInstruction,
          mythraDataEmbedInstruction,
          mythraSessionModeEmbedInstruction,
          mythraWebSearchEmbedInstruction,
          mythraThemeInChatModeInstruction,
          'Reply in normal prose. Do not begin with TASK_COMPLETE or NEEDS_INPUT.',
          'The first system message is the user’s preset; follow it except where this block defines tool and mode behavior.'
        ].join('\n')
      );
    }

    return this.threadPreamble(runtime) + (await this.buildWorkspaceContext(settings, runtime));
  }

  private async buildWorkspaceContext(settings: AppSettings, runtime: ChatRuntimeContext) {
    if (!runtime.workspaceRoot) {
      const webLine = settings.ui.webSearch
        ? 'The `web_search` tool is available for public web lookup (the user enabled "Web" in the chat header).'
        : 'Web search is off unless the user enables "Web" next to the status in the chat header.';
      return [
        '[Mythra model routing — Agent mode, no workspace. This system message is not in the user’s visible transcript. Do not tell the user about internal prompts.]',
        mythraRuntimeVersionLine(),
        sessionModeUiStateLine(settings.ui.sessionMode),
        'No workspace folder is open. You cannot use file or shell tools on disk until the user opens one from the sidebar. You can still answer generally.',
        'If they only want casual chat without tools, they can switch to Chat mode with the Chat/Agent control at the top of the chat.',
        mythraSessionModeEmbedInstruction,
        mythraWebSearchEmbedInstruction,
        mythraSetAppThemeAgentInstruction,
        mythraToolAccessReadInstruction,
        mythraAppToolInstruction,
        mythraProductFeaturesInstruction,
        mythraColoredTextInstruction,
        mythraQuizEmbedInstruction,
        mythraDataEmbedInstruction,
        mythraCurrentTimeInstruction,
        ...agentModeSystemPromptInstructions(settings, runtime),
        webLine,
        webHeaderUiStateLine(settings.ui.webSearch),
        ...(settings.ui.webSearch ? [mythraWebSearchToolRoutingHint] : [])
      ].join('\n');
    }

    const files = await this.workspaceService.listFiles(runtime.workspaceRoot);
    const visibleFiles = files
      .slice(0, 140)
      .map((entry) => `${entry.type === 'directory' ? '[dir]' : '[file]'} ${entry.path}`)
      .join('\n');

    const enabledTools = [
      'set_custom_theme',
      'set_app_theme',
      'merge_custom_theme_tokens',
      'get_app_theme',
      'get_tool_access',
      'get_system_prompt',
      'revert_app_theme',
      'search_chat_history, read_chat_messages, get_app_settings_summary, estimate_model_cost',
      'rename_current_chat',
      'get_current_time',
      settings.ui.webSearch ? 'web_search' : null,
      settings.tools.workspaceSearch ? 'list_files, list_recent_files' : null,
      settings.tools.workspaceSearch ? 'search_symbols, get_file_outline' : null,
      settings.tools.fileRead ? 'read_file, summarize_file, describe_image, transcribe_audio' : null,
      settings.tools.fileRead && runtime.nexusTeamWorkspaces?.length
        ? 'list_nexus_teammate_workspaces, read_nexus_teammate_file'
        : null,
      settings.tools.fileWrite ? 'apply_patch, replace_in_file, insert_after, rename_file, write_file, delete_path' : null,
      settings.tools.commandDeck ? 'get_git_diff, run_tests, run_command' : null,
      settings.tools.allowModelSystemPrompt ? 'set_system_prompt' : null,
      runtime.wizardId ? 'get_wizard_system_prompt, set_wizard_system_prompt, set_wizard_display_name, create_wizard_memory' : null
    ]
      .filter(Boolean)
      .join(', ');

    return [
      '[Mythra model routing — Agent mode. The user does not see this system message. Do not tell the user about “internal” or “hidden” prompts.]',
      mythraRuntimeVersionLine(),
      sessionModeUiStateLine(settings.ui.sessionMode),
      'Converse like a normal assistant: friendly, direct, and human. Do not act like a project manager or ask for a “task”, “autonomous objective”, or “objective in todo” unless the user is clearly scoping a multi-step build.',
      'Agent mode only means: when the user wants something that requires the repo, files, or the shell, you *may* use the tools below. For greetings, chit-chat, and general Q&A, answer normally and use zero tools unless reading a file is genuinely required to help.',
      'If the user wants to use only Chat mode (no file/shell tools), they can switch with the Chat/Agent control at the top of the chat.',
      mythraSessionModeEmbedInstruction,
      mythraWebSearchEmbedInstruction,
      webHeaderUiStateLine(settings.ui.webSearch),
      mythraSetAppThemeAgentInstruction,
      mythraToolAccessReadInstruction,
      mythraAppToolInstruction,
      mythraProductFeaturesInstruction,
      mythraColoredTextInstruction,
      mythraQuizEmbedInstruction,
      mythraDataEmbedInstruction,
      mythraCurrentTimeInstruction,
      ...agentModeSystemPromptInstructions(settings, runtime),
      mythraCodingToolInstruction,
      `Workspace root: ${runtime.workspaceRoot}`,
      `Active file: ${runtime.activeFilePath ? relative(runtime.workspaceRoot, runtime.activeFilePath) : 'none'}`,
      `Enabled tools: ${enabledTools || 'none'}`,
      `Approval: ${this.effectiveFullAccess(settings, runtime) ? 'writes/commands/system prompt runs without per-action approval' : 'user approval may be required for some writes, deletes, commands, and system prompt changes'}.`,
      runtime.wizardId
        ? 'Wizard prompt edits (set_wizard_system_prompt) always use the built-in before/after approval dialog regardless of global Tool access.'
        : '',
      runtime.wizardId
        ? runtime.wizardAllowOutsideWorkspace
          ? 'Wizard **Allow paths outside workspace** is ON: read/write/replace/insert/rename/delete/get_file_outline may target ../ segments or absolute local paths (cloud-sync folders remain blocked). list_files, search_symbols, apply_patch, get_git_diff, run_tests, and run_command stay scoped to this Wizard’s workspace folder only.'
          : 'Wizard path-based file tools default to this workspace folder only. If the user wants reads/writes elsewhere on disk (another Wizard folder, home directory, etc.), tell them to enable **Allow paths outside workspace** for this Wizard in Inspector → Wizard settings. Until then Mythra rejects paths outside the workspace—even with approval. To reuse another Wizard’s docs without that setting, suggest copying files here or opening that Wizard’s session.'
        : '',
      runtime.nexusTeamWorkspaces?.length
        ? 'Nexus teammate Wizard workspaces are NOT auto-loaded into this prompt. You have read-only tools to inspect teammate identity/memory/docs on demand: list_nexus_teammate_workspaces and read_nexus_teammate_file. These tools never grant write access to teammate Wizard folders; normal file write tools still target only the shared Nexus workspace.'
        : '',
      `In one user message you may get several model turns: use tools when needed, then reply in plain language. Step cap per message: about ${settings.agent.maxAutoSteps} tool rounds.`,
      'If the user asks what you can do, say you can both chat and (when it helps) use the listed tools on the open workspace—without sounding like you will always run a task.',
      ...(settings.ui.webSearch ? [mythraWebSearchToolRoutingHint] : []),
      'Visible workspace entries (truncated):',
      visibleFiles || '[workspace appears empty]'
    ].join('\n');
  }

  private async executeToolCall(
    window: BrowserWindow,
    requestId: string,
    settings: AppSettings,
    runtime: ChatRuntimeContext,
    toolCall: ChatCompletionMessageFunctionToolCall,
    args: Record<string, unknown>,
    currentMessages: ChatMessage[]
  ) {
    const workspaceRoot = runtime.workspaceRoot;

    if (toolCall.function.name === 'get_current_time') {
      return JSON.stringify(currentLocalTimePayload(), null, 2);
    }

    if (toolCall.function.name === 'search_chat_history') {
      if (!this.listSavedChats || !this.loadSavedChat) {
        throw new Error('Chat history tools are not available in this build.');
      }
      const query = String(args.query ?? '').trim();
      if (!query) {
        throw new Error('search_chat_history requires a non-empty query.');
      }
      const limit = safeChatToolLimit(args.limit, 8, 25);
      const q = query.toLowerCase();
      const metas = await this.listSavedChats();
      const matches: Array<{
        chat_id: string;
        title: string;
        kind: string;
        updatedAt: number;
        score: number;
        snippet: string;
      }> = [];
      for (const meta of metas) {
        const chat = await this.loadSavedChat(meta.id);
        if (!chat) continue;
        const haystack = `${chat.title} ${chat.titleOverride ?? ''} ${chatMessagesText(chat)}`.toLowerCase();
        const titleHit = `${chat.title} ${chat.titleOverride ?? ''}`.toLowerCase().includes(q);
        const bodyHit = haystack.includes(q);
        if (!titleHit && !bodyHit) continue;
        matches.push({
          chat_id: chat.id,
          title: chat.title,
          kind: chatKindLabel(chat),
          updatedAt: chat.updatedAt,
          score: (titleHit ? 2 : 0) + (bodyHit ? 1 : 0),
          snippet: chatPreview(chat)
        });
      }
      matches.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
      return JSON.stringify(
        {
          ok: true,
          query,
          count: matches.length,
          results: matches.slice(0, limit)
        },
        null,
        2
      );
    }

    if (toolCall.function.name === 'read_chat_messages') {
      if (!this.loadSavedChat && args.chat_id) {
        throw new Error('Chat history tools are not available in this build.');
      }
      const chatId = String(args.chat_id ?? '').trim();
      const limit = safeChatToolLimit(args.limit, 30, 120);
      const chat = chatId ? await this.loadSavedChat?.(chatId) : null;
      if (chatId && !chat) {
        throw new Error(`Saved chat not found: ${chatId}`);
      }
      const sourceMessages = chat ? chat.messages : currentMessages;
      const returned = sourceMessages.slice(-limit).map((message) => ({
        id: message.id,
        role: message.role,
        assistantDisplayName: message.assistantDisplayName,
        content: truncate(message.content ?? '', 6_000),
        attachments: (message.attachments ?? []).map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          filePath: attachment.filePath ?? null
        }))
      }));
      return JSON.stringify(
        {
          ok: true,
          chat_id: chat?.id ?? runtime.conversationId ?? null,
          title: chat?.title ?? 'Current chat',
          kind: chat ? chatKindLabel(chat) : 'current request',
          total_messages: sourceMessages.length,
          returned_messages: returned.length,
          messages: returned
        },
        null,
        2
      );
    }

    if (toolCall.function.name === 'get_app_settings_summary') {
      const provider = settings.providers[settings.selectedProvider];
      return JSON.stringify(
        {
          ok: true,
          mythraVersion: app.getVersion(),
          selectedProvider: settings.selectedProvider,
          selectedModel: provider.model || null,
          sessionMode: settings.ui.sessionMode,
          webSearchEnabled: settings.ui.webSearch,
          showOpenRouterCredits: settings.ui.showOpenRouterCredits,
          showModelOutputCosts: settings.ui.showModelOutputCosts,
          workspace: runtime.workspaceRoot
            ? {
                root: runtime.workspaceRoot,
                activeFile: runtime.activeFilePath ?? null
              }
            : null,
          wizard: runtime.wizardId
            ? {
                id: runtime.wizardId,
                name: runtime.wizardName ?? null,
                fullAccess: Boolean(runtime.wizardFullAccess),
                allowOutsideWorkspace: Boolean(runtime.wizardAllowOutsideWorkspace)
              }
            : null,
          nexus: runtime.nexusLeaderName
            ? {
                leaderName: runtime.nexusLeaderName,
                teamFullAccess: Boolean(runtime.nexusTeamFullAccess),
                leaderApprovesTools: Boolean(runtime.nexusLeaderApprovesTools)
              }
            : null,
          toolAccess: {
            fileRead: settings.tools.fileRead,
            fileWrite: settings.tools.fileWrite,
            workspaceSearch: settings.tools.workspaceSearch,
            commandDeck: settings.tools.commandDeck,
            allowModelSystemPrompt: settings.tools.allowModelSystemPrompt
          },
          agentAutonomy: {
            fullAccessMode: settings.agent.fullAccess,
            continueUntilDone: settings.agent.autoContinue,
            autoStepLimit: settings.agent.maxAutoSteps
          },
          settingsUi: {
            exactOrder: [
              'App Updates',
              'Theme',
              'Connection',
              'System Prompt',
              'Web Search',
              'Tool Access',
              'Agent Autonomy'
            ],
            sessionModeLocation: 'Chat/Agent control at the top of the chat window',
            fullAccessModeLocation:
              'Inspector → SETTINGS → scroll to bottom → Agent Autonomy → Full access mode',
            toolAccessLocation: 'Inspector → SETTINGS → Tool Access',
            modelOutputCostsLocation: 'Inspector → SETTINGS → Connection → Output cost estimates',
            themeLocation: 'Inspector → SETTINGS → Theme'
          }
        },
        null,
        2
      );
    }

    if (toolCall.function.name === 'estimate_model_cost') {
      const model = String(args.model ?? settings.providers[settings.selectedProvider].model ?? '').trim();
      if (!model) {
        throw new Error('estimate_model_cost requires an active model or a model argument.');
      }
      if (settings.selectedProvider !== 'openrouter' && !String(args.model ?? '').includes('/')) {
        return JSON.stringify(
          {
            ok: false,
            provider: settings.selectedProvider,
            model,
            message: 'Native pricing is only available for OpenRouter models.'
          },
          null,
          2
        );
      }
      const inputArg = Number(args.input_tokens);
      const outputArg = Number(args.output_tokens);
      const inputTokens = Number.isFinite(inputArg)
        ? Math.max(0, Math.floor(inputArg))
        : roughTokenCount(currentMessages.map((message) => message.content ?? '').join('\n'));
      const outputTokens = Number.isFinite(outputArg) ? Math.max(0, Math.floor(outputArg)) : 1000;
      const models = await this.listModels(settings, 'openrouter');
      const modelInfo = models.find((item) => item.id === model);
      const pricing = modelInfo?.pricing;
      const promptRate = Number(pricing?.prompt ?? NaN);
      const completionRate = Number(pricing?.completion ?? NaN);
      const requestRate = Number(pricing?.request ?? 0);
      if (!pricing || !Number.isFinite(promptRate) || !Number.isFinite(completionRate)) {
        return JSON.stringify(
          {
            ok: false,
            provider: 'openrouter',
            model,
            message: 'OpenRouter did not return prompt/completion pricing for this model.'
          },
          null,
          2
        );
      }
      const inputCost = inputTokens * promptRate;
      const outputCost = outputTokens * completionRate;
      const total = inputCost + outputCost + (Number.isFinite(requestRate) ? requestRate : 0);
      return JSON.stringify(
        {
          ok: true,
          provider: 'openrouter',
          model,
          inputTokens,
          outputTokens,
          ratesUsdPerToken: pricing,
          inputCostUsd: inputCost,
          outputCostUsd: outputCost,
          requestCostUsd: Number.isFinite(requestRate) ? requestRate : 0,
          estimatedTotalUsd: total,
          display: formatUsd(total),
          note: 'Estimate only. Actual OpenRouter billing may include provider-specific native token counts, cache, image, reasoning, or web-search charges.'
        },
        null,
        2
      );
    }

    if (toolCall.function.name === 'rename_current_chat') {
      if (settings.ui.sessionMode === 'talk') {
        throw new Error(
          'rename_current_chat is only available in Agent mode. Ask the user to switch with the Chat/Agent control at the top of the chat window, then try again.'
        );
      }
      if (!this.persistChatTitle) {
        throw new Error('Chat rename is not available in this build.');
      }
      const chatId = runtime.conversationId?.trim();
      if (!chatId) {
        throw new Error('rename_current_chat requires a saved current chat id.');
      }
      const title = String((args as { title?: string }).title ?? '').replace(/[\u0000-\u001f]/g, '').trim();
      if (!title) {
        throw new Error('rename_current_chat requires a non-empty title.');
      }
      if (title.length > 120) {
        throw new Error('Chat title is too long (max 120 characters).');
      }
      await this.persistChatTitle(chatId, title);
      return JSON.stringify({ ok: true, chat_id: chatId, title, message: 'Current chat title updated.' }, null, 2);
    }

    if (toolCall.function.name === 'web_search') {
      if (!settings.ui.webSearch) {
        throw new Error('Web search is turned off. Enable the Web toggle in the chat header to search online.');
      }
      const query = String(args.query ?? '').trim();
      if (!query) {
        throw new Error('web_search requires a non-empty query.');
      }
      return await searchWeb(query, settings.search);
    }

    if (toolCall.function.name === 'set_app_theme') {
      if (settings.ui.sessionMode === 'talk') {
        throw new Error(
          'set_app_theme is only available in Agent mode. Ask the user to switch with the Chat/Agent control at the top of the chat window, then try again.'
        );
      }
      if (!this.applyAppTheme) {
        throw new Error('Theme changes are not available in this build.');
      }
      const themeId = String((args as { theme_id?: string }).theme_id ?? '').trim();
      if (!isPresetThemeId(themeId)) {
        throw new Error(`Invalid theme_id. Use one of: ${PRESET_THEME_IDS.join(', ')} (use merge_custom_theme_tokens for custom colors).`);
      }
      const result = await this.applyAppTheme(themeId);
      this.patchSettingsThemeFromToolResult(settings, result);
      return result;
    }

    if (toolCall.function.name === 'merge_custom_theme_tokens') {
      if (settings.ui.sessionMode === 'talk') {
        throw new Error(
          'merge_custom_theme_tokens is only available in Agent mode. Ask the user to switch with the Chat/Agent control at the top of the chat window, then try again.'
        );
      }
      if (!this.mergeCustomThemeTokens) {
        throw new Error('Custom theme merges are not available in this build.');
      }
      const result = await this.mergeCustomThemeTokens(args);
      this.patchSettingsThemeFromToolResult(settings, result);
      return result;
    }

    if (toolCall.function.name === 'set_custom_theme') {
      if (settings.ui.sessionMode === 'talk') {
        throw new Error(
          'set_custom_theme is only available in Agent mode. Ask the user to switch with the Chat/Agent control at the top of the chat window, then try again.'
        );
      }
      if (!this.setCustomTheme) {
        throw new Error('Custom theme changes are not available in this build.');
      }
      const result = await this.setCustomTheme(args);
      this.patchSettingsThemeFromToolResult(settings, result);
      return result;
    }

    if (toolCall.function.name === 'get_app_theme') {
      if (settings.ui.sessionMode === 'talk') {
        throw new Error(
          'get_app_theme is only available in Agent mode. Ask the user to switch with the Chat/Agent control at the top of the chat window, then try again.'
        );
      }
      if (!this.getAppThemeState) {
        throw new Error('Theme state is not available in this build.');
      }
      return this.getAppThemeState();
    }

    if (toolCall.function.name === 'get_tool_access') {
      if (settings.ui.sessionMode === 'talk') {
        throw new Error(
          'get_tool_access is only available in Agent mode. Ask the user to switch with the Chat/Agent control at the top of the chat window, then try again.'
        );
      }
      return JSON.stringify(
        {
          tool_access: {
            fileRead: settings.tools.fileRead,
            fileWrite: settings.tools.fileWrite,
            workspaceSearch: settings.tools.workspaceSearch,
            commandDeck: settings.tools.commandDeck,
            allowModelSystemPrompt: settings.tools.allowModelSystemPrompt
          },
          /** Matches labels in Settings → Tool access */
          labels: {
            fileRead: 'Read files',
            fileWrite: 'Write files',
            workspaceSearch: 'Workspace search',
            commandDeck: 'Command deck',
            allowModelSystemPrompt: 'AI can change system prompt'
          }
        },
        null,
        2
      );
    }

    if (toolCall.function.name === 'get_wizard_system_prompt') {
      if (settings.ui.sessionMode === 'talk') {
        throw new Error(
          'get_wizard_system_prompt is only available in Agent mode. Ask the user to switch with the Chat/Agent control at the top of the chat window, then try again.'
        );
      }
      if (!runtime.wizardId) {
        throw new Error('get_wizard_system_prompt is only available inside a Wizard session.');
      }
      const full = runtime.wizardSystemPrompt ?? '';
      const MAX_PREVIEW = 24_000;
      const truncated = full.length > MAX_PREVIEW;
      const system_prompt = truncated ? truncate(full, MAX_PREVIEW) : full;
      return JSON.stringify(
        {
          wizard_id: runtime.wizardId,
          wizard_name: runtime.wizardName ?? null,
          system_prompt,
          system_prompt_length: full.length,
          system_prompt_truncated: truncated
        },
        null,
        2
      );
    }

    if (toolCall.function.name === 'get_system_prompt') {
      if (settings.ui.sessionMode === 'talk') {
        throw new Error(
          'get_system_prompt is only available in Agent mode. Ask the user to switch with the Chat/Agent control at the top of the chat window, then try again.'
        );
      }
      const kind = settings.selectedProvider;
      const provider = settings.providers[kind];
      const full = provider.systemPrompt ?? '';
      const MAX_PREVIEW = 24_000;
      const truncated = full.length > MAX_PREVIEW;
      const system_prompt = truncated ? truncate(full, MAX_PREVIEW) : full;
      const preset =
        provider.activePromptPresetId == null
          ? { id: 'draft' as const, label: 'Draft' }
          : (() => {
              const row = provider.promptPresets.find((x) => x.id === provider.activePromptPresetId);
              return {
                id: provider.activePromptPresetId,
                label: row?.name ?? 'Preset'
              };
            })();
      return JSON.stringify(
        {
          active_provider: kind,
          prompt_preset: preset,
          active_prompt_preset_id: provider.activePromptPresetId,
          system_prompt,
          system_prompt_length: full.length,
          system_prompt_truncated: truncated
        },
        null,
        2
      );
    }

    if (toolCall.function.name === 'revert_app_theme') {
      if (settings.ui.sessionMode === 'talk') {
        throw new Error(
          'revert_app_theme is only available in Agent mode. Ask the user to switch with the Chat/Agent control at the top of the chat window, then try again.'
        );
      }
      if (!this.applyAppTheme || !this.getAppThemeState) {
        throw new Error('Theme changes are not available in this build.');
      }
      let state: { canRevert?: boolean; previousThemeId?: string | null };
      try {
        state = JSON.parse(this.getAppThemeState()) as { canRevert?: boolean; previousThemeId?: string | null };
      } catch {
        throw new Error('Could not read theme state.');
      }
      if (!state.canRevert || !state.previousThemeId || !isThemeId(state.previousThemeId)) {
        throw new Error(
          'No previous theme to revert to. The app remembers one step back after a theme change in Settings or via set_app_theme.'
        );
      }
      const result = await this.applyAppTheme(state.previousThemeId);
      this.patchSettingsThemeFromToolResult(settings, result);
      return result;
    }

    if (toolCall.function.name === 'set_system_prompt') {
      if (settings.ui.sessionMode === 'talk') {
        throw new Error(
          'set_system_prompt is only available in Agent mode. Ask the user to switch with the Chat/Agent control at the top of the chat window, then try again.'
        );
      }
      if (!settings.tools.allowModelSystemPrompt) {
        throw new Error(
          'Changing the system prompt from the model is turned off. The user can enable “AI can change system prompt” under Settings → Tool access.'
        );
      }
      if (!this.persistAppSettings) {
        throw new Error('System prompt updates are not available in this build.');
      }
      const system_prompt = String((args as { system_prompt?: string }).system_prompt ?? '');
      if (!system_prompt.trim()) {
        throw new Error('set_system_prompt requires a non-empty system_prompt string.');
      }
      const MAX_SYSTEM_PROMPT = 120_000;
      if (system_prompt.length > MAX_SYSTEM_PROMPT) {
        throw new Error(`system_prompt is too long (max ${MAX_SYSTEM_PROMPT} characters).`);
      }
      const providerKind = settings.selectedProvider;
      await this.requestApprovalIfNeeded(
        window,
        requestId,
        settings,
        runtime,
        'Approve system prompt change',
        `The model wants to replace the **${providerKind}** system prompt (${system_prompt.length} characters).\n\nPreview:\n${truncate(system_prompt, 900)}`
      );
      const saved = await this.persistAppSettings((base) => {
        const p = base.providers[providerKind];
        return syncProviderSystemPromptFields({
          ...base,
          providers: {
            ...base.providers,
            [providerKind]: {
              ...p,
              systemPrompt: system_prompt,
              activePromptPresetId: null
            }
          }
        });
      });
      Object.assign(settings, saved);
      return JSON.stringify(
        {
          ok: true,
          length: system_prompt.length,
          message: 'Global system prompt saved across providers. It applies on the next message.'
        },
        null,
        2
      );
    }

    if (toolCall.function.name === 'set_wizard_system_prompt') {
      if (!runtime.wizardId) {
        throw new Error('set_wizard_system_prompt is only available inside a Wizard session.');
      }
      if (!this.persistWizardSystemPrompt) {
        throw new Error('Wizard system prompt updates are not available in this build.');
      }
      const system_prompt = String((args as { system_prompt?: string }).system_prompt ?? '');
      if (!system_prompt.trim()) {
        throw new Error('set_wizard_system_prompt requires a non-empty system_prompt string.');
      }
      const MAX_SYSTEM_PROMPT = 120_000;
      if (system_prompt.length > MAX_SYSTEM_PROMPT) {
        throw new Error(`system_prompt is too long (max ${MAX_SYSTEM_PROMPT} characters).`);
      }
      const leaked = wizardPromptLooksLikeInjectedRouting(system_prompt);
      if (leaked) {
        throw new Error(
          `set_wizard_system_prompt contained pasted Mythra routing text (${leaked}). Put only this Wizard’s authored instructions—use read_file on identity.md, personality.md, memory.md, or workspace docs for facts, then edit minimally. Remove any blocks matching hidden Agent routing (e.g. lines beginning with “[Mythra model routing” or “[Mythra] Thread id”).`
        );
      }
      const before = runtime.wizardSystemPrompt ?? '';
      this.emitActivity(window, requestId, 'approval', 'Approve Wizard system prompt change: waiting for user approval.');
      if (this.requestWizardPromptApproval) {
        await this.requestWizardPromptApproval(window, runtime.wizardName ?? 'Wizard', before, system_prompt);
      } else {
        await this.requestApproval(
          window,
          `Approve ${runtime.wizardName ?? 'Wizard'} prompt change`,
          [
            'The Wizard wants to replace its private system prompt.',
            '',
            'ORIGINAL SYSTEM PROMPT',
            truncate(before || '[empty]', 1_500),
            '',
            '→ NEW SYSTEM PROMPT',
            truncate(system_prompt, 1_500)
          ].join('\n')
        );
      }
      await this.persistWizardSystemPrompt(runtime.wizardId, system_prompt);
      runtime.wizardSystemPrompt = system_prompt;
      return JSON.stringify(
        {
          ok: true,
          wizardId: runtime.wizardId,
          length: system_prompt.length,
          message: 'Wizard system prompt saved. It applies on the next message.'
        },
        null,
        2
      );
    }

    if (toolCall.function.name === 'set_wizard_display_name') {
      if (settings.ui.sessionMode === 'talk') {
        throw new Error(
          'set_wizard_display_name is only available in Agent mode. Ask the user to switch with the Chat/Agent control at the top of the chat window, then try again.'
        );
      }
      if (!runtime.wizardId) {
        throw new Error('set_wizard_display_name is only available inside a Wizard session.');
      }
      if (!this.persistWizardDisplayName) {
        throw new Error('Wizard display name updates are not available in this build.');
      }
      const raw = String((args as { display_name?: string }).display_name ?? '');
      const display_name = raw.replace(/[\u0000-\u001f]/g, '').trim();
      if (!display_name) {
        throw new Error('set_wizard_display_name requires a non-empty display_name.');
      }
      if (display_name.length > 120) {
        throw new Error('display_name is too long (max 120 characters).');
      }
      const prevWizardRoot = runtime.workspaceRoot;
      const wizard = await this.persistWizardDisplayName(runtime.wizardId, display_name);
      runtime.wizardName = wizard.name;
      runtime.workspaceRoot = wizard.workspaceRoot;
      runtime.activeFilePath = remapActiveFilePathAfterWorkspaceRootChange(
        prevWizardRoot,
        wizard.workspaceRoot,
        runtime.activeFilePath
      );
      return JSON.stringify(
        {
          ok: true,
          wizardId: runtime.wizardId,
          display_name,
          message:
            'Wizard display name saved for the sidebar and Wizard settings. Mythra renames the workspace folder when needed so it matches your name. Update identity.md (or legacy soul.md) and call set_wizard_system_prompt if needed so your identity text matches.'
        },
        null,
        2
      );
    }

    if (!workspaceRoot) {
      throw new Error(`Tool ${toolCall.function.name} was requested, but no workspace is attached.`);
    }

    const wizardAllowOutside = Boolean(runtime.wizardAllowOutsideWorkspace);

    switch (toolCall.function.name) {
      case 'create_wizard_memory': {
        if (!runtime.wizardId) {
          throw new Error('create_wizard_memory is only available inside a Wizard session.');
        }
        if (!settings.tools.fileWrite) {
          throw new Error('create_wizard_memory requires Write files to be enabled in Tool access.');
        }
        const memory = String(args.memory ?? '').replace(/[\u0000-\u001f]/g, ' ').trim();
        const category = String(args.category ?? '').replace(/[\u0000-\u001f]/g, ' ').trim();
        if (!memory) {
          throw new Error('create_wizard_memory requires a non-empty memory.');
        }
        if (memory.length > 2_000) {
          throw new Error('Memory entry is too long (max 2,000 characters).');
        }

        let before = '# Memory\n\n';
        try {
          const existing = await this.workspaceService.openFile(workspaceRoot, 'memory.md', false);
          before = existing.content || before;
        } catch {
          before = '# Memory\n\n';
        }
        const timestamp = currentLocalTimePayload().localIso;
        const label = category ? ` [${category.slice(0, 80)}]` : '';
        const entry = `\n\n- ${timestamp}${label}: ${memory}\n`;
        const after = `${before.trimEnd()}${entry}`;

        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          'Approve Wizard memory update',
          `The Wizard wants to append a durable memory to memory.md:\n${memory}`,
          { before, after }
        );

        const file = await this.workspaceService.saveFile(workspaceRoot, 'memory.md', after, false);
        window.webContents.send('workspace:changed', { root: workspaceRoot, fileWritten: file.path });
        return JSON.stringify(
          {
            ok: true,
            path: relative(workspaceRoot, file.path),
            memory,
            message: 'Wizard memory saved to memory.md.'
          },
          null,
          2
        );
      }

      case 'list_recent_files': {
        if (!settings.tools.workspaceSearch) {
          throw new Error('The list_recent_files tool is disabled in settings.');
        }
        const limit = safeChatToolLimit(args.limit, 25, 100);
        const files = await this.workspaceService.listRecentFiles(workspaceRoot, limit);
        return JSON.stringify({ ok: true, workspaceRoot, count: files.length, files }, null, 2);
      }

      case 'summarize_file': {
        if (!settings.tools.fileRead) {
          throw new Error('The summarize_file tool is disabled in settings.');
        }
        const path = String(args.path ?? '');
        if (!path) {
          throw new Error('summarize_file requires a path.');
        }
        const pdfStartPage = Number(args.pdf_start_page);
        const pdfPageCount = Number(args.pdf_page_count);
        const rawPdfOcr = String(args.pdf_ocr ?? 'auto');
        const pdfOcr = rawPdfOcr === 'on' || rawPdfOcr === 'off' ? rawPdfOcr : 'auto';
        const file = await this.workspaceService.openFile(workspaceRoot, path, wizardAllowOutside, {
          pdf: {
            startPage: Number.isFinite(pdfStartPage) ? pdfStartPage : undefined,
            pageCount: Number.isFinite(pdfPageCount) ? pdfPageCount : undefined,
            ocr: pdfOcr
          }
        });
        if (file.imagePreview) {
          throw new Error('summarize_file cannot summarize image bytes. Use describe_image for image files.');
        }
        const focus = String(args.focus ?? '').trim();
        const signal = this.activeRequests.get(requestId)?.controller.signal;
        const summary = await this.summarizeContentWithModel(settings, relative(workspaceRoot, file.path), file.content, focus, signal);
        return JSON.stringify(
          {
            ok: true,
            path: relative(workspaceRoot, file.path),
            kind: file.readOnlyReason?.toLowerCase().includes('pdf') ? 'pdf' : 'text',
            readOnly: Boolean(file.readOnly),
            note: file.readOnlyReason,
            focus: focus || null,
            summary
          },
          null,
          2
        );
      }

      case 'describe_image': {
        if (!settings.tools.fileRead) {
          throw new Error('The describe_image tool is disabled in settings.');
        }
        const path = String(args.path ?? '');
        if (!path) {
          throw new Error('describe_image requires a path.');
        }
        const file = await this.workspaceService.openFile(workspaceRoot, path, wizardAllowOutside);
        if (!file.imagePreview) {
          throw new Error('describe_image requires a supported image file path.');
        }
        const question = String(args.question ?? '').trim();
        const signal = this.activeRequests.get(requestId)?.controller.signal;
        const description = await this.describeImageWithModel(
          settings,
          relative(workspaceRoot, file.path),
          file.imagePreview.dataUrl,
          question,
          signal
        );
        return JSON.stringify(
          {
            ok: true,
            path: relative(workspaceRoot, file.path),
            mimeType: file.imagePreview.mimeType,
            question: question || null,
            description
          },
          null,
          2
        );
      }

      case 'transcribe_audio': {
        if (!settings.tools.fileRead) {
          throw new Error('The transcribe_audio tool is disabled in settings.');
        }
        const path = String(args.path ?? '');
        if (!path) {
          throw new Error('transcribe_audio requires a path.');
        }
        const audio = await this.workspaceService.readBinaryFile(workspaceRoot, path, wizardAllowOutside);
        if (!audio.mimeType.startsWith('audio/')) {
          throw new Error(`transcribe_audio requires an audio file. Detected ${audio.mimeType}.`);
        }
        const prompt = String(args.prompt ?? '').trim();
        const signal = this.activeRequests.get(requestId)?.controller.signal;
        const transcript = await this.transcribeAudioWithModel(
          settings,
          relative(workspaceRoot, audio.path),
          audio.mimeType,
          audio.dataBase64,
          prompt,
          signal
        );
        return JSON.stringify(
          {
            ok: true,
            path: relative(workspaceRoot, audio.path),
            mimeType: audio.mimeType,
            transcript
          },
          null,
          2
        );
      }

      case 'list_nexus_teammate_workspaces': {
        if (!settings.tools.fileRead) {
          throw new Error('The list_nexus_teammate_workspaces tool is disabled in settings.');
        }
        const members = runtime.nexusTeamWorkspaces ?? [];
        if (members.length === 0) {
          throw new Error('This chat has no Nexus teammate workspace references.');
        }
        const entries = await Promise.all(
          members.map(async (member) => {
            try {
              const docs = await this.workspaceService.listWizardWorkspaceDocuments(member.workspaceRoot);
              return {
                wizardId: member.wizardId,
                wizardName: member.wizardName,
                role: member.role,
                workspaceRoot: member.workspaceRoot,
                markdownDocuments: docs
                  .filter((doc) => /\.md$/i.test(doc.path))
                  .map((doc) => ({
                    path: relative(member.workspaceRoot, doc.path),
                    label: doc.label,
                    core: doc.core
                  }))
              };
            } catch (error) {
              return {
                wizardId: member.wizardId,
                wizardName: member.wizardName,
                role: member.role,
                workspaceRoot: member.workspaceRoot,
                error: error instanceof Error ? error.message : 'Could not list workspace.'
              };
            }
          })
        );
        return JSON.stringify({ ok: true, count: entries.length, entries }, null, 2);
      }

      case 'read_nexus_teammate_file': {
        if (!settings.tools.fileRead) {
          throw new Error('The read_nexus_teammate_file tool is disabled in settings.');
        }
        const members = runtime.nexusTeamWorkspaces ?? [];
        if (members.length === 0) {
          throw new Error('This chat has no Nexus teammate workspace references.');
        }
        const wizardId = String(args.wizard_id ?? '').trim();
        const wizardName = String(args.wizard_name ?? '').trim().toLowerCase();
        const member =
          members.find((candidate) => candidate.wizardId === wizardId) ??
          members.find((candidate) => candidate.wizardName.trim().toLowerCase() === wizardName);
        if (!member) {
          throw new Error('read_nexus_teammate_file requires a valid wizard_id or wizard_name from list_nexus_teammate_workspaces.');
        }
        const path = String(args.path ?? '');
        if (!path) {
          throw new Error('read_nexus_teammate_file requires a path.');
        }
        const pdfStartPage = Number(args.pdf_start_page);
        const pdfPageCount = Number(args.pdf_page_count);
        const rawPdfOcr = String(args.pdf_ocr ?? 'auto');
        const pdfOcr = rawPdfOcr === 'on' || rawPdfOcr === 'off' ? rawPdfOcr : 'auto';
        const file = await this.workspaceService.openFile(member.workspaceRoot, path, false, {
          pdf: {
            startPage: Number.isFinite(pdfStartPage) ? pdfStartPage : undefined,
            pageCount: Number.isFinite(pdfPageCount) ? pdfPageCount : undefined,
            ocr: pdfOcr
          }
        });
        if (file.imagePreview && !file.content) {
          return JSON.stringify(
            {
              wizardId: member.wizardId,
              wizardName: member.wizardName,
              path: relative(member.workspaceRoot, file.path),
              kind: 'image',
              mimeType: file.imagePreview.mimeType,
              readOnly: true,
              note: 'Binary image file. No text content is returned here.'
            },
            null,
            2
          );
        }
        return JSON.stringify(
          {
            wizardId: member.wizardId,
            wizardName: member.wizardName,
            path: relative(member.workspaceRoot, file.path),
            kind: file.readOnlyReason?.toLowerCase().includes('pdf') ? 'pdf' : 'text',
            readOnly: true,
            note: file.readOnlyReason ?? 'Read-only Nexus teammate workspace file.',
            content: truncate(file.content)
          },
          null,
          2
        );
      }

      case 'list_files': {
        if (!settings.tools.workspaceSearch) {
          throw new Error('The list_files tool is disabled in settings.');
        }

        const files = await this.workspaceService.listFiles(workspaceRoot);
        return JSON.stringify(
          {
            workspaceRoot,
            count: files.length,
            entries: files.slice(0, 240)
          },
          null,
          2
        );
      }

      case 'read_file': {
        if (!settings.tools.fileRead) {
          throw new Error('The read_file tool is disabled in settings.');
        }

        const path = String(args.path ?? '');
        if (!path) {
          throw new Error('read_file requires a path.');
        }

        const pdfStartPage = Number(args.pdf_start_page);
        const pdfPageCount = Number(args.pdf_page_count);
        const rawPdfOcr = String(args.pdf_ocr ?? 'auto');
        const pdfOcr = rawPdfOcr === 'on' || rawPdfOcr === 'off' ? rawPdfOcr : 'auto';
        const file = await this.workspaceService.openFile(workspaceRoot, path, wizardAllowOutside, {
          pdf: {
            startPage: Number.isFinite(pdfStartPage) ? pdfStartPage : undefined,
            pageCount: Number.isFinite(pdfPageCount) ? pdfPageCount : undefined,
            ocr: pdfOcr
          }
        });
        if (file.imagePreview && !file.content) {
          return JSON.stringify(
            {
              path: relative(workspaceRoot, file.path),
              kind: 'image',
              mimeType: file.imagePreview.mimeType,
              note: 'Binary image file. Preview it in the Editor tab; no text content is returned here.'
            },
            null,
            2
          );
        }
        return JSON.stringify(
          {
            path: relative(workspaceRoot, file.path),
            kind: file.readOnlyReason?.toLowerCase().includes('pdf') ? 'pdf' : 'text',
            readOnly: Boolean(file.readOnly),
            note: file.readOnlyReason,
            content: truncate(file.content)
          },
          null,
          2
        );
      }

      case 'write_file': {
        if (!settings.tools.fileWrite) {
          throw new Error('The write_file tool is disabled in settings.');
        }

        const path = String(args.path ?? '');
        const content = String(args.content ?? '');
        if (!path) {
          throw new Error('write_file requires a path.');
        }

        let textDiff: { before: string; after: string } | undefined;
        try {
          const existing = await this.workspaceService.openFile(workspaceRoot, path, wizardAllowOutside);
          if (!existing.imagePreview) {
            textDiff = { before: existing.content, after: content };
          }
        } catch {
          textDiff = { before: '', after: content };
        }

        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          'Approve file write',
          textDiff
            ? `The model wants to create or overwrite this path:\n${path}\n\nCompare the previous file (left) to the proposed text (right).`
            : `The model wants to write (binary image or unreadable):\n${path}\n\nThis will create or overwrite the file.`,
          textDiff
        );

        const file = await this.workspaceService.saveFile(workspaceRoot, path, content, wizardAllowOutside);
        window.webContents.send('workspace:changed', { root: workspaceRoot, fileWritten: file.path });
        return JSON.stringify(
          {
            ok: true,
            path: relative(workspaceRoot, file.path),
            bytes: Buffer.byteLength(content, 'utf8')
          },
          null,
          2
        );
      }

      case 'apply_patch': {
        if (!settings.tools.fileWrite) {
          throw new Error('The apply_patch tool is disabled in settings.');
        }

        const patch = String(args.patch ?? '');
        if (!patch.trim()) {
          throw new Error('apply_patch requires a patch.');
        }

        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          'Approve patch',
          `The model wants to apply a patch inside:\n${workspaceRoot}\n\nPatch preview:\n${truncate(patch, 2_500)}`
        );

        const changes = await this.workspaceService.applyPatch(workspaceRoot, patch);
        window.webContents.send('workspace:changed', { root: workspaceRoot });
        return JSON.stringify({ ok: true, changes }, null, 2);
      }

      case 'replace_in_file': {
        if (!settings.tools.fileWrite) {
          throw new Error('The replace_in_file tool is disabled in settings.');
        }
        const path = String(args.path ?? '');
        const search = String(args.search ?? '');
        const replacement = String(args.replacement ?? '');
        const replaceAll = Boolean(args.replace_all);
        if (!path) throw new Error('replace_in_file requires a path.');

        const file = await this.workspaceService.openFile(workspaceRoot, path, wizardAllowOutside);
        let textDiff: { before: string; after: string } | undefined;
        if (!file.imagePreview) {
          const before = file.content;
          if (!search) {
            throw new Error('Search text cannot be empty.');
          }
          const occurrences = before.split(search).length - 1;
          if (occurrences === 0) {
            throw new Error('Search text was not found.');
          }
          const after = replaceAll ? before.split(search).join(replacement) : before.replace(search, replacement);
          textDiff = { before, after };
        }

        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          'Approve file edit',
          textDiff
            ? `The model wants to replace text in:\n${path}`
            : `The model wants to replace text in:\n${path}\n\nSearch:\n${truncate(search, 1_200)}\n\nReplacement:\n${truncate(replacement, 1_200)}`,
          textDiff
        );

        const result = await this.workspaceService.replaceInFile(
          workspaceRoot,
          path,
          search,
          replacement,
          replaceAll,
          wizardAllowOutside
        );
        window.webContents.send('workspace:changed', { root: workspaceRoot, fileWritten: result.path });
        return JSON.stringify(
          { ok: true, path: relative(workspaceRoot, result.path), replacements: result.replacements },
          null,
          2
        );
      }

      case 'insert_after': {
        if (!settings.tools.fileWrite) {
          throw new Error('The insert_after tool is disabled in settings.');
        }
        const path = String(args.path ?? '');
        const anchor = String(args.anchor ?? '');
        const text = String(args.text ?? '');
        if (!path) throw new Error('insert_after requires a path.');
        if (!anchor) {
          throw new Error('Anchor text cannot be empty.');
        }

        const file = await this.workspaceService.openFile(workspaceRoot, path, wizardAllowOutside);
        let textDiff: { before: string; after: string } | undefined;
        if (!file.imagePreview) {
          const beforeContent = file.content;
          const index = beforeContent.indexOf(anchor);
          if (index < 0) {
            throw new Error('Anchor text was not found.');
          }
          const at = index + anchor.length;
          const afterContent = `${beforeContent.slice(0, at)}${text}${beforeContent.slice(at)}`;
          textDiff = { before: beforeContent, after: afterContent };
        }

        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          'Approve file insertion',
          textDiff
            ? `The model wants to insert text in:\n${path}`
            : `The model wants to insert text in:\n${path}\n\nAfter:\n${truncate(anchor, 1_200)}\n\nInsert:\n${truncate(text, 1_200)}`,
          textDiff
        );

        const result = await this.workspaceService.insertAfter(workspaceRoot, path, anchor, text, wizardAllowOutside);
        window.webContents.send('workspace:changed', { root: workspaceRoot, fileWritten: result.path });
        return JSON.stringify({ ok: true, path: relative(workspaceRoot, result.path) }, null, 2);
      }

      case 'rename_file': {
        if (!settings.tools.fileWrite) {
          throw new Error('The rename_file tool is disabled in settings.');
        }
        const from = String(args.from ?? '');
        const to = String(args.to ?? '');
        if (!from || !to) throw new Error('rename_file requires from and to.');

        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          'Approve rename',
          `The model wants to rename:\n${from}\n\nto:\n${to}`
        );

        const result = await this.workspaceService.renamePath(workspaceRoot, from, to, wizardAllowOutside);
        window.webContents.send('workspace:changed', { root: workspaceRoot, fileDeleted: result.from, fileWritten: result.to });
        return JSON.stringify(
          { ok: true, from: relative(workspaceRoot, result.from), to: relative(workspaceRoot, result.to) },
          null,
          2
        );
      }

      case 'delete_path': {
        if (!settings.tools.fileWrite) {
          throw new Error('The delete_path tool is disabled in settings.');
        }

        const path = String(args.path ?? '');
        if (!path) {
          throw new Error('delete_path requires a path.');
        }

        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          'Approve delete',
          `The model wants to delete:\n${path}\n\nThis cannot be undone from the app.`
        );

        const deleted = await this.workspaceService.deletePath(workspaceRoot, path, wizardAllowOutside);
        window.webContents.send('workspace:changed', { root: workspaceRoot, fileDeleted: deleted.path });
        return JSON.stringify(
          {
            ok: true,
            path: relative(workspaceRoot, deleted.path)
          },
          null,
          2
        );
      }

      case 'get_git_diff': {
        if (!settings.tools.commandDeck) {
          throw new Error('The get_git_diff tool is disabled in settings.');
        }
        return JSON.stringify(await this.workspaceService.getChanges(workspaceRoot), null, 2);
      }

      case 'search_symbols': {
        if (!settings.tools.workspaceSearch) {
          throw new Error('The search_symbols tool is disabled in settings.');
        }
        const query = String(args.query ?? '');
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, args.limit)) : 50;
        return JSON.stringify({ ok: true, results: await this.workspaceService.searchSymbols(workspaceRoot, query, limit) }, null, 2);
      }

      case 'get_file_outline': {
        if (!settings.tools.workspaceSearch) {
          throw new Error('The get_file_outline tool is disabled in settings.');
        }
        const path = String(args.path ?? '');
        if (!path) throw new Error('get_file_outline requires a path.');
        return JSON.stringify(
          { ok: true, ...(await this.workspaceService.getFileOutline(workspaceRoot, path, wizardAllowOutside)) },
          null,
          2
        );
      }

      case 'run_command': {
        if (!settings.tools.commandDeck) {
          throw new Error('The run_command tool is disabled in settings.');
        }

        const path = String(args.command ?? '');
        if (!path) {
          throw new Error('run_command requires a command.');
        }

        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          'Approve command execution',
          `The model wants to run:\n${path}\n\nThe command will execute inside:\n${workspaceRoot}`
        );

        const signal = this.activeRequests.get(requestId)?.controller.signal;
        const result = await this.commandService.runAndCapture(path, workspaceRoot, 20_000, signal);
        return JSON.stringify(result, null, 2);
      }

      case 'run_tests': {
        if (!settings.tools.commandDeck) {
          throw new Error('The run_tests tool is disabled in settings.');
        }
        const command = String(args.command ?? '').trim() || 'npm test';
        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          'Approve test command',
          `The model wants to run:\n${command}\n\nThe command will execute inside:\n${workspaceRoot}`
        );
        const signal = this.activeRequests.get(requestId)?.controller.signal;
        const result = await this.commandService.runAndCapture(command, workspaceRoot, 60_000, signal);
        return JSON.stringify(result, null, 2);
      }

      default:
        throw new Error(`Unknown tool: ${toolCall.function.name}`);
    }
  }

  private patchSettingsThemeFromToolResult(settings: AppSettings, result: string) {
    try {
      const parsed = JSON.parse(result) as {
        ok?: boolean;
        themeId?: string;
        customThemeTokens?: Record<string, string>;
      };
      if (!parsed.ok || !parsed.themeId || !isThemeId(parsed.themeId)) return;
      settings.ui.themeId = parsed.themeId;
      if (isPresetThemeId(parsed.themeId)) {
        delete settings.ui.customThemeTokens;
      } else if (parsed.customThemeTokens) {
        settings.ui.customThemeTokens = parsed.customThemeTokens;
      }
    } catch {
      // ignore malformed tool JSON
    }
  }

  private async summarizeContentWithModel(
    settings: AppSettings,
    path: string,
    content: string,
    focus: string,
    signal: AbortSignal | undefined
  ) {
    const provider = settings.providers[settings.selectedProvider];
    if (!provider.model) {
      throw new Error('Select a model before summarizing files.');
    }
    const client = createClient(settings);
    const chunkSize = 16_000;
    const maxChunks = 8;
    const chunks: string[] = [];
    for (let i = 0; i < content.length && chunks.length < maxChunks; i += chunkSize) {
      chunks.push(content.slice(i, i + chunkSize));
    }
    const truncatedForSummary = content.length > chunkSize * maxChunks;
    const chunkSummaries: string[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const completion = await client.chat.completions.create(
        withOpenRouterReasoning(settings, settings.selectedProvider, {
          model: provider.model,
          messages: [
            {
              role: 'system',
              content:
                'Summarize this file chunk accurately and compactly. Preserve names, decisions, risks, TODOs, APIs, and notable details. Do not invent.'
            },
            {
              role: 'user',
              content: [
                `File: ${path}`,
                `Chunk: ${i + 1} of ${chunks.length}${truncatedForSummary ? ' (file truncated for summary budget)' : ''}`,
                focus ? `Focus: ${focus}` : '',
                '',
                chunks[i]
              ]
                .filter(Boolean)
                .join('\n')
            }
          ],
          max_tokens: 900
        }) as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        signal ? { signal } : undefined
      );
      chunkSummaries.push(contentToString(completion.choices[0]?.message?.content ?? '').trim());
    }

    if (chunkSummaries.length <= 1) {
      return chunkSummaries[0] || 'No summary could be produced.';
    }

    const final = await client.chat.completions.create(
      withOpenRouterReasoning(settings, settings.selectedProvider, {
        model: provider.model,
        messages: [
          {
            role: 'system',
            content:
              'Combine chunk summaries into one clear file summary. Include overall purpose, important details, risks/open questions, and anything matching the user focus. Do not invent.'
          },
          {
            role: 'user',
            content: [
              `File: ${path}`,
              focus ? `Focus: ${focus}` : '',
              truncatedForSummary ? 'Note: very long file; only the first bounded chunks were summarized.' : '',
              '',
              chunkSummaries.map((summary, index) => `--- Chunk ${index + 1} summary ---\n${summary}`).join('\n\n')
            ]
              .filter(Boolean)
              .join('\n')
          }
        ],
        max_tokens: 1_400
      }) as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      signal ? { signal } : undefined
    );
    return contentToString(final.choices[0]?.message?.content ?? '').trim() || chunkSummaries.join('\n\n');
  }

  private async describeImageWithModel(
    settings: AppSettings,
    path: string,
    dataUrl: string,
    question: string,
    signal: AbortSignal | undefined
  ) {
    const provider = settings.providers[settings.selectedProvider];
    if (!provider.model) {
      throw new Error('Select a model before describing images.');
    }
    const client = createClient(settings);
    const completion = await client.chat.completions.create(
      withOpenRouterReasoning(settings, settings.selectedProvider, {
        model: provider.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  question ||
                  `Describe this image from ${path}. Include visible text, objects, layout, and anything important for the user's likely task.`
              },
              {
                type: 'image_url',
                image_url: { url: dataUrl, detail: 'high' }
              }
            ]
          } as any
        ],
        max_tokens: 1_200
      }) as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      signal ? { signal } : undefined
    );
    return contentToString(completion.choices[0]?.message?.content ?? '').trim();
  }

  private async transcribeAudioWithModel(
    settings: AppSettings,
    path: string,
    mimeType: string,
    dataBase64: string,
    prompt: string,
    signal: AbortSignal | undefined
  ) {
    const provider = settings.providers[settings.selectedProvider];
    if (!provider.model) {
      throw new Error('Select a model before transcribing audio.');
    }
    const format = mimeType.includes('wav') ? 'wav' : mimeType.includes('webm') ? 'webm' : 'mp3';
    const client = createClient(settings);
    const completion = await client.chat.completions.create(
      withOpenRouterReasoning(settings, settings.selectedProvider, {
        model: provider.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt || `Transcribe this audio file from ${path}. Return the transcript and note any unclear sections.`
              },
              {
                type: 'input_audio',
                input_audio: {
                  data: dataBase64,
                  format
                }
              }
            ]
          } as any
        ],
        max_tokens: 2_000
      }) as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      signal ? { signal } : undefined
    );
    return contentToString(completion.choices[0]?.message?.content ?? '').trim();
  }

  private effectiveFullAccess(settings: AppSettings, runtime: ChatRuntimeContext): boolean {
    if (runtime.nexusTeamFullAccess) {
      return true;
    }
    if (runtime.wizardId != null) {
      return Boolean(runtime.wizardFullAccess);
    }
    return settings.agent.fullAccess;
  }

  private async resolveNexusLeaderToolApproval(
    settings: AppSettings,
    runtime: ChatRuntimeContext,
    title: string,
    detail: string,
    textDiff: { before: string; after: string } | undefined,
    signal: AbortSignal | undefined
  ): Promise<boolean> {
    const kind = runtime.nexusLeaderProvider;
    const model = runtime.nexusLeaderModel?.trim();
    if (!kind || !model) {
      return false;
    }

    const profile = settings.providers[kind];
    if (!profile?.baseUrl?.trim()) {
      return false;
    }

    let body = truncate(detail, 12_000);
    if (textDiff) {
      body += `\n\n--- proposed change (truncated) ---\nBefore:\n${truncate(textDiff.before, 6_000)}\n\nAfter:\n${truncate(textDiff.after, 6_000)}`;
    }

    const leaderName = runtime.nexusLeaderName?.trim() || 'Nexus leader';
    const client = createClient(settings, kind);

    const approvalSignal = mergeLeaderApprovalDeadline(signal, resolveLeaderApprovalWallMs());

    try {
      const completion = await client.chat.completions.create(
        withOpenRouterReasoning(settings, kind, {
          model,
          messages: [
            {
              role: 'system',
              content:
                `You are ${leaderName}, the Nexus leader. Teammates proposed tool actions that require approval.\n\n` +
                `Reply with exactly one uppercase word: APPROVE or DENY.\n\n` +
                `Approve only when the action fits the Nexus mission, respects the shared workspace, and is not reckless. Deny unclear or destructive requests.`
            },
            {
              role: 'user',
              content: `Approval title: ${title}\n\nDetails:\n${body}`
            }
          ],
          max_tokens: 16,
          temperature: 0
        }) as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        approvalSignal ? { signal: approvalSignal } : signal ? { signal } : undefined
      );

      const raw = contentToString(completion.choices[0]?.message?.content ?? '').trim().toUpperCase();
      const token = raw.split(/\s+/)[0] ?? '';
      return token === 'APPROVE';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return false;
      }
      throw err;
    }
  }

  private async requestApprovalIfNeeded(
    window: BrowserWindow,
    requestId: string,
    settings: AppSettings,
    runtime: ChatRuntimeContext,
    title: string,
    detail: string,
    textDiff?: { before: string; after: string }
  ) {
    if (this.effectiveFullAccess(settings, runtime)) {
      return;
    }

    if (
      runtime.nexusLeaderApprovesTools &&
      runtime.nexusLeaderProvider &&
      runtime.nexusLeaderModel?.trim()
    ) {
      this.emitActivity(window, requestId, 'approval', `${title}: Nexus leader reviewing…`);
      const active = this.activeRequests.get(requestId);
      const approved = await this.resolveNexusLeaderToolApproval(
        settings,
        runtime,
        title,
        detail,
        textDiff,
        active?.controller.signal
      );
      if (!approved) {
        const error = new Error('Nexus leader denied this tool action.');
        error.name = 'ToolApprovalDeniedError';
        throw error;
      }
      return;
    }

    this.emitActivity(window, requestId, 'approval', `${title}: waiting for user approval.`);
    await this.requestApproval(window, title, detail, textDiff);
  }

  private async requestApproval(window: BrowserWindow, title: string, detail: string, textDiff?: { before: string; after: string }) {
    if (!this.requestToolApprovalUi) {
      throw new Error('Tool approval UI is not wired.');
    }
    await this.requestToolApprovalUi(window, title, detail, textDiff);
  }

  private assertNotStopped(requestId: string) {
    const active = this.activeRequests.get(requestId);
    if (active?.stopped) {
      const error = new Error('Request stopped.');
      error.name = 'AbortError';
      throw error;
    }
  }

  private emitActivity(window: BrowserWindow, requestId: string, kind: ChatActivity['kind'], message: string) {
    const payload: ChatActivity = {
      id: randomUUID(),
      requestId,
      kind,
      message
    };
    window.webContents.send('chat:activity', payload);
  }
}

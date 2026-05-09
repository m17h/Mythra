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
  ChatCompletionTokenUsage,
  ChatAttachment,
  ChatMessage,
  ChatStreamDone,
  ChatStreamError,
  ModelInfo,
  ModelListOptions,
  ProviderKind,
  SessionMode,
  WizardProfile
} from '@shared/types';
import { MYTHRA_SESSION_MODE_TOGGLE, MYTHRA_WEB_SEARCH_TOGGLE } from '@shared/mythra-embeds';
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

function mapCompletionUsage(
  u: { prompt_tokens?: number | null; completion_tokens?: number | null; total_tokens?: number | null } | null | undefined
): ChatCompletionTokenUsage | undefined {
  if (!u) return undefined;
  const pt = u.prompt_tokens ?? 0;
  const ct = u.completion_tokens ?? 0;
  const tt = u.total_tokens ?? pt + ct;
  return { promptTokens: pt, completionTokens: ct, totalTokens: tt };
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
  if (kind !== 'lmstudio') {
    return trimmed;
  }

  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
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
    apiKey: provider.apiKey || 'lm-studio',
    defaultHeaders: headers,
    dangerouslyAllowBrowser: false
  });
};

const mapModelEntry = (entry: { id?: unknown; owned_by?: unknown }): ModelInfo => {
  const raw = entry as {
    context_length?: unknown;
    architecture?: {
      input_modalities?: unknown;
      output_modalities?: unknown;
    };
  };
  const inputModalities = Array.isArray(raw.architecture?.input_modalities)
    ? raw.architecture.input_modalities.filter((modality): modality is string => typeof modality === 'string')
    : undefined;
  const outputModalities = Array.isArray(raw.architecture?.output_modalities)
    ? raw.architecture.output_modalities.filter((modality): modality is string => typeof modality === 'string')
    : undefined;

  return {
    id: String(entry.id ?? ''),
    contextLength: typeof raw.context_length === 'number' ? raw.context_length : undefined,
    ownedBy: typeof entry.owned_by === 'string' ? entry.owned_by : undefined,
    inputModalities,
    outputModalities
  };
};

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
  'System prompt: in Agent mode you may always call get_system_prompt to read the stored instructions for the **currently selected** provider—it works even when “AI can change system prompt” is off and does not modify settings. If Tool access allows `set_system_prompt`, call it only when the user explicitly asks you to replace those instructions; it overwrites the full prompt for that provider and saves to disk. Call get_tool_access to read Tool access toggles.';

const mythraToolAccessReadInstruction =
  'Tool access: call get_tool_access when the user asks which capabilities are enabled or disabled in Settings → Tool access (files, workspace search, commands, changing the stored system prompt via set_system_prompt). Reading the stored prompt is always done with get_system_prompt in Agent mode, independent of those toggles.';

/** Grounds answers about Mythra itself so models do not deny sidebar features that always exist in this app. */
const mythraProductFeaturesInstruction =
  'Mythra UI (describe accurately when users ask how the app works; do **not** say Mythra has no Wizards or no Nexus): The left sidebar has **CHATS**, **WIZARDS**, and **FILES** tabs. In the Wizards section, a **Wizards / Nexus** control switches between the list of **Wizards** and the list of **Nexus projects**. **Wizards** are saved teammates with their own local **workspace folder**, **system prompt** (Inspector → Settings), and **four default core Markdown files only: soul.md, tools.md, memory.md, corrections.md**. Mythra does **not** create **todo.md** or any other default task/inbox file—users add those (or custom docs) if they want. Sessions under a Wizard run Agent tools against **that** Wizard’s folder. Wizards can be exported/imported as `.mythwiz` bundles. **Good Wizard examples** (suggest when users ask how to use them): train a **writing style or brand voice** (detail voice in soul.md, keep sample pieces in the workspace, fold feedback into memory/corrections); **complex note-taking** (PARA/Zettelkasten/second brain with linked `.md` in the folder); a **project or stack specialist** (conventions and commands in tools.md); **meeting, research, or journal** flows with dated notes the Wizard maintains; **creative or role-play** personas with lore bibles. **Nexus projects** (New → Nexus, needs at least two Wizards) tie multiple Wizards to **one shared project workspace** on disk; each member still has private identity/memory docs. A Nexus has a **leader** Wizard, optional **mission** text (Inspector → Nexus), **relay** mode (teammates usually speak one stream at a time inside one assistant reply) vs **parallel** mode (multiple teammate streams at once), and tool-approval options (e.g. team full access, leader model approval). A **normal** chat uses the globally open workspace; Wizard and Nexus sessions add the routing described above.';

const mythraCodingToolInstruction =
  'Mythra coding tools (apply_patch is validated by `git apply` from the workspace root — malformed hunks become “corrupt patch”): Before any edit, read_file the target so line context matches the file on disk. apply_patch must be a single plain-text unified diff (no markdown fences, no prose). First line: `diff --git a/relative/path b/relative/path`; then `--- a/relative/path` and `+++ b/relative/path`; use one hunk per change with `@@ -start,count +start,count @@` where counts are line counts (single-line change is often `@@ -N,1 +N,1 @@`). Paths use forward slashes and match the repo relative to workspace root. Do not include `\\ No newline` unless the file truly needs it. If apply_patch fails, switch to replace_in_file (one exact contiguous match) or write_file for new/small files, then retry. Also use replace_in_file for one exact replacement, insert_after for small anchored inserts, rename_file for moves, get_git_diff after edits, search_symbols/get_file_outline to navigate, run_tests when useful. Every tool call: strict JSON only (double quotes, escape newlines in strings as \\n). Fix malformed JSON and retry; do not blame “relay” or Mythra for corrupt diffs.';

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
      `Wizard session: you are running inside the "${label}" Wizard profile. The app merges this Wizard’s private instructions into the request; they are separate from the global LLM provider preset in Settings.`,
      'To change **this Wizard’s own** long-term instructions when the user asks, call `set_wizard_system_prompt` with the full new text. Mythra opens a before/after approval dialog—the user approves or rejects there. Do **not** tell them to enable “AI can change system prompt” under Settings → Tool access for Wizard instruction edits; that toggle only gates `set_system_prompt` (global provider prompt). `set_system_prompt` is not offered in Wizard chats.',
      '`get_wizard_system_prompt` reads this Wizard’s stored private instructions (read-only). Call it before small edits or `set_wizard_system_prompt`. `get_system_prompt` reads the separate **global LLM provider** preset in Settings—do not confuse the two.',
      '`set_wizard_display_name` updates the Wizard **shown name** in the sidebar and Inspector (stored profile). Mythra also renames the Wizard workspace folder on disk when the sanitized name no longer matches the folder name. When the user asks to rename you completely, call `set_wizard_display_name`, then edit soul.md and adjust `set_wizard_system_prompt` so identity text matches.',
      'Non-Wizard Tool access lines elsewhere in this prompt still apply to files, workspace search, and commands; Wizard prompt edits bypass the “AI can change system prompt” toggle.',
      '`set_wizard_system_prompt` must be **only** your Wizard’s authored persona/instructions text—the same kind of content shown in the Wizard editor—not hidden routing copied from this chat (never paste lines starting with `[Mythra model routing`, `[Mythra] Thread id`, workspace listings, or “Enabled tools:”). For small edits, call `get_wizard_system_prompt` first (and `read_file` on soul.md when facts live there), then minimally adjust—do not paste large unrelated blocks.',
      'Personality and durable memory belong in soul.md and memory.md. When the user revises how they want you to behave or what to remember, update those files with `write_file` so they stay authoritative.',
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
    ) => Promise<void>
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

    const client = createClient(settings, kind);
    const response = await client.models.list();

    return (response.data ?? []).map(mapModelEntry);
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
          await this.runImageGeneration(client, window, requestId, provider.model, apiMessages, controller, runtime.conversationId);
        } else if (runtime.mediaGenerationKind === 'video') {
          await this.runVideoGeneration(window, requestId, settings, provider.model, lastUserPrompt(messages), controller, runtime.conversationId);
        } else {
          await this.runTalkStream(client, window, requestId, provider.model, apiMessages, controller);
        }
        return;
      }

      const maxAutoSteps = settings.agent.autoContinue ? Math.max(4, settings.agent.maxAutoSteps || 24) : 1;

      let lastRoundUsage: ChatCompletionTokenUsage | undefined;

      for (let step = 0; step < maxAutoSteps; step += 1) {
        this.assertNotStopped(requestId);

        const stream = await client.chat.completions.create(
          {
            model: provider.model,
            messages: apiMessages,
            tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
            tool_choice: toolDefinitions.length > 0 ? 'auto' : undefined,
            stream: true,
            stream_options: { include_usage: true }
          },
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

            const toolResult = await this.executeToolCall(
              window,
              requestId,
              settings,
              runtime,
              toolCall,
              parsedArgs.args
            );
            this.assertNotStopped(requestId);

            apiMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: truncate(toolResult, 18_000)
            });

            this.emitActivity(window, requestId, 'success', formatToolActivityDone(toolCall.function.name, rawArgs));
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
          usage: lastStreamUsage
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
        usage: lastRoundUsage
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
    model: string,
    apiMessages: ChatCompletionMessageParam[],
    controller: AbortController
  ) {
    const finish = (done: ChatStreamDone) => {
      window.webContents.send('chat:done', done);
      this.activeRequests.delete(requestId);
    };

    try {
      const streamSignal = mergeStreamDeadline(controller, resolveStreamChatWallMs());
      const stream = await client.chat.completions.create(
        { model, messages: apiMessages, stream: true, stream_options: { include_usage: true } },
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
        finish({
          requestId,
          content:
            'In Chat mode the assistant cannot use file or shell tools. If you need those, switch to Agent with the Chat/Agent control at the top of the chat, or in Settings under Theme → Session mode—then use Open Workspace to mount a folder if you need the project, and try again.',
          usage: lastStreamUsage
        });
        return;
      }

      const talkNorm = normalizeAssistantContent(assembled);
      if (!talkNorm) {
        finish({ requestId, content: 'The model returned an empty reply. Try your message again.', usage: lastStreamUsage });
        return;
      }

      const reasoning = assembledReasoning.trim() || undefined;
      finish({ requestId, content: talkNorm, reasoning, usage: lastStreamUsage });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }

      const completion = await client.chat.completions.create(
        { model, messages: apiMessages },
        { signal: mergeStreamDeadline(controller, resolveStreamChatWallMs()) }
      );
      this.assertNotStopped(requestId);
      const fallbackUsage = mapCompletionUsage(completion.usage ?? undefined);
      const assistantMessage = completion.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error('The model returned no message.');
      }

      if (assistantMessage.tool_calls?.length) {
        finish({
          requestId,
          content:
            'In Chat mode the assistant cannot use file or shell tools. If you need those, switch to Agent with the Chat/Agent control at the top of the chat, or in Settings under Theme → Session mode—then use Open Workspace to mount a folder if you need the project, and try again.',
          usage: fallbackUsage
        });
        return;
      }

      const talkContent = contentToString(assistantMessage.content);
      const talkNorm = normalizeAssistantContent(talkContent);
      if (!talkNorm) {
        finish({ requestId, content: 'The model returned an empty reply. Try your message again.', usage: fallbackUsage });
        return;
      }

      const reasoning = extractModelReasoning(assistantMessage);
      finish({ requestId, content: talkNorm, reasoning, usage: fallbackUsage });
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
              usage?: { prompt_tokens?: number | null; completion_tokens?: number | null; total_tokens?: number | null } | null;
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
        usage: result.usage
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
      usage: result.usage
    } satisfies ChatStreamDone);
    this.activeRequests.delete(requestId);
  }

  private async runImageGeneration(
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
      window.webContents.send('chat:done', {
        requestId,
        content: text
          ? `The model returned text instead of an image file:\n\n${text}`
          : 'The model did not return an image file. Try again or choose another image model.',
        usage: mapCompletionUsage(completion.usage ?? undefined)
      } satisfies ChatStreamDone);
      this.activeRequests.delete(requestId);
      return;
    }

    window.webContents.send('chat:done', {
      requestId,
      content: attachments.length === 1 ? 'Generated image.' : `Generated ${attachments.length} images.`,
      attachments,
      usage: mapCompletionUsage(completion.usage ?? undefined)
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
          'Return the full system prompt text and preset metadata for the **currently selected** LLM provider in Settings (read-only, never writes). Use when the user asks what instructions you were given, what the system prompt says, or to quote the developer prompt. Available in Agent mode even if “AI can change system prompt” is disabled in Tool access. Long prompts may be truncated in the tool result.',
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
          'Return this Wizard’s stored **private** system prompt (read-only)—the text edited in the Wizard profile, not Mythra’s hidden routing layers. Call before `set_wizard_system_prompt` whenever you need the exact current text for a precise edit. This is distinct from `get_system_prompt`, which reads the global LLM provider preset in Settings. Long prompts may be truncated.',
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

  private buildToolDefinitions(settings: AppSettings, runtime: ChatRuntimeContext): ChatCompletionTool[] {
    const tools: ChatCompletionTool[] = [];
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

    // Only set_system_prompt is gated; get_system_prompt above is always offered in Agent mode.
    if (settings.tools.allowModelSystemPrompt) {
      tools.push({
        type: 'function',
        function: {
          name: 'set_system_prompt',
          description:
            'Replace the entire system prompt for the **currently selected** LLM provider in Settings. Use only when the user clearly wants their assistant instructions updated. Saves immediately; applies on the next user message. Disabled unless the user turns on “AI can change system prompt” in Settings → Tool access.',
          parameters: {
            type: 'object',
            properties: {
              system_prompt: {
                type: 'string',
                description: 'Full new system prompt text (replaces the previous one for this provider).'
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
      tools.push({
        type: 'function',
        function: {
          name: 'set_wizard_system_prompt',
          description:
            'Replace this Wizard’s private system prompt only—not the global LLM provider preset in Settings. Use when the user clearly asks to change this Wizard’s own long-term instructions. Mythra shows a before/after approval dialog automatically. Independent of Settings → Tool access → “AI can change system prompt” (that toggle applies only to `set_system_prompt`, which is not offered in Wizard chats). Never paste Mythra Agent routing text from this chat into system_prompt—only persona/editor-style instructions.',
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
            'Change this Wizard’s **display name** in Mythra (sidebar list, chat subtitle, Inspector Wizard settings header). Does not edit soul.md or the stored system prompt—after renaming here, update soul.md (identity heading/text) and use `set_wizard_system_prompt` if your instructions still mention the old name so everything stays consistent.',
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
      ? 'Read UTF-8 text; paths may be workspace-relative, ../ to reach sibling folders, or absolute local paths.'
      : wizardOutsideOff
        ? 'Read UTF-8 text using a path relative to this Wizard workspace only. If the user needs another Wizard’s folder or arbitrary paths, tell them to enable **Allow paths outside workspace** in Wizard settings (Inspector).'
        : 'Read a UTF-8 text file using a path relative to the current workspace root.';

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
              }
            },
            required: ['path'],
            additionalProperties: false
          }
        }
      });
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
        ? 'Chat mode: the `web_search` tool is available for public web lookup while "Web" is enabled in the chat header. You have no read/write for local files, workspace listing, or shell—even if a folder shows in the UI (ignore it for local work).'
        : 'Chat mode: you have no tools until the user turns on "Web" in the chat header (then only `web_search` is available). You cannot read/write local files, search the workspace, or run shell commands.';

      return (
        this.threadPreamble(runtime) +
        [
          '[Mythra model routing — Chat mode. This is a second system message; it is not shown in the user’s chat transcript. Do not tell the user about "hidden" or internal prompts; describe behavior in plain terms. If they need Agent (files, shell, workspace tools), tell them they can switch using the Chat/Agent control at the top of the chat window, or Session mode under Theme in Settings—either place works.]',
          mythraRuntimeVersionLine(),
          sessionModeUiStateLine(settings.ui.sessionMode),
          toolLine,
          webHeaderUiStateLine(settings.ui.webSearch),
          ...(settings.ui.webSearch ? [mythraWebSearchToolRoutingHint] : []),
          'For editing files, running commands, or searching the open project, they must be in Agent mode (same two places: top of chat, or Settings → Theme → Session mode). If the user needs that, say so in plain language.',
          mythraProductFeaturesInstruction,
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
        'If they only want casual chat without tools, they can switch to Chat mode with the Chat/Agent control at the top of the chat, or Session mode under Theme in Settings.',
        mythraSessionModeEmbedInstruction,
        mythraWebSearchEmbedInstruction,
        mythraSetAppThemeAgentInstruction,
        mythraToolAccessReadInstruction,
        mythraProductFeaturesInstruction,
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
      settings.ui.webSearch ? 'web_search' : null,
      settings.tools.workspaceSearch ? 'list_files' : null,
      settings.tools.workspaceSearch ? 'search_symbols, get_file_outline' : null,
      settings.tools.fileRead ? 'read_file' : null,
      settings.tools.fileWrite ? 'apply_patch, replace_in_file, insert_after, rename_file, write_file, delete_path' : null,
      settings.tools.commandDeck ? 'get_git_diff, run_tests, run_command' : null,
      settings.tools.allowModelSystemPrompt ? 'set_system_prompt' : null,
      runtime.wizardId ? 'get_wizard_system_prompt, set_wizard_system_prompt, set_wizard_display_name' : null
    ]
      .filter(Boolean)
      .join(', ');

    return [
      '[Mythra model routing — Agent mode. The user does not see this system message. Do not tell the user about “internal” or “hidden” prompts.]',
      mythraRuntimeVersionLine(),
      sessionModeUiStateLine(settings.ui.sessionMode),
      'Converse like a normal assistant: friendly, direct, and human. Do not act like a project manager or ask for a “task”, “autonomous objective”, or “objective in todo” unless the user is clearly scoping a multi-step build.',
      'Agent mode only means: when the user wants something that requires the repo, files, or the shell, you *may* use the tools below. For greetings, chit-chat, and general Q&A, answer normally and use zero tools unless reading a file is genuinely required to help.',
      'If the user wants to use only Chat mode (no file/shell tools), they can switch with the Chat/Agent control at the top of the chat or under Theme → Session mode in Settings.',
      mythraSessionModeEmbedInstruction,
      mythraWebSearchEmbedInstruction,
      webHeaderUiStateLine(settings.ui.webSearch),
      mythraSetAppThemeAgentInstruction,
      mythraToolAccessReadInstruction,
      mythraProductFeaturesInstruction,
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
    args: Record<string, unknown>
  ) {
    const workspaceRoot = runtime.workspaceRoot;

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
          'set_app_theme is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again.'
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
          'merge_custom_theme_tokens is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again.'
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
          'set_custom_theme is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again.'
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
          'get_app_theme is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again.'
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
          'get_tool_access is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again.'
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
          'get_wizard_system_prompt is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again.'
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
          'get_system_prompt is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again.'
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
          provider: kind,
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
          'revert_app_theme is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again.'
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
          'set_system_prompt is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again.'
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
        return {
          ...base,
          providers: {
            ...base.providers,
            [providerKind]: {
              ...p,
              systemPrompt: system_prompt,
              activePromptPresetId: null
            }
          }
        };
      });
      Object.assign(settings, saved);
      return JSON.stringify(
        {
          ok: true,
          provider: providerKind,
          length: system_prompt.length,
          message: 'System prompt saved for the active provider. It applies on the next message.'
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
          `set_wizard_system_prompt contained pasted Mythra routing text (${leaked}). Put only this Wizard’s authored instructions—use read_file on soul.md or workspace docs for facts, then edit minimally. Remove any blocks matching hidden Agent routing (e.g. lines beginning with “[Mythra model routing” or “[Mythra] Thread id”).`
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
          'set_wizard_display_name is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again.'
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
            'Wizard display name saved for the sidebar and Wizard settings. Mythra renames the workspace folder when needed so it matches your name. Update soul.md and call set_wizard_system_prompt if needed so your identity text matches.'
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

        const file = await this.workspaceService.openFile(workspaceRoot, path, wizardAllowOutside);
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
        {
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
        },
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
        throw new Error('Nexus leader denied this tool action.');
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

import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import OpenAI from 'openai';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions/completions';
import { dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type {
  AppSettings,
  ChatActivity,
  ChatCompletionTokenUsage,
  ChatMessage,
  ChatStreamDone,
  ChatStreamError,
  ModelInfo,
  ProviderKind,
  SessionMode
} from '@shared/types';
import { OPENKIWI_SESSION_MODE_TOGGLE, OPENKIWI_WEB_SEARCH_TOGGLE } from '@shared/openkiwi-embeds';

function mapCompletionUsage(
  u: { prompt_tokens?: number | null; completion_tokens?: number | null; total_tokens?: number | null } | null | undefined
): ChatCompletionTokenUsage | undefined {
  if (!u) return undefined;
  const pt = u.prompt_tokens ?? 0;
  const ct = u.completion_tokens ?? 0;
  const tt = u.total_tokens ?? pt + ct;
  return { promptTokens: pt, completionTokens: ct, totalTokens: tt };
}
import {
  isPresetThemeId,
  isThemeId,
  MERGE_THEME_PALETTE_IDS,
  PRESET_THEME_IDS,
  SEMANTIC_CUSTOM_THEME_MODE_IDS,
  SEMANTIC_CUSTOM_THEME_PALETTE_IDS
} from '@shared/themes';
import { CommandService } from './command-service';
import { searchWeb } from './web-search';
import { WorkspaceService } from './workspace-service';

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
          'X-OpenRouter-Title': provider.appName || 'OpenKiwi'
        }
      : undefined;

  return new OpenAI({
    baseURL: normalizeBaseUrl(kind, provider.baseUrl),
    apiKey: provider.apiKey || 'lm-studio',
    defaultHeaders: headers,
    dangerouslyAllowBrowser: false
  });
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

/** Shown in the second system block so models can emit a placeholder replaced by a real UI control in the client. */
const openkiwiSessionModeEmbedInstruction = `OpenKiwi inline control: you may place this exact token alone on its own line in your reply. The app will replace it with a real Chat/Agent switch. Do not change characters, add spaces inside the token, or put other text on the same line. Use only when the user needs to change session mode. If this prompt already includes "UI session mode: Agent", do not ask them to switch to Agent and do not include this token. Token: ${OPENKIWI_SESSION_MODE_TOGGLE}`;

const openkiwiWebSearchEmbedInstruction = `OpenKiwi inline Web toggle token ${OPENKIWI_WEB_SEARCH_TOGGLE}: use ONLY when the chat header "Web" switch is OFF and you want an in-message control so the user can turn web_search on. When "Web" is already ON (see the UI state line in this prompt), do NOT include this token—it would duplicate the header and must not appear. If Web is on, use web_search directly for lookups. Do not change characters or spacing inside the token.`;

/** Lets the model know whether emitting the web embed token is appropriate. */
const webHeaderUiStateLine = (webOn: boolean) =>
  webOn
    ? `UI: Chat header "Web" is ON; web_search is available. Do not put ${OPENKIWI_WEB_SEARCH_TOGGLE} in your message.`
    : `UI: Chat header "Web" is OFF; web_search is disabled until the user enables "Web". You may use ${OPENKIWI_WEB_SEARCH_TOGGLE} on its own line to show an inline switch, or tell them to use the header toggle.`;

const sessionModeUiStateLine = (mode: SessionMode) =>
  mode === 'agent'
    ? 'UI session mode: Agent (authoritative for this request). Files, shell, workspace, and theme tools may be used when listed below. Do not tell the user to switch to Agent mode or say they must enable Agent—the UI line above the chat already reflects their choice.'
    : 'UI session mode: Chat. You cannot use workspace files, shell, or theme-change tools; invite the user to switch with the Chat/Agent control only if they need those features.';

/** Shown when web_search is enabled; DuckDuckGo instant answers are not full search pages. */
const openkiwiWebSearchToolRoutingHint = `web_search: OpenKiwi uses DuckDuckGo’s instant-answer endpoint—you receive short blurbs, definitions, and sometimes a few web links, not full article text. For weather, include a resolvable place (city/region) in the query; when DuckDuckGo has no answer, a built-in Open-Meteo fallback may return approximate current conditions for that place (not GPS/“here”). Write tight, distinctive queries: key nouns, exact product or library names, error strings in quotes, or a year for time-sensitive items. If the result is empty or off-topic, call web_search again with different wording before giving up. If still nothing, say that honestly; do not invent URLs or facts the tool did not return.`;

const openkiwiThemeInChatModeInstruction = `App theme: In Chat mode you cannot read or change the theme (no get_app_theme, set_custom_theme, set_app_theme, revert_app_theme, merge_custom_theme_tokens). If the user asks what theme is active, to change the theme, palette, or to revert a theme, say they need Agent mode first, and include the session-mode line so they get an inline switch: ${OPENKIWI_SESSION_MODE_TOGGLE}`;

const openkiwiSetAppThemeAgentInstruction =
  `App theme (Agent only): for whole-theme requests like "make it pink", "custom purple", or "dark blue", call set_custom_theme with palette/mode. For targeted requests like "make the sidebar pink", "make user messages blue", or "make the editor black", call merge_custom_theme_tokens once with a slots object and exact colors; do not inspect files or guess CSS. set_app_theme only applies fixed preset tiles (${PRESET_THEME_IDS.join(', ')}). revert_app_theme undoes the last change. After a successful theme change, reply in one short sentence and do not describe colors that differ from the tool result.`;

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
    private readonly setCustomTheme?: (incoming: Record<string, unknown>) => Promise<string>
  ) {}

  async listModels(settings: AppSettings, providerKind?: ProviderKind): Promise<ModelInfo[]> {
    const kind = providerKind ?? settings.selectedProvider;
    const client = createClient(settings, kind);
    const response = await client.models.list();

    return (response.data ?? []).map((entry) => ({
      id: String(entry.id ?? ''),
      contextLength:
        typeof (entry as { context_length?: unknown }).context_length === 'number'
          ? ((entry as { context_length?: number }).context_length ?? undefined)
          : undefined,
      ownedBy: typeof entry.owned_by === 'string' ? entry.owned_by : undefined
    }));
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

      const apiMessages: ChatCompletionMessageParam[] = [
        { role: 'system', content: provider.systemPrompt },
        { role: 'system', content: sessionContext },
        ...messages.map((message) => toApiMessage(message))
      ];

      const toolDefinitions = this.buildToolDefinitions(settings, runtime.workspaceRoot);

      if (isTalk && toolDefinitions.length === 0) {
        await this.runTalkStream(client, window, requestId, provider.model, apiMessages, controller);
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
            signal: controller.signal
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

            this.emitActivity(
              window,
              requestId,
              toolCall.function.name === 'run_command' ? 'command' : 'tool',
              `Requested ${toolCall.function.name}${toolCall.function.arguments ? ` with ${truncate(toolCall.function.arguments, 180)}` : ''}.`
            );

            const toolResult = await this.executeToolCall(window, requestId, settings, runtime.workspaceRoot, toolCall);
            this.assertNotStopped(requestId);

            apiMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: truncate(toolResult, 18_000)
            });

            this.emitActivity(window, requestId, 'success', `${toolCall.function.name} completed.`);
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
      const stream = await client.chat.completions.create(
        { model, messages: apiMessages, stream: true, stream_options: { include_usage: true } },
        { signal: controller.signal }
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

      const completion = await client.chat.completions.create({ model, messages: apiMessages }, { signal: controller.signal });
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
          `Change the OpenKiwi preset theme (fixed appearances in Settings tiles). Allowed ids: ${PRESET_THEME_IDS.join(', ')}. ` +
          'Use set_custom_theme for custom color requests such as pink, dark blue, icy dark, purple, white, or orange.',
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
          'Return the currently applied OpenKiwi theme (id and display name) and, if available, the previous theme before the last change ' +
          '(so you can answer what theme is active or whether the user can revert). Agent mode only.',
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
          'You may also merge exact whitelisted CSS variables such as --accent, --bg-0, or --text-0. For whole-theme requests like pink/purple/dark blue/white/orange/kiwi, use set_custom_theme first.',
        parameters: {
          type: 'object',
          properties: {
            palette: {
              type: 'string',
              enum: [...MERGE_THEME_PALETTE_IDS, ...SEMANTIC_CUSTOM_THEME_PALETTE_IDS],
              description:
                'Fallback palette if tokens/slots are missing. Semantic palettes like pink/purple/blue are accepted so they never fall back to Kiwi accidentally; for full-theme changes prefer set_custom_theme.'
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
          'Preferred tool for custom theme requests. Sets a complete Custom theme from simple semantic choices, replacing old custom colors so leftover green/blue tokens do not remain. Use this for "completely pink", "dark purple", "light blue", "make it orange", "icy dark", "white theme", etc. Use merge_custom_theme_tokens only for advanced exact CSS-variable tweaks.',
        parameters: {
          type: 'object',
          properties: {
            palette: {
              type: 'string',
              enum: [...SEMANTIC_CUSTOM_THEME_PALETTE_IDS],
              description:
                'Main color family. For “pink”, “rose”, “magenta”, or “hot pink”, choose pink. For neutral gray choose slate; for white/paper choose white.'
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

  private buildToolDefinitions(settings: AppSettings, workspaceRoot?: string): ChatCompletionTool[] {
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
    tools.push(this.buildRevertAppThemeTool());

    if (!workspaceRoot) {
      return tools;
    }

    if (settings.tools.workspaceSearch) {
      tools.push({
        type: 'function',
        function: {
          name: 'list_files',
          description: 'List the files and directories inside the current workspace.',
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
          description: 'Read a UTF-8 text file from the current workspace using a relative path.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Relative path to the file inside the current workspace.'
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
            name: 'write_file',
            description:
              'Create or overwrite a UTF-8 text file inside the current workspace. Creates parent folders when needed.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Relative path to the file inside the current workspace.'
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
            name: 'delete_path',
            description: 'Delete a file or folder inside the current workspace.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Relative path to the file or folder inside the current workspace.'
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
      tools.push({
        type: 'function',
        function: {
          name: 'run_command',
          description:
            'Run a shell command inside the current workspace and return stdout, stderr, and exit status. Use this for git, build, test, and search commands.',
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
      });
    }

    return tools;
  }

  private threadPreamble(runtime: ChatRuntimeContext): string {
    const id = runtime.conversationId?.trim();
    if (!id) return '';
    return [
      `[OpenKiwi] Thread id: ${id}. The messages in this request are the only history you see for this turn—other saved chats in the app are not included.`,
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
          '[OpenKiwi model routing — Chat mode. This is a second system message; it is not shown in the user’s chat transcript. Do not tell the user about "hidden" or internal prompts; describe behavior in plain terms. If they need Agent (files, shell, workspace tools), tell them they can switch using the Chat/Agent control at the top of the chat window, or Session mode under Theme in Settings—either place works.]',
          sessionModeUiStateLine(settings.ui.sessionMode),
          toolLine,
          webHeaderUiStateLine(settings.ui.webSearch),
          ...(settings.ui.webSearch ? [openkiwiWebSearchToolRoutingHint] : []),
          'For editing files, running commands, or searching the open project, they must be in Agent mode (same two places: top of chat, or Settings → Theme → Session mode). If the user needs that, say so in plain language.',
          openkiwiSessionModeEmbedInstruction,
          openkiwiWebSearchEmbedInstruction,
          openkiwiThemeInChatModeInstruction,
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
        '[OpenKiwi model routing — Agent mode, no workspace. This system message is not in the user’s visible transcript. Do not tell the user about internal prompts.]',
        sessionModeUiStateLine(settings.ui.sessionMode),
        'No workspace folder is open. You cannot use file or shell tools on disk until the user opens one from the sidebar. You can still answer generally.',
        'If they only want casual chat without tools, they can switch to Chat mode with the Chat/Agent control at the top of the chat, or Session mode under Theme in Settings.',
        openkiwiSessionModeEmbedInstruction,
        openkiwiWebSearchEmbedInstruction,
        openkiwiSetAppThemeAgentInstruction,
        webLine,
        webHeaderUiStateLine(settings.ui.webSearch),
        ...(settings.ui.webSearch ? [openkiwiWebSearchToolRoutingHint] : [])
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
      'revert_app_theme',
      settings.ui.webSearch ? 'web_search' : null,
      settings.tools.workspaceSearch ? 'list_files' : null,
      settings.tools.fileRead ? 'read_file' : null,
      settings.tools.fileWrite ? 'write_file, delete_path' : null,
      settings.tools.commandDeck ? 'run_command' : null
    ]
      .filter(Boolean)
      .join(', ');

    return [
      '[OpenKiwi model routing — Agent mode. The user does not see this system message. Do not tell the user about “internal” or “hidden” prompts.]',
      sessionModeUiStateLine(settings.ui.sessionMode),
      'Converse like a normal assistant: friendly, direct, and human. Do not act like a project manager or ask for a “task”, “autonomous objective”, or “objective in todo” unless the user is clearly scoping a multi-step build.',
      'Agent mode only means: when the user wants something that requires the repo, files, or the shell, you *may* use the tools below. For greetings, chit-chat, and general Q&A, answer normally and use zero tools unless reading a file is genuinely required to help.',
      'If the user wants to use only Chat mode (no file/shell tools), they can switch with the Chat/Agent control at the top of the chat or under Theme → Session mode in Settings.',
      openkiwiSessionModeEmbedInstruction,
      openkiwiWebSearchEmbedInstruction,
      webHeaderUiStateLine(settings.ui.webSearch),
      openkiwiSetAppThemeAgentInstruction,
      `Workspace root: ${runtime.workspaceRoot}`,
      `Active file: ${runtime.activeFilePath ? relative(runtime.workspaceRoot, runtime.activeFilePath) : 'none'}`,
      `Enabled tools: ${enabledTools || 'none'}`,
      `Approval: ${settings.agent.fullAccess ? 'writes/commands run without per-action approval' : 'user approval may be required for some writes, deletes, and commands'}.`,
      `In one user message you may get several model turns: use tools when needed, then reply in plain language. Step cap per message: about ${settings.agent.maxAutoSteps} tool rounds.`,
      'If the user asks what you can do, say you can both chat and (when it helps) use the listed tools on the open workspace—without sounding like you will always run a task.',
      ...(settings.ui.webSearch ? [openkiwiWebSearchToolRoutingHint] : []),
      'Visible workspace entries (truncated):',
      visibleFiles || '[workspace appears empty]'
    ].join('\n');
  }

  private async executeToolCall(
    window: BrowserWindow,
    requestId: string,
    settings: AppSettings,
    workspaceRoot: string | undefined,
    toolCall: ChatCompletionMessageFunctionToolCall
  ) {
    let args: Record<string, unknown>;
    try {
      args = toolCall.function.arguments ? (JSON.parse(toolCall.function.arguments) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`Tool ${toolCall.function.name} received invalid JSON arguments.`);
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

    if (!workspaceRoot) {
      throw new Error(`Tool ${toolCall.function.name} was requested, but no workspace is attached.`);
    }

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

        const file = await this.workspaceService.openFile(workspaceRoot, path);
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

        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          'Approve file write',
          `The model wants to write:\n${path}\n\nThis will create or overwrite the file inside the current workspace.`
        );

        const file = await this.workspaceService.saveFile(workspaceRoot, path, content);
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
          'Approve delete',
          `The model wants to delete:\n${path}\n\nThis cannot be undone from the app.`
        );

        const deleted = await this.workspaceService.deletePath(workspaceRoot, path);
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
          'Approve command execution',
          `The model wants to run:\n${path}\n\nThe command will execute inside:\n${workspaceRoot}`
        );

        const signal = this.activeRequests.get(requestId)?.controller.signal;
        const result = await this.commandService.runAndCapture(path, workspaceRoot, 20_000, signal);
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

  private async requestApprovalIfNeeded(
    window: BrowserWindow,
    requestId: string,
    windowSettings: AppSettings,
    title: string,
    detail: string
  ) {
    if (windowSettings.agent.fullAccess) {
      return;
    }

    this.emitActivity(window, requestId, 'approval', `${title}: waiting for user approval.`);
    await this.requestApproval(window, title, detail);
  }

  private async requestApproval(window: BrowserWindow, title: string, detail: string) {
    const result = await dialog.showMessageBox(window, {
      type: 'question',
      buttons: ['Approve', 'Deny'],
      defaultId: 0,
      cancelId: 1,
      title,
      message: title,
      detail,
      noLink: true
    });

    if (result.response !== 0) {
      throw new Error(`${title} was denied by the user.`);
    }
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

import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import OpenAI from 'openai';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions/completions';
import { dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type {
  AppSettings,
  ChatActivity,
  ChatMessage,
  ChatStreamDone,
  ChatStreamError,
  ModelInfo,
  ProviderKind
} from '@shared/types';
import { CommandService } from './command-service';
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
          'X-OpenRouter-Title': provider.appName || 'Pixel Forge'
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
const startsWithMarker = (content: string, marker: string) => new RegExp(`^\\s*${marker}\\b`, 'i').test(content);

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
}

interface ActiveRequest {
  controller: AbortController;
  stopped: boolean;
}

export class ModelService {
  private readonly activeRequests = new Map<string, ActiveRequest>();

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly commandService: CommandService
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

      if (isTalk) {
        await this.runTalkStream(client, window, requestId, provider.model, apiMessages, controller);
        return;
      }

      const maxAutoSteps = Math.max(4, settings.agent.maxAutoSteps || 24);
      const toolDefinitions = this.buildToolDefinitions(settings, runtime.workspaceRoot);

      for (let step = 0; step < maxAutoSteps; step += 1) {
        this.assertNotStopped(requestId);

        const completion = await client.chat.completions.create(
          {
            model: provider.model,
            messages: apiMessages,
            tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
            tool_choice: toolDefinitions.length > 0 ? 'auto' : undefined
          },
          {
            signal: controller.signal
          }
        );

        this.assertNotStopped(requestId);
        const assistantMessage = completion.choices[0]?.message;
        if (!assistantMessage) {
          throw new Error('The model returned no message.');
        }

        if (assistantMessage.tool_calls?.length) {
          apiMessages.push({
            role: 'assistant',
            content: assistantMessage.content ?? null,
            tool_calls: assistantMessage.tool_calls
          });

          for (const toolCall of assistantMessage.tool_calls) {
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

        const content = contentToString(assistantMessage.content);
        const normalizedContent = normalizeAssistantContent(content);

        if (!normalizedContent) {
          apiMessages.push({
            role: 'assistant',
            content: assistantMessage.content ?? ''
          });
          apiMessages.push({
            role: 'user',
            content:
              `Your last response was blank to the user. Respond with a visible user-facing update.\n` +
              `Summarize what you did and what happens next.\n` +
              `If complete, begin with ${COMPLETION_MARKER}. If blocked, begin with ${INPUT_MARKER}.`
          });
          this.emitActivity(window, requestId, 'warning', 'The model returned a blank message. Requesting a visible summary.');
          continue;
        }

        lastVisibleAssistantContent = normalizedContent;

        if (!settings.agent.autoContinue || startsWithMarker(content, COMPLETION_MARKER) || startsWithMarker(content, INPUT_MARKER)) {
          if (startsWithMarker(content, INPUT_MARKER)) {
            this.emitActivity(window, requestId, 'warning', 'Model needs user input.');
          }
          const done: ChatStreamDone = {
            requestId,
            content: normalizedContent,
            reasoning: extractModelReasoning(assistantMessage)
          };
          window.webContents.send('chat:done', done);
          this.activeRequests.delete(requestId);
          return;
        }

        apiMessages.push({
          role: 'assistant',
          content: assistantMessage.content ?? normalizedContent
        });
        apiMessages.push({
          role: 'user',
          content:
            `Continue working autonomously.\n` +
            `Only stop when the task is complete or you truly need user input.\n` +
            `When complete, begin your response with ${COMPLETION_MARKER}.\n` +
            `If blocked and you need the user, begin your response with ${INPUT_MARKER}.`
        });

      }

      this.emitActivity(
        window,
        requestId,
        'warning',
        `Autonomous step limit reached after ${maxAutoSteps} steps. Returning the latest visible progress instead of hard failing.`
      );
      const done: ChatStreamDone = {
        requestId,
        content:
          lastVisibleAssistantContent ||
          `I made progress, but I hit the autonomous step limit after ${maxAutoSteps} steps before producing a final stopping message. Ask me to continue and I can keep going from here.`
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
        { model, messages: apiMessages, stream: true },
        { signal: controller.signal }
      );

      let assembled = '';
      let assembledReasoning = '';
      let sawTool = false;

      for await (const chunk of stream) {
        this.assertNotStopped(requestId);
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
            'In Talk mode the assistant cannot use file or shell tools. If you need those, switch the session to Agent, use Open Workspace to mount a folder, and try again.'
        });
        return;
      }

      const talkNorm = normalizeAssistantContent(assembled);
      if (!talkNorm) {
        finish({ requestId, content: 'The model returned an empty reply. Try your message again.' });
        return;
      }

      const reasoning = assembledReasoning.trim() || undefined;
      finish({ requestId, content: talkNorm, reasoning });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }

      const completion = await client.chat.completions.create({ model, messages: apiMessages }, { signal: controller.signal });
      this.assertNotStopped(requestId);
      const assistantMessage = completion.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error('The model returned no message.');
      }

      if (assistantMessage.tool_calls?.length) {
        finish({
          requestId,
          content:
            'In Talk mode the assistant cannot use file or shell tools. If you need those, switch the session to Agent, use Open Workspace to mount a folder, and try again.'
        });
        return;
      }

      const talkContent = contentToString(assistantMessage.content);
      const talkNorm = normalizeAssistantContent(talkContent);
      if (!talkNorm) {
        finish({ requestId, content: 'The model returned an empty reply. Try your message again.' });
        return;
      }

      const reasoning = extractModelReasoning(assistantMessage);
      finish({ requestId, content: talkNorm, reasoning });
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

  private buildToolDefinitions(settings: AppSettings, workspaceRoot?: string): ChatCompletionTool[] {
    if (settings.ui.sessionMode === 'talk') {
      return [];
    }

    if (!workspaceRoot) {
      return [];
    }

    const tools: ChatCompletionTool[] = [];

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

  private async buildSessionContext(settings: AppSettings, runtime: ChatRuntimeContext) {
    if (settings.ui.sessionMode === 'talk') {
      return [
        'You are in Talk mode: a normal back-and-forth chat.',
        'No file, workspace, or shell tools are available in this session, even if a folder is open in the app UI (ignore it for this chat).',
        'Reply naturally. Do not begin your message with TASK_COMPLETE or NEEDS_INPUT.',
        'If the system preset above describes coding agents or workspace mounting, treat this as casual conversation unless the user clearly asks for hands-on help with a repo (they should use Agent mode for that).'
      ].join('\n');
    }

    return this.buildWorkspaceContext(settings, runtime);
  }

  private async buildWorkspaceContext(settings: AppSettings, runtime: ChatRuntimeContext) {
    if (!runtime.workspaceRoot) {
      return 'No workspace is currently attached. You cannot inspect or modify files until the user opens a workspace.';
    }

    const files = await this.workspaceService.listFiles(runtime.workspaceRoot);
    const visibleFiles = files
      .slice(0, 140)
      .map((entry) => `${entry.type === 'directory' ? '[dir]' : '[file]'} ${entry.path}`)
      .join('\n');

    const enabledTools = [
      settings.tools.workspaceSearch ? 'list_files' : null,
      settings.tools.fileRead ? 'read_file' : null,
      settings.tools.fileWrite ? 'write_file, delete_path' : null,
      settings.tools.commandDeck ? 'run_command' : null
    ]
      .filter(Boolean)
      .join(', ');

    return [
      `Workspace root: ${runtime.workspaceRoot}`,
      `Active file: ${runtime.activeFilePath ? relative(runtime.workspaceRoot, runtime.activeFilePath) : 'none'}`,
      `Enabled tools: ${enabledTools || 'none'}`,
      `Approval mode: ${settings.agent.fullAccess ? 'full access enabled; no per-action approvals' : 'approval required for writes, deletes, and commands'}`,
      `Continuation mode: ${settings.agent.autoContinue ? 'continue autonomously until done or blocked' : 'single response mode'}`,
      `Autonomous step budget: ${settings.agent.maxAutoSteps}`,
      'You do have access to the workspace through tools. If the user asks whether you can inspect files or run commands, answer yes and use the tools instead of claiming no access.',
      `When the task is complete, begin your final response with ${COMPLETION_MARKER}.`,
      `When you need user input, begin your final response with ${INPUT_MARKER}.`,
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
    if (!workspaceRoot) {
      throw new Error(`Tool ${toolCall.function.name} was requested, but no workspace is attached.`);
    }

    let args: Record<string, unknown>;
    try {
      args = toolCall.function.arguments ? (JSON.parse(toolCall.function.arguments) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`Tool ${toolCall.function.name} received invalid JSON arguments.`);
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
        window.webContents.send('workspace:changed', { root: workspaceRoot });
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
        window.webContents.send('workspace:changed', { root: workspaceRoot });
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

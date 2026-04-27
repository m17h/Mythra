import { fileURLToPath } from "node:url";
import { join as join$1, relative, dirname, basename, resolve, sep } from "node:path";
import { app, dialog, BrowserWindow, ipcMain, nativeImage } from "electron";
import { join } from "path";
import { existsSync } from "node:fs";
import { readdir, mkdir, copyFile, readFile, writeFile, unlink, stat, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const appIconPath = join(__dirname, "./chunks/openkiwi_icon-DIx-U6xG.png");
const CHATS_DIR = "openkiwi-chats";
const LEGACY_CHATS_DIR = "pixel-forge-chats";
class ChatStore {
  userData = app.getPath("userData");
  dir = join$1(this.userData, CHATS_DIR);
  legacyDir = join$1(this.userData, LEGACY_CHATS_DIR);
  legacyMigrated = false;
  async migrateLegacyChatsIfNeeded() {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    try {
      const newHas = existsSync(this.dir) && (await readdir(this.dir)).some((f) => f.endsWith(".json"));
      if (newHas) return;
      if (!existsSync(this.legacyDir)) return;
      const files = (await readdir(this.legacyDir)).filter((f) => f.endsWith(".json"));
      if (files.length === 0) return;
      await mkdir(this.dir, { recursive: true });
      for (const f of files) {
        const dst = join$1(this.dir, f);
        if (!existsSync(dst)) await copyFile(join$1(this.legacyDir, f), dst);
      }
    } catch {
    }
  }
  async ensureDir() {
    await this.migrateLegacyChatsIfNeeded();
    await mkdir(this.dir, { recursive: true });
  }
  async listChats() {
    await this.ensureDir();
    const files = await readdir(this.dir);
    const metas = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join$1(this.dir, file), "utf8");
        const chat = JSON.parse(raw);
        metas.push({
          id: chat.id,
          title: chat.title,
          titleOverride: chat.titleOverride ?? null,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt
        });
      } catch {
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async loadChat(id) {
    try {
      const raw = await readFile(join$1(this.dir, `${id}.json`), "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  async saveChat(chat) {
    await this.ensureDir();
    await writeFile(join$1(this.dir, `${chat.id}.json`), JSON.stringify(chat), "utf8");
  }
  async deleteChat(id) {
    try {
      await unlink(join$1(this.dir, `${id}.json`));
      return true;
    } catch {
      return false;
    }
  }
}
class CommandService {
  jobs = /* @__PURE__ */ new Map();
  getShell() {
    const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/zsh";
    const args = process.platform === "win32" ? ["-Command"] : ["-lc"];
    return { shell, args };
  }
  run(window, command, cwd) {
    const jobId = randomUUID();
    const { shell, args } = this.getShell();
    const child = spawn(shell, [...args, command], {
      cwd,
      env: process.env
    });
    this.jobs.set(jobId, { process: child });
    window.webContents.send("commands:chunk", {
      jobId,
      stream: "system",
      chunk: `$ ${command}
`
    });
    child.stdout.on("data", (chunk) => {
      window.webContents.send("commands:chunk", {
        jobId,
        stream: "stdout",
        chunk: chunk.toString()
      });
    });
    child.stderr.on("data", (chunk) => {
      window.webContents.send("commands:chunk", {
        jobId,
        stream: "stderr",
        chunk: chunk.toString()
      });
    });
    child.on("close", (code, signal) => {
      this.jobs.delete(jobId);
      const result = { jobId, code, signal };
      window.webContents.send("commands:done", result);
    });
    return { jobId };
  }
  async runAndCapture(command, cwd, timeoutMs = 2e4, abortSignal) {
    const { shell, args } = this.getShell();
    return new Promise((resolve2, reject) => {
      const child = spawn(shell, [...args, command], {
        cwd,
        env: process.env
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve2({
          ...value,
          stdout: value.stdout.slice(0, 12e3),
          stderr: value.stderr.slice(0, 12e3)
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        finish({
          stdout,
          stderr: `${stderr}
[command timed out after ${timeoutMs}ms]`,
          code: null,
          signal: "SIGTERM"
        });
      }, timeoutMs);
      const abortHandler = () => {
        child.kill("SIGTERM");
        finish({
          stdout,
          stderr: `${stderr}
[command stopped by user]`,
          code: null,
          signal: "SIGTERM"
        });
      };
      abortSignal?.addEventListener("abort", abortHandler, { once: true });
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", abortHandler);
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      });
      child.on("close", (code, processSignal) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", abortHandler);
        if (timedOut) {
          return;
        }
        finish({ stdout, stderr, code, signal: processSignal });
      });
    });
  }
  kill(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return false;
    }
    job.process.kill("SIGTERM");
    this.jobs.delete(jobId);
    return true;
  }
}
async function searchWeb(query) {
  const q = query.trim();
  if (!q) {
    return "Error: empty search query.";
  }
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
  let data;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "OpenKiwi/0.1 (https://github.com) desktop assistant" }
    });
    if (!res.ok) {
      return `Web search request failed (HTTP ${res.status}). You can try again or share a direct link.`;
    }
    data = await res.json();
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return `Web search failed: ${m}`;
  }
  const d = data;
  const lines = [];
  if (typeof d.Heading === "string" && d.Heading.trim()) {
    lines.push(`Topic: ${d.Heading.trim()}`);
  }
  if (typeof d.AbstractText === "string" && d.AbstractText.trim()) {
    lines.push(d.AbstractText.trim());
    if (typeof d.AbstractURL === "string" && d.AbstractURL.trim()) {
      lines.push(`Source: ${d.AbstractURL.trim()}`);
    }
  }
  const related = d.RelatedTopics;
  if (Array.isArray(related) && related.length > 0) {
    lines.push("Related:");
    let count = 0;
    for (const item of related) {
      if (count >= 6) break;
      if (item && typeof item === "object" && "Text" in item && typeof item.Text === "string") {
        lines.push(`- ${item.Text}`);
        count += 1;
      }
    }
  }
  if (lines.length === 0) {
    return [
      `DuckDuckGo returned no instant answer for: "${q}"`,
      "The topic may need a more specific query, or you can open a search manually.",
      `Example: https://duckduckgo.com/?q=${encodeURIComponent(q)}`
    ].join("\n");
  }
  return lines.join("\n\n");
}
const normalizeBaseUrl = (kind, baseUrl) => {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (kind !== "lmstudio") {
    return trimmed;
  }
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
};
const createClient = (settings, kind = settings.selectedProvider) => {
  const provider = settings.providers[kind];
  const headers = kind === "openrouter" ? {
    "HTTP-Referer": provider.appUrl || "https://example.local",
    "X-OpenRouter-Title": provider.appName || "OpenKiwi"
  } : void 0;
  return new OpenAI({
    baseURL: normalizeBaseUrl(kind, provider.baseUrl),
    apiKey: provider.apiKey || "lm-studio",
    defaultHeaders: headers,
    dangerouslyAllowBrowser: false
  });
};
const contentToString = (content) => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((part) => "text" in part && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
};
const truncate = (value, maxLength = 24e3) => value.length > maxLength ? `${value.slice(0, maxLength)}
...[truncated]` : value;
const COMPLETION_MARKER = "TASK_COMPLETE";
const INPUT_MARKER = "NEEDS_INPUT";
const normalizeAssistantContent = (content) => content.replace(new RegExp(`^\\s*(?:${COMPLETION_MARKER}|${INPUT_MARKER})\\s*:?\\s*`, "i"), "").trim();
const extractModelReasoning = (message) => {
  if (!message || typeof message !== "object") {
    return;
  }
  const m = message;
  if (typeof m.reasoning === "string" && m.reasoning.trim()) {
    return m.reasoning.trim();
  }
  if (m.reasoning_details != null) {
    if (typeof m.reasoning_details === "string") {
      return m.reasoning_details.trim() || void 0;
    }
    try {
      return JSON.stringify(m.reasoning_details, null, 2);
    } catch {
      return String(m.reasoning_details);
    }
  }
  return;
};
const toApiMessage = (message) => {
  if (message.role === "user" && message.attachments?.length) {
    return {
      role: "user",
      content: [
        ...message.content ? [
          {
            type: "text",
            text: message.content
          }
        ] : [],
        ...message.attachments.map((attachment) => ({
          type: "image_url",
          image_url: {
            url: attachment.dataUrl,
            detail: "auto"
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
class ModelService {
  constructor(workspaceService2, commandService2) {
    this.workspaceService = workspaceService2;
    this.commandService = commandService2;
  }
  workspaceService;
  commandService;
  activeRequests = /* @__PURE__ */ new Map();
  async listModels(settings, providerKind) {
    const kind = providerKind ?? settings.selectedProvider;
    const client = createClient(settings, kind);
    const response = await client.models.list();
    return (response.data ?? []).map((entry) => ({
      id: String(entry.id ?? ""),
      contextLength: typeof entry.context_length === "number" ? entry.context_length ?? void 0 : void 0,
      ownedBy: typeof entry.owned_by === "string" ? entry.owned_by : void 0
    }));
  }
  stopRequest(requestId) {
    const active = this.activeRequests.get(requestId);
    if (!active) {
      return false;
    }
    active.stopped = true;
    active.controller.abort();
    this.activeRequests.delete(requestId);
    return true;
  }
  async streamChat(_event, window, requestId, settings, messages, runtime) {
    const provider = settings.providers[settings.selectedProvider];
    if (!provider.model) {
      throw new Error("Select a model before sending a chat request.");
    }
    const controller = new AbortController();
    this.activeRequests.set(requestId, { controller, stopped: false });
    try {
      const client = createClient(settings);
      const isTalk = settings.ui.sessionMode === "talk";
      const sessionContext = await this.buildSessionContext(settings, runtime);
      let lastVisibleAssistantContent = "";
      const apiMessages = [
        { role: "system", content: provider.systemPrompt },
        { role: "system", content: sessionContext },
        ...messages.map((message) => toApiMessage(message))
      ];
      const toolDefinitions = this.buildToolDefinitions(settings, runtime.workspaceRoot);
      if (isTalk && toolDefinitions.length === 0) {
        await this.runTalkStream(client, window, requestId, provider.model, apiMessages, controller);
        return;
      }
      const maxAutoSteps = Math.max(4, settings.agent.maxAutoSteps || 24);
      for (let step = 0; step < maxAutoSteps; step += 1) {
        this.assertNotStopped(requestId);
        const completion = await client.chat.completions.create(
          {
            model: provider.model,
            messages: apiMessages,
            tools: toolDefinitions.length > 0 ? toolDefinitions : void 0,
            tool_choice: toolDefinitions.length > 0 ? "auto" : void 0
          },
          {
            signal: controller.signal
          }
        );
        this.assertNotStopped(requestId);
        const assistantMessage = completion.choices[0]?.message;
        if (!assistantMessage) {
          throw new Error("The model returned no message.");
        }
        if (assistantMessage.tool_calls?.length) {
          apiMessages.push({
            role: "assistant",
            content: assistantMessage.content ?? null,
            tool_calls: assistantMessage.tool_calls
          });
          for (const toolCall of assistantMessage.tool_calls) {
            if (toolCall.type !== "function") {
              continue;
            }
            this.emitActivity(
              window,
              requestId,
              toolCall.function.name === "run_command" ? "command" : "tool",
              `Requested ${toolCall.function.name}${toolCall.function.arguments ? ` with ${truncate(toolCall.function.arguments, 180)}` : ""}.`
            );
            const toolResult = await this.executeToolCall(window, requestId, settings, runtime.workspaceRoot, toolCall);
            this.assertNotStopped(requestId);
            apiMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: truncate(toolResult, 18e3)
            });
            this.emitActivity(window, requestId, "success", `${toolCall.function.name} completed.`);
          }
          continue;
        }
        const content = contentToString(assistantMessage.content);
        const normalizedContent = normalizeAssistantContent(content);
        if (!normalizedContent) {
          apiMessages.push({
            role: "assistant",
            content: assistantMessage.content ?? ""
          });
          apiMessages.push({
            role: "user",
            content: `Your last assistant message was empty in the user’s chat. Write a short, natural visible reply. If you just used tools, summarize what you found or did in plain language.`
          });
          this.emitActivity(window, requestId, "warning", "The model returned a blank message. Requesting a visible summary.");
          continue;
        }
        lastVisibleAssistantContent = normalizedContent;
        const done2 = {
          requestId,
          content: normalizedContent,
          reasoning: extractModelReasoning(assistantMessage)
        };
        window.webContents.send("chat:done", done2);
        this.activeRequests.delete(requestId);
        return;
      }
      this.emitActivity(
        window,
        requestId,
        "warning",
        `Step limit (${maxAutoSteps} tool rounds) reached. Returning the latest reply instead of failing.`
      );
      const done = {
        requestId,
        content: lastVisibleAssistantContent || `I hit the per-message step limit (${maxAutoSteps} tool rounds) before finishing. Ask me to continue and I can pick up from here.`
      };
      window.webContents.send("chat:done", done);
      this.activeRequests.delete(requestId);
      return;
    } finally {
      this.activeRequests.delete(requestId);
    }
  }
  async runTalkStream(client, window, requestId, model, apiMessages, controller) {
    const finish = (done) => {
      window.webContents.send("chat:done", done);
      this.activeRequests.delete(requestId);
    };
    try {
      const stream = await client.chat.completions.create(
        { model, messages: apiMessages, stream: true },
        { signal: controller.signal }
      );
      let assembled = "";
      let assembledReasoning = "";
      let sawTool = false;
      for await (const chunk of stream) {
        this.assertNotStopped(requestId);
        const ch = chunk.choices[0];
        if (ch?.finish_reason === "tool_calls") {
          sawTool = true;
          break;
        }
        if (!ch?.delta) {
          continue;
        }
        const d = ch.delta;
        if (d.tool_calls) {
          sawTool = true;
        }
        const text = d.content;
        if (typeof text === "string" && text) {
          assembled += text;
          window.webContents.send("chat:delta", { requestId, delta: text });
        }
        const r = d.reasoning;
        if (typeof r === "string" && r) {
          assembledReasoning += r;
          window.webContents.send("chat:delta", { requestId, delta: "", reasoningDelta: r });
        }
      }
      if (sawTool) {
        finish({
          requestId,
          content: "In Talk mode the assistant cannot use file or shell tools. If you need those, switch the session to Agent, use Open Workspace to mount a folder, and try again."
        });
        return;
      }
      const talkNorm = normalizeAssistantContent(assembled);
      if (!talkNorm) {
        finish({ requestId, content: "The model returned an empty reply. Try your message again." });
        return;
      }
      const reasoning = assembledReasoning.trim() || void 0;
      finish({ requestId, content: talkNorm, reasoning });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      const completion = await client.chat.completions.create({ model, messages: apiMessages }, { signal: controller.signal });
      this.assertNotStopped(requestId);
      const assistantMessage = completion.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error("The model returned no message.");
      }
      if (assistantMessage.tool_calls?.length) {
        finish({
          requestId,
          content: "In Talk mode the assistant cannot use file or shell tools. If you need those, switch the session to Agent, use Open Workspace to mount a folder, and try again."
        });
        return;
      }
      const talkContent = contentToString(assistantMessage.content);
      const talkNorm = normalizeAssistantContent(talkContent);
      if (!talkNorm) {
        finish({ requestId, content: "The model returned an empty reply. Try your message again." });
        return;
      }
      const reasoning = extractModelReasoning(assistantMessage);
      finish({ requestId, content: talkNorm, reasoning });
    }
  }
  sendError(window, requestId, error) {
    const message = error instanceof Error && error.name === "AbortError" ? "Request stopped." : error instanceof Error ? error.message : "Unknown model error.";
    const payload = { requestId, error: message };
    window.webContents.send("chat:error", payload);
  }
  buildWebSearchTool() {
    return {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the public web for current or general knowledge (news, documentation, error messages, best practices). Use a focused query. Does not read the user’s workspace; use file tools in Agent mode for local code.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query in plain language, specific enough to get useful results."
            }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    };
  }
  buildToolDefinitions(settings, workspaceRoot) {
    const tools = [];
    if (settings.ui.webSearch) {
      tools.push(this.buildWebSearchTool());
    }
    if (settings.ui.sessionMode === "talk") {
      return tools;
    }
    if (!workspaceRoot) {
      return tools;
    }
    if (settings.tools.workspaceSearch) {
      tools.push({
        type: "function",
        function: {
          name: "list_files",
          description: "List the files and directories inside the current workspace.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false
          }
        }
      });
    }
    if (settings.tools.fileRead) {
      tools.push({
        type: "function",
        function: {
          name: "read_file",
          description: "Read a UTF-8 text file from the current workspace using a relative path.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Relative path to the file inside the current workspace."
              }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      });
    }
    if (settings.tools.fileWrite) {
      tools.push(
        {
          type: "function",
          function: {
            name: "write_file",
            description: "Create or overwrite a UTF-8 text file inside the current workspace. Creates parent folders when needed.",
            parameters: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "Relative path to the file inside the current workspace."
                },
                content: {
                  type: "string",
                  description: "Full file contents to write."
                }
              },
              required: ["path", "content"],
              additionalProperties: false
            }
          }
        },
        {
          type: "function",
          function: {
            name: "delete_path",
            description: "Delete a file or folder inside the current workspace.",
            parameters: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "Relative path to the file or folder inside the current workspace."
                }
              },
              required: ["path"],
              additionalProperties: false
            }
          }
        }
      );
    }
    if (settings.tools.commandDeck) {
      tools.push({
        type: "function",
        function: {
          name: "run_command",
          description: "Run a shell command inside the current workspace and return stdout, stderr, and exit status. Use this for git, build, test, and search commands.",
          parameters: {
            type: "object",
            properties: {
              command: {
                type: "string",
                description: "Shell command to run inside the current workspace."
              }
            },
            required: ["command"],
            additionalProperties: false
          }
        }
      });
    }
    return tools;
  }
  threadPreamble(runtime) {
    const id = runtime.conversationId?.trim();
    if (!id) return "";
    return [
      `[OpenKiwi] Thread id: ${id}. The messages in this request are the only history you see for this turn—other saved chats in the app are not included.`,
      "If the user just started a new chat, this thread is a fresh session; there are no prior turns in this list unless the user (or you in this thread) put them there.",
      ""
    ].join("\n");
  }
  async buildSessionContext(settings, runtime) {
    if (settings.ui.sessionMode === "talk") {
      const toolLine = settings.ui.webSearch ? 'Talk mode: the `web_search` tool is available for public web lookup while "Web" is enabled in the chat header. You have no read/write for local files, workspace listing, or shell—even if a folder shows in the UI (ignore it for local work).' : 'Talk mode: you have no tools until the user turns on "Web" in the chat header (then only `web_search` is available). You cannot read/write local files, search the workspace, or run shell commands.';
      return this.threadPreamble(runtime) + [
        '[OpenKiwi model routing — Talk mode. This is a second system message; it is not shown in the user’s chat transcript. Do not tell the user about "hidden" or internal prompts; describe behavior in plain terms (e.g. "switch Session mode to Agent in Settings" if they need file or shell help).]',
        toolLine,
        "For editing files, running commands, or searching the open project, Agent mode in Settings is required. If the user needs that, say so in plain language.",
        "Reply in normal prose. Do not begin with TASK_COMPLETE or NEEDS_INPUT.",
        "The first system message is the user’s preset; follow it except where this block defines tool and mode behavior."
      ].join("\n");
    }
    return this.threadPreamble(runtime) + await this.buildWorkspaceContext(settings, runtime);
  }
  async buildWorkspaceContext(settings, runtime) {
    if (!runtime.workspaceRoot) {
      const webLine = settings.ui.webSearch ? 'The `web_search` tool is available for public web lookup (the user enabled "Web" in the chat header).' : 'Web search is off unless the user enables "Web" next to the status in the chat header.';
      return [
        "[OpenKiwi model routing — Agent mode, no workspace. This system message is not in the user’s visible transcript. Do not tell the user about internal prompts.]",
        "No workspace folder is open. You cannot use file or shell tools on disk until the user opens one from the sidebar. You can still answer generally.",
        webLine
      ].join("\n");
    }
    const files = await this.workspaceService.listFiles(runtime.workspaceRoot);
    const visibleFiles = files.slice(0, 140).map((entry) => `${entry.type === "directory" ? "[dir]" : "[file]"} ${entry.path}`).join("\n");
    const enabledTools = [
      settings.ui.webSearch ? "web_search" : null,
      settings.tools.workspaceSearch ? "list_files" : null,
      settings.tools.fileRead ? "read_file" : null,
      settings.tools.fileWrite ? "write_file, delete_path" : null,
      settings.tools.commandDeck ? "run_command" : null
    ].filter(Boolean).join(", ");
    return [
      "[OpenKiwi model routing — Agent mode. The user does not see this system message. Do not tell the user about “internal” or “hidden” prompts.]",
      "Converse like a normal assistant: friendly, direct, and human. Do not act like a project manager or ask for a “task”, “autonomous objective”, or “objective in todo” unless the user is clearly scoping a multi-step build.",
      "Agent mode only means: when the user wants something that requires the repo, files, or the shell, you *may* use the tools below. For greetings, chit-chat, and general Q&A, answer normally and use zero tools unless reading a file is genuinely required to help.",
      `Workspace root: ${runtime.workspaceRoot}`,
      `Active file: ${runtime.activeFilePath ? relative(runtime.workspaceRoot, runtime.activeFilePath) : "none"}`,
      `Enabled tools: ${enabledTools || "none"}`,
      `Approval: ${settings.agent.fullAccess ? "writes/commands run without per-action approval" : "user approval may be required for some writes, deletes, and commands"}.`,
      `In one user message you may get several model turns: use tools when needed, then reply in plain language. Step cap per message: about ${settings.agent.maxAutoSteps} tool rounds.`,
      "If the user asks what you can do, say you can both chat and (when it helps) use the listed tools on the open workspace—without sounding like you will always run a task.",
      "Visible workspace entries (truncated):",
      visibleFiles || "[workspace appears empty]"
    ].join("\n");
  }
  async executeToolCall(window, requestId, settings, workspaceRoot, toolCall) {
    let args;
    try {
      args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
    } catch {
      throw new Error(`Tool ${toolCall.function.name} received invalid JSON arguments.`);
    }
    if (toolCall.function.name === "web_search") {
      if (!settings.ui.webSearch) {
        throw new Error("Web search is turned off. Enable the Web toggle in the chat header to search online.");
      }
      const query = String(args.query ?? "").trim();
      if (!query) {
        throw new Error("web_search requires a non-empty query.");
      }
      return await searchWeb(query);
    }
    if (!workspaceRoot) {
      throw new Error(`Tool ${toolCall.function.name} was requested, but no workspace is attached.`);
    }
    switch (toolCall.function.name) {
      case "list_files": {
        if (!settings.tools.workspaceSearch) {
          throw new Error("The list_files tool is disabled in settings.");
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
      case "read_file": {
        if (!settings.tools.fileRead) {
          throw new Error("The read_file tool is disabled in settings.");
        }
        const path = String(args.path ?? "");
        if (!path) {
          throw new Error("read_file requires a path.");
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
      case "write_file": {
        if (!settings.tools.fileWrite) {
          throw new Error("The write_file tool is disabled in settings.");
        }
        const path = String(args.path ?? "");
        const content = String(args.content ?? "");
        if (!path) {
          throw new Error("write_file requires a path.");
        }
        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          "Approve file write",
          `The model wants to write:
${path}

This will create or overwrite the file inside the current workspace.`
        );
        const file = await this.workspaceService.saveFile(workspaceRoot, path, content);
        window.webContents.send("workspace:changed", { root: workspaceRoot, fileWritten: file.path });
        return JSON.stringify(
          {
            ok: true,
            path: relative(workspaceRoot, file.path),
            bytes: Buffer.byteLength(content, "utf8")
          },
          null,
          2
        );
      }
      case "delete_path": {
        if (!settings.tools.fileWrite) {
          throw new Error("The delete_path tool is disabled in settings.");
        }
        const path = String(args.path ?? "");
        if (!path) {
          throw new Error("delete_path requires a path.");
        }
        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          "Approve delete",
          `The model wants to delete:
${path}

This cannot be undone from the app.`
        );
        const deleted = await this.workspaceService.deletePath(workspaceRoot, path);
        window.webContents.send("workspace:changed", { root: workspaceRoot, fileDeleted: deleted.path });
        return JSON.stringify(
          {
            ok: true,
            path: relative(workspaceRoot, deleted.path)
          },
          null,
          2
        );
      }
      case "run_command": {
        if (!settings.tools.commandDeck) {
          throw new Error("The run_command tool is disabled in settings.");
        }
        const path = String(args.command ?? "");
        if (!path) {
          throw new Error("run_command requires a command.");
        }
        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          "Approve command execution",
          `The model wants to run:
${path}

The command will execute inside:
${workspaceRoot}`
        );
        const signal = this.activeRequests.get(requestId)?.controller.signal;
        const result = await this.commandService.runAndCapture(path, workspaceRoot, 2e4, signal);
        return JSON.stringify(result, null, 2);
      }
      default:
        throw new Error(`Unknown tool: ${toolCall.function.name}`);
    }
  }
  async requestApprovalIfNeeded(window, requestId, windowSettings, title, detail) {
    if (windowSettings.agent.fullAccess) {
      return;
    }
    this.emitActivity(window, requestId, "approval", `${title}: waiting for user approval.`);
    await this.requestApproval(window, title, detail);
  }
  async requestApproval(window, title, detail) {
    const result = await dialog.showMessageBox(window, {
      type: "question",
      buttons: ["Approve", "Deny"],
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
  assertNotStopped(requestId) {
    const active = this.activeRequests.get(requestId);
    if (active?.stopped) {
      const error = new Error("Request stopped.");
      error.name = "AbortError";
      throw error;
    }
  }
  emitActivity(window, requestId, kind, message) {
    const payload = {
      id: randomUUID(),
      requestId,
      kind,
      message
    };
    window.webContents.send("chat:activity", payload);
  }
}
const promptPresets = [
  {
    id: "general-coding",
    label: "General Coding",
    description: "Balanced default for coding assistance, refactors, debugging, and local tool use.",
    prompt: `You are a pragmatic coding assistant inside a desktop editor.

Use available tools to inspect the workspace, read files, write files, delete files when explicitly appropriate, and run workspace commands when useful.

Work autonomously when the task is clear. Prefer taking the next useful step over stopping early. Keep going until one of these is true:
1. the task is complete
2. you are blocked by missing information or a risky ambiguity that requires user input
3. a tool operation fails and you need user direction

When you stop because the task is complete, begin your final response with TASK_COMPLETE.
When you stop because you need user input, begin your final response with NEEDS_INPUT.

Be concise, precise, and directly useful.`
  },
  {
    id: "web-design",
    label: "Web Design",
    description: "Strong art direction, polished UI decisions, and decisive frontend implementation.",
    prompt: `You are an expert web product designer and frontend engineer inside a desktop editor.

Your job is to produce interfaces that feel intentional, premium, and visually distinctive. Avoid generic SaaS card grids, weak hierarchy, and filler copy. Prefer strong composition, clean spacing, clear typography, and a small number of memorable visual ideas.

Use available tools to inspect the workspace, read and write files, and run commands as needed. Work autonomously until the task is complete or you truly need input.

For UI work:
- make one dominant idea per section or screen
- keep copy tight and product-oriented
- preserve usability and responsiveness
- favor polished motion over noisy motion
- maintain accessibility, contrast, and strong information hierarchy

When you stop because the task is complete, begin your final response with TASK_COMPLETE.
When you stop because you need user input, begin your final response with NEEDS_INPUT.

Be opinionated, high quality, and implementation-ready.`
  },
  {
    id: "software-engineering",
    label: "Software Engineering",
    description: "Systems-oriented prompt for architecture, correctness, maintainability, and delivery.",
    prompt: `You are a senior software engineer operating inside a desktop coding workspace.

Use available tools to inspect the project, read files, write files, delete files when necessary, and run workspace commands for builds, tests, linting, and debugging.

Work autonomously when the task is clear. Make careful technical decisions with strong defaults:
- prefer correct, maintainable solutions over flashy ones
- preserve existing architecture when reasonable
- validate assumptions against the codebase
- run relevant checks when possible
- explain blockers plainly when you truly need input

Do not stop after partial analysis if you can continue implementing or verifying. Continue until the task is complete or genuinely blocked.

When you stop because the task is complete, begin your final response with TASK_COMPLETE.
When you stop because you need user input, begin your final response with NEEDS_INPUT.

Optimize for correctness, clarity, and momentum.`
  }
];
const getPromptPreset = (id) => promptPresets.find((preset) => preset.id === id) ?? promptPresets[0];
const defaultSettings = {
  selectedProvider: "lmstudio",
  providers: {
    lmstudio: {
      kind: "lmstudio",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "lm-studio",
      model: "",
      promptPresetId: "general-coding",
      systemPrompt: getPromptPreset("general-coding").prompt,
      activeCustomPresetId: null,
      customPromptPresets: [],
      appName: "OpenKiwi",
      appUrl: "https://example.local"
    },
    openrouter: {
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      model: "",
      promptPresetId: "general-coding",
      systemPrompt: getPromptPreset("general-coding").prompt,
      activeCustomPresetId: null,
      customPromptPresets: [],
      appName: "OpenKiwi",
      appUrl: "https://example.local"
    }
  },
  tools: {
    fileRead: true,
    fileWrite: true,
    workspaceSearch: true,
    commandDeck: true
  },
  agent: {
    fullAccess: false,
    autoContinue: true,
    maxAutoSteps: 24
  },
  ui: {
    themeId: "neon-grid",
    sessionMode: "agent",
    webSearch: false,
    favoriteModels: { lmstudio: [], openrouter: [] }
  }
};
const SETTINGS_FILE = "openkiwi-settings.json";
const LEGACY_SETTINGS_FILE = "pixel-forge-settings.json";
const mergeSettings = (saved) => ({
  ...defaultSettings,
  ...saved,
  providers: {
    lmstudio: {
      ...defaultSettings.providers.lmstudio,
      ...saved?.providers?.lmstudio
    },
    openrouter: {
      ...defaultSettings.providers.openrouter,
      ...saved?.providers?.openrouter
    }
  },
  tools: {
    ...defaultSettings.tools,
    ...saved?.tools
  },
  agent: {
    ...defaultSettings.agent,
    ...saved?.agent
  },
  ui: {
    ...defaultSettings.ui,
    ...saved?.ui,
    favoriteModels: {
      lmstudio: [
        ...saved?.ui?.favoriteModels?.lmstudio ?? defaultSettings.ui.favoriteModels.lmstudio
      ],
      openrouter: [
        ...saved?.ui?.favoriteModels?.openrouter ?? defaultSettings.ui.favoriteModels.openrouter
      ]
    }
  }
});
class SettingsStore {
  userData = app.getPath("userData");
  path = join$1(this.userData, SETTINGS_FILE);
  legacyPath = join$1(this.userData, LEGACY_SETTINGS_FILE);
  async load() {
    if (!existsSync(this.path) && existsSync(this.legacyPath)) {
      try {
        await copyFile(this.legacyPath, this.path);
      } catch {
      }
    }
    for (const p of [this.path, this.legacyPath]) {
      try {
        const raw = await readFile(p, "utf8");
        return mergeSettings(JSON.parse(raw));
      } catch {
      }
    }
    return defaultSettings;
  }
  async save(next) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(next, null, 2), "utf8");
    return next;
  }
}
const IGNORED_DIRS = /* @__PURE__ */ new Set([".git", "node_modules", ".next", "dist", "out", "build"]);
const MAX_DEPTH = 4;
const ensureInsideRoot = (root, target) => {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(resolvedRoot, target);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(prefix)) {
    throw new Error("Target path is outside the active workspace.");
  }
  return resolvedTarget;
};
const flattenNodes = (root, nodes, bucket) => {
  for (const node of nodes) {
    bucket.push({
      path: relative(root, node.path) || ".",
      type: node.type
    });
    if (node.children?.length) {
      flattenNodes(root, node.children, bucket);
    }
  }
};
const sortNodes = (nodes) => nodes.sort((a, b) => {
  if (a.type !== b.type) {
    return a.type === "directory" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
});
const buildTree = async (root, depth = 0) => {
  if (depth > MAX_DEPTH) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const nodes = await Promise.all(
    entries.filter((entry) => !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".DS_Store")).map(async (entry) => {
      const fullPath = resolve(root, entry.name);
      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: fullPath,
          type: "directory",
          children: await buildTree(fullPath, depth + 1)
        };
      }
      return {
        name: entry.name,
        path: fullPath,
        type: "file"
      };
    })
  );
  return sortNodes(nodes);
};
class WorkspaceService {
  async chooseWorkspace() {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  }
  async getTree(root) {
    await stat(root);
    return buildTree(root);
  }
  async openFile(root, target) {
    const safePath = ensureInsideRoot(root, target);
    const content = await readFile(safePath, "utf8");
    return { path: safePath, content };
  }
  async saveFile(root, target, content) {
    const safePath = ensureInsideRoot(root, target);
    await mkdir(dirname(safePath), { recursive: true });
    await writeFile(safePath, content, "utf8");
    return { path: safePath, content };
  }
  async deletePath(root, target) {
    const safePath = ensureInsideRoot(root, target);
    await rm(safePath, { recursive: true, force: false });
    return { path: safePath };
  }
  async listFiles(root) {
    const tree = await this.getTree(root);
    const files = [];
    flattenNodes(root, tree, files);
    return files;
  }
  labelForRoot(root) {
    return basename(root);
  }
}
const settingsStore = new SettingsStore();
const chatStore = new ChatStore();
const workspaceService = new WorkspaceService();
const commandService = new CommandService();
const modelService = new ModelService(workspaceService, commandService);
let mainWindow = null;
const createWindow = async () => {
  const windowIcon = nativeImage.createFromPath(appIconPath);
  mainWindow = new BrowserWindow({
    width: 1580,
    height: 980,
    minWidth: 1280,
    minHeight: 760,
    title: "OpenKiwi",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#04111f",
    icon: windowIcon,
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.mjs", import.meta.url)),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    await mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    await mainWindow.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
  }
};
app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(appIconPath);
  }
  await createWindow();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
ipcMain.handle("settings:load", async () => settingsStore.load());
ipcMain.handle("settings:save", async (_event, settings) => settingsStore.save(settings));
ipcMain.handle("workspace:choose", async () => {
  const root = await workspaceService.chooseWorkspace();
  if (!root) {
    return null;
  }
  return {
    root,
    label: basename(root),
    tree: await workspaceService.getTree(root)
  };
});
ipcMain.handle("workspace:tree", async (_event, root) => workspaceService.getTree(root));
ipcMain.handle("workspace:open-file", async (_event, root, target) => workspaceService.openFile(root, target));
ipcMain.handle(
  "workspace:save-file",
  async (_event, root, target, content) => workspaceService.saveFile(root, target, content)
);
ipcMain.handle(
  "models:list",
  async (_event, settings, providerKind) => modelService.listModels(settings, providerKind)
);
ipcMain.handle(
  "chat:stream",
  async (event, requestId, settings, messages, runtime) => {
    if (!mainWindow) {
      throw new Error("Main window is unavailable.");
    }
    try {
      await modelService.streamChat(event, mainWindow, requestId, settings, messages, runtime);
      return { ok: true };
    } catch (error) {
      modelService.sendError(mainWindow, requestId, error);
      return { ok: false };
    }
  }
);
ipcMain.handle("chat:stop", async (_event, requestId) => modelService.stopRequest(requestId));
ipcMain.handle("commands:run", async (_event, command, cwd) => {
  if (!mainWindow) {
    throw new Error("Main window is unavailable.");
  }
  return commandService.run(mainWindow, command, cwd);
});
ipcMain.handle("commands:kill", async (_event, jobId) => commandService.kill(jobId));
ipcMain.handle("chats:list", async () => chatStore.listChats());
ipcMain.handle("chats:load", async (_event, id) => chatStore.loadChat(id));
ipcMain.handle("chats:save", async (_event, chat) => chatStore.saveChat(chat));
ipcMain.handle("chats:delete", async (_event, id) => chatStore.deleteChat(id));

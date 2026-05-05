import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join as join$1, relative, resolve, sep, dirname, basename, extname } from "node:path";
import { existsSync, realpathSync, statSync, watch } from "node:fs";
import { readdir, mkdir, copyFile, readFile, writeFile, unlink, stat, rename, rm, realpath } from "node:fs/promises";
import { app, dialog, BrowserWindow, ipcMain, shell, nativeImage } from "electron";
import { join } from "path";
import { spawn, execFile } from "node:child_process";
import OpenAI from "openai";
import { promisify } from "node:util";
import JSZip from "jszip";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const appIconPath = join(__dirname, "./chunks/app_icon-DtNVDXr_.png");
const mythraBgMysticNeon = join(__dirname, "./chunks/mythra_background1_neon-D6ehJrYa.png");
const mythraBgMysticSunset = join(__dirname, "./chunks/mythra_background1_sunset-BHB69ZDw.png");
const mythraBgMysticIce = join(__dirname, "./chunks/mythra_background1_ice-D2LCKdGA.png");
const mythraBgMysticKiwi = join(__dirname, "./chunks/mythra_background1_kiwi-BGD5SfOs.png");
const CHATS_DIR = "mythra-chats";
const LEGACY_CHAT_DIRS = ["openkiwi-chats", "pixel-forge-chats"];
const CHAT_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const assertSafeChatId = (id) => {
  if (!CHAT_ID_RE.test(id)) {
    throw new Error("Invalid chat id.");
  }
};
class ChatStore {
  userData = app.getPath("userData");
  dir = join$1(this.userData, CHATS_DIR);
  legacyMigrated = false;
  async migrateLegacyChatsIfNeeded() {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    try {
      const newHas = existsSync(this.dir) && (await readdir(this.dir)).some((f) => f.endsWith(".json"));
      if (newHas) return;
      for (const legacyName of LEGACY_CHAT_DIRS) {
        const legacyDir = join$1(this.userData, legacyName);
        if (!existsSync(legacyDir)) continue;
        const files = (await readdir(legacyDir)).filter((f) => f.endsWith(".json"));
        if (files.length === 0) continue;
        await mkdir(this.dir, { recursive: true });
        for (const f of files) {
          const dst = join$1(this.dir, f);
          if (!existsSync(dst)) await copyFile(join$1(legacyDir, f), dst);
        }
        break;
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
          kind: chat.kind ?? "normal",
          title: chat.title,
          titleOverride: chat.titleOverride ?? null,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          pinned: chat.pinned ?? false,
          modelOverride: chat.modelOverride ?? null,
          wizard: chat.wizard ?? null,
          wizardId: chat.wizardId ?? null,
          nexus: chat.nexus ?? null,
          nexusId: chat.nexusId ?? null
        });
      } catch {
      }
    }
    return metas.sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return b.updatedAt - a.updatedAt;
    });
  }
  async loadChat(id) {
    try {
      assertSafeChatId(id);
      const raw = await readFile(join$1(this.dir, `${id}.json`), "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  async saveChat(chat) {
    assertSafeChatId(chat.id);
    await this.ensureDir();
    await writeFile(join$1(this.dir, `${chat.id}.json`), JSON.stringify(chat), "utf8");
  }
  async deleteChat(id) {
    try {
      assertSafeChatId(id);
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
    const shell2 = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/zsh";
    const args = process.platform === "win32" ? ["-Command"] : ["-lc"];
    return { shell: shell2, args };
  }
  killProcessTree(proc) {
    if (proc.pid == null) {
      return;
    }
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"]);
      return;
    }
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
      }
    }
  }
  run(window, command, cwd) {
    const jobId = randomUUID();
    const { shell: shell2, args } = this.getShell();
    const child = spawn(shell2, [...args, command], {
      cwd,
      detached: process.platform !== "win32",
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
    const { shell: shell2, args } = this.getShell();
    return new Promise((resolve2, reject) => {
      const child = spawn(shell2, [...args, command], {
        cwd,
        detached: process.platform !== "win32",
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
        this.killProcessTree(child);
        finish({
          stdout,
          stderr: `${stderr}
[command timed out after ${timeoutMs}ms]`,
          code: null,
          signal: "SIGTERM"
        });
      }, timeoutMs);
      const abortHandler = () => {
        this.killProcessTree(child);
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
    this.killProcessTree(job.process);
    this.jobs.delete(jobId);
    return true;
  }
}
const MYTHRA_SESSION_MODE_TOGGLE = "[[MYTHRA_SESSION_MODE_TOGGLE]]";
const MYTHRA_WEB_SEARCH_TOGGLE = "[[MYTHRA_WEB_SEARCH_TOGGLE]]";
const themeCatalog = [
  { id: "neon-grid", name: "Neon Grid", preview: "Cyan / Lime / Deep Navy" },
  { id: "sunset-terminal", name: "Sunset Terminal", preview: "Coral / Amber / Plum" },
  { id: "ice-station", name: "Ice Station", preview: "Blue / Mint / Graphite" },
  { id: "kiwi", name: "Kiwi", preview: "Green / Teal / Graphite (light)" }
];
const PRESET_THEME_IDS = themeCatalog.map((t) => t.id);
function isPresetThemeId(value) {
  return PRESET_THEME_IDS.includes(value);
}
function isThemeId(value) {
  return isPresetThemeId(value) || value === "custom";
}
function getThemeName(themeId) {
  if (themeId === "custom") return "Custom";
  const entry = themeCatalog.find((t) => t.id === themeId);
  return entry?.name ?? themeId;
}
const CUSTOMIZABLE_THEME_TOKEN_KEYS = [
  "--bg-0",
  "--bg-1",
  "--bg-2",
  "--bg-surface",
  "--bg-elevated",
  "--panel",
  "--panel-strong",
  "--line",
  "--line-strong",
  "--text-0",
  "--text-1",
  "--text-2",
  "--accent",
  "--accent-light",
  "--accent-subtle",
  "--accent-2",
  "--accent-2-subtle",
  "--accent-rgb",
  "--danger",
  "--danger-subtle",
  "--warning",
  "--app-bg",
  "--titlebar-bg",
  "--sidebar-bg",
  "--chat-panel-bg",
  "--chat-thread-bg",
  "--chat-assistant-bg",
  "--chat-user-bg",
  "--thinking-bg",
  "--composer-bg",
  "--composer-input-bg",
  "--inspector-bg",
  "--settings-bg",
  "--editor-bg"
];
function isAllowedCustomThemeTokenKey(key) {
  return CUSTOMIZABLE_THEME_TOKEN_KEYS.includes(key);
}
const THEME_COLOR_SLOT_ALIASES = {
  app: ["--app-bg", "--bg-0"],
  appbackground: ["--app-bg", "--bg-0"],
  window: ["--app-bg", "--bg-0"],
  windowbackground: ["--app-bg", "--bg-0"],
  page: ["--app-bg", "--bg-0"],
  background: ["--app-bg", "--bg-0"],
  titlebar: ["--titlebar-bg"],
  topbar: ["--titlebar-bg"],
  sidebar: ["--sidebar-bg"],
  leftsidebar: ["--sidebar-bg"],
  chat: ["--chat-panel-bg"],
  chatpanel: ["--chat-panel-bg"],
  chatbackground: ["--chat-thread-bg"],
  chatthread: ["--chat-thread-bg"],
  thread: ["--chat-thread-bg"],
  chatbubble: ["--chat-assistant-bg", "--chat-user-bg"],
  chatbubbles: ["--chat-assistant-bg", "--chat-user-bg"],
  bubbles: ["--chat-assistant-bg", "--chat-user-bg"],
  assistant: ["--chat-assistant-bg"],
  assistantmessage: ["--chat-assistant-bg"],
  assistantbubble: ["--chat-assistant-bg"],
  message: ["--chat-assistant-bg"],
  bubble: ["--chat-assistant-bg"],
  user: ["--chat-user-bg"],
  usermessage: ["--chat-user-bg"],
  userbubble: ["--chat-user-bg"],
  thinking: ["--thinking-bg"],
  reasoning: ["--thinking-bg"],
  composer: ["--composer-bg"],
  input: ["--composer-input-bg"],
  messageinput: ["--composer-input-bg"],
  inspector: ["--inspector-bg"],
  rightpanel: ["--inspector-bg"],
  settings: ["--settings-bg"],
  editor: ["--editor-bg"],
  fileeditor: ["--editor-bg"],
  text: ["--text-0"],
  primarytext: ["--text-0"],
  bodytext: ["--text-0"],
  mutedtext: ["--text-2"],
  secondarytext: ["--text-1"],
  border: ["--line", "--line-strong"],
  borders: ["--line", "--line-strong"],
  line: ["--line"],
  accent: ["--accent"],
  primaryaccent: ["--accent"],
  primary: ["--accent"],
  secondaryaccent: ["--accent-2"],
  secondary: ["--accent-2"],
  danger: ["--danger"],
  error: ["--danger"],
  warning: ["--warning"]
};
function expandThemeColorSlot(slot, value, out) {
  if (typeof value !== "string" || value.trim().length === 0) return;
  const normalized = slot.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const tokenKeys = THEME_COLOR_SLOT_ALIASES[normalized];
  if (!tokenKeys) return;
  for (const tokenKey of tokenKeys) {
    out[tokenKey] = value;
  }
}
function flattenMergeThemeToolArgs(args) {
  const out = {};
  const boxed = args.tokens ?? args.theme_tokens ?? args.token;
  if (boxed != null && typeof boxed === "object" && !Array.isArray(boxed)) {
    for (const [key, value] of Object.entries(boxed)) {
      if (key.startsWith("--")) out[key] = value;
      else expandThemeColorSlot(key, value, out);
    }
  }
  const slots = args.slots ?? args.areas ?? args.ui ?? args.ui_colors;
  if (slots != null && typeof slots === "object" && !Array.isArray(slots)) {
    for (const [slot, value] of Object.entries(slots)) {
      expandThemeColorSlot(slot, value, out);
    }
  }
  for (const [k, v] of Object.entries(args)) {
    if (k === "tokens" || k === "theme_tokens" || k === "token" || k === "slots" || k === "areas" || k === "ui" || k === "ui_colors" || k === "palette" || k === "preset") continue;
    if (k.startsWith("--")) out[k] = v;
    else expandThemeColorSlot(k, v, out);
  }
  return out;
}
function sanitizeCustomThemeTokens(input) {
  const out = {};
  for (const [rawK, rawV] of Object.entries(input)) {
    const k = rawK.trim();
    if (!isAllowedCustomThemeTokenKey(k)) continue;
    if (typeof rawV !== "string") continue;
    const v = rawV.trim();
    if (!v) continue;
    out[k] = v;
  }
  return out;
}
const MERGE_THEME_PALETTE_IDS = [
  "soft_kiwi_dark",
  "ice_cool_dark",
  "neutral_slate_dark",
  "light_paper_gray"
];
const SEMANTIC_CUSTOM_THEME_PALETTE_IDS = [
  "red",
  "pink",
  "purple",
  "blue",
  "green",
  "orange",
  "slate",
  "white",
  "ice",
  "kiwi"
];
const SEMANTIC_CUSTOM_THEME_MODE_IDS = ["light", "dark"];
function isSemanticCustomThemePaletteId(value) {
  return SEMANTIC_CUSTOM_THEME_PALETTE_IDS.includes(value);
}
function isSemanticCustomThemeModeId(value) {
  return SEMANTIC_CUSTOM_THEME_MODE_IDS.includes(value);
}
const semanticHues = {
  red: {
    accent: "#dc2626",
    accentLight: "#ef4444",
    accentRgb: "220, 38, 38",
    accent2: "#b91c1c",
    danger: "#991b1b",
    warning: "#f59e0b"
  },
  pink: {
    accent: "#ec4899",
    accentLight: "#f472b6",
    accentRgb: "236, 72, 153",
    accent2: "#db2777",
    danger: "#e11d48",
    warning: "#f59e0b"
  },
  purple: {
    accent: "#8b5cf6",
    accentLight: "#a78bfa",
    accentRgb: "139, 92, 246",
    accent2: "#d946ef",
    danger: "#f43f5e",
    warning: "#f59e0b"
  },
  blue: {
    accent: "#2563eb",
    accentLight: "#60a5fa",
    accentRgb: "37, 99, 235",
    accent2: "#06b6d4",
    danger: "#ef4444",
    warning: "#f59e0b"
  },
  green: {
    accent: "#16a34a",
    accentLight: "#22c55e",
    accentRgb: "22, 163, 74",
    accent2: "#0d9488",
    danger: "#ef4444",
    warning: "#d97706"
  },
  orange: {
    accent: "#f97316",
    accentLight: "#fb923c",
    accentRgb: "249, 115, 22",
    accent2: "#f59e0b",
    danger: "#e11d48",
    warning: "#facc15"
  }
};
function semanticPaletteFromDescription(value) {
  const raw = value?.toLowerCase() ?? "";
  if (/\bred\b|ruby|crimson|scarlet|\bfire\b|blood(?!\s*sugar)|cherry(?!\s*blossom)/.test(raw)) return "red";
  if (/\bpink|rose|magenta|fuchsia|hot\s*pink\b/.test(raw)) return "pink";
  if (/\bpurple|violet|lavender\b/.test(raw)) return "purple";
  if (/\bblue|cyan|aqua\b/.test(raw)) return "blue";
  if (/\bgreen|kiwi|lime|mint\b/.test(raw)) return raw.includes("kiwi") ? "kiwi" : "green";
  if (/\borange|amber|sunset|coral\b/.test(raw)) return "orange";
  if (/\bice|icy|frost|winter\b/.test(raw)) return "ice";
  if (/\bwhite|paper|cream|ivory|gray|grey|slate|neutral|mono/.test(raw)) {
    return /\bwhite|paper|cream|ivory\b/.test(raw) ? "white" : "slate";
  }
  return void 0;
}
function semanticModeFromDescription(value) {
  const raw = value?.toLowerCase() ?? "";
  if (/\bdark|night|black|deep|midnight\b/.test(raw)) return "dark";
  if (/\blight|white|bright|paper|pastel|cream|ivory\b/.test(raw)) return "light";
  return void 0;
}
function buildSemanticCustomThemeTokens(input) {
  const palette = input.palette && isSemanticCustomThemePaletteId(input.palette) ? input.palette : semanticPaletteFromDescription(input.description) ?? "pink";
  const mode = input.mode && isSemanticCustomThemeModeId(input.mode) ? input.mode : semanticModeFromDescription(input.description) ?? "light";
  if (palette === "white") {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY }, palette, mode: "light" };
  }
  if (palette === "slate") {
    return {
      tokens: mode === "light" ? { ...CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY } : { ...CUSTOM_THEME_FALLBACK_NEUTRAL_SLATE },
      palette,
      mode
    };
  }
  if (palette === "ice") {
    return {
      tokens: mode === "light" ? { ...CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY, ...semanticLightTokens(semanticHues.blue, "ice") } : { ...CUSTOM_THEME_FALLBACK_ICE_COOL_DARK },
      palette,
      mode
    };
  }
  if (palette === "kiwi") {
    return {
      tokens: mode === "light" ? semanticLightTokens(semanticHues.green, "kiwi") : { ...CUSTOM_THEME_FALLBACK_SOFT_NIGHT_KIWI },
      palette,
      mode
    };
  }
  const hue = semanticHues[palette];
  return {
    tokens: mode === "dark" ? semanticDarkTokens(hue, palette) : semanticLightTokens(hue, palette),
    palette,
    mode
  };
}
function semanticLightTokens(hue, palette) {
  const tinted = palette === "red" ? { bg0: "#fff1f2", bg1: "#ffe4e6", bg2: "#fecdd3", line: "220, 38, 38" } : palette === "pink" ? { bg0: "#fff1f7", bg1: "#ffe4f0", bg2: "#fbcfe8", line: "236, 72, 153" } : palette === "purple" ? { bg0: "#f6f1ff", bg1: "#ede4ff", bg2: "#ddd6fe", line: "139, 92, 246" } : palette === "orange" ? { bg0: "#fff7ed", bg1: "#ffedd5", bg2: "#fed7aa", line: "249, 115, 22" } : palette === "blue" || palette === "ice" ? { bg0: "#eff6ff", bg1: "#dbeafe", bg2: "#bfdbfe", line: "37, 99, 235" } : { bg0: "#f0fdf4", bg1: "#dcfce7", bg2: "#bbf7d0", line: "22, 163, 74" };
  return {
    "--bg-0": tinted.bg0,
    "--bg-1": tinted.bg1,
    "--bg-2": tinted.bg2,
    "--bg-surface": "rgba(255, 255, 255, 0.94)",
    "--bg-elevated": "rgba(255, 255, 255, 0.98)",
    "--panel": "rgba(255, 255, 255, 0.92)",
    "--panel-strong": "rgba(255, 255, 255, 0.97)",
    "--line": `rgba(${tinted.line}, 0.14)`,
    "--line-strong": `rgba(${tinted.line}, 0.24)`,
    "--text-0": "#18181b",
    "--text-1": "rgba(24, 24, 27, 0.78)",
    "--text-2": "rgba(82, 82, 91, 0.58)",
    "--accent": hue.accent,
    "--accent-light": hue.accentLight,
    "--accent-rgb": hue.accentRgb,
    "--accent-subtle": `rgba(${hue.accentRgb}, 0.12)`,
    "--accent-2": hue.accent2,
    "--accent-2-subtle": `rgba(${hue.accentRgb}, 0.10)`,
    "--chat-assistant-bg": `rgba(${hue.accentRgb}, 0.07)`,
    "--chat-user-bg": `rgba(${hue.accentRgb}, 0.16)`,
    "--thinking-bg": `rgba(${hue.accentRgb}, 0.07)`,
    "--composer-input-bg": "rgba(255, 255, 255, 0.72)",
    "--danger": hue.danger,
    "--danger-subtle": "rgba(225, 29, 72, 0.08)",
    "--warning": hue.warning
  };
}
function semanticDarkTokens(hue, palette) {
  const tinted = palette === "red" ? { bg0: "#1c0a0a", bg1: "#2a1010", bg2: "#3f1515", line: "220, 38, 38" } : palette === "pink" ? { bg0: "#170812", bg1: "#230b1a", bg2: "#331127", line: "236, 72, 153" } : palette === "purple" ? { bg0: "#10091f", bg1: "#18102b", bg2: "#24163f", line: "139, 92, 246" } : palette === "orange" ? { bg0: "#160c05", bg1: "#211208", bg2: "#321a0b", line: "249, 115, 22" } : palette === "blue" ? { bg0: "#07101f", bg1: "#0b1730", bg2: "#102040", line: "37, 99, 235" } : { bg0: "#07140e", bg1: "#0b1e14", bg2: "#102b1c", line: "22, 163, 74" };
  return {
    "--bg-0": tinted.bg0,
    "--bg-1": tinted.bg1,
    "--bg-2": tinted.bg2,
    "--bg-surface": `rgba(${tinted.line}, 0.06)`,
    "--bg-elevated": `rgba(${tinted.line}, 0.10)`,
    "--panel": "rgba(12, 12, 18, 0.88)",
    "--panel-strong": "rgba(8, 8, 14, 0.96)",
    "--line": `rgba(${tinted.line}, 0.18)`,
    "--line-strong": `rgba(${tinted.line}, 0.30)`,
    "--text-0": "#f8fafc",
    "--text-1": "rgba(226, 232, 240, 0.84)",
    "--text-2": "rgba(148, 163, 184, 0.62)",
    "--accent": hue.accent,
    "--accent-light": hue.accentLight,
    "--accent-rgb": hue.accentRgb,
    "--accent-subtle": `rgba(${hue.accentRgb}, 0.18)`,
    "--accent-2": hue.accent2,
    "--accent-2-subtle": `rgba(${hue.accentRgb}, 0.14)`,
    "--chat-assistant-bg": `rgba(${hue.accentRgb}, 0.08)`,
    "--chat-user-bg": `rgba(${hue.accentRgb}, 0.18)`,
    "--thinking-bg": `rgba(${hue.accentRgb}, 0.08)`,
    "--composer-input-bg": `rgba(${hue.accentRgb}, 0.08)`,
    "--danger": hue.danger,
    "--danger-subtle": "rgba(225, 29, 72, 0.14)",
    "--warning": hue.warning
  };
}
const CUSTOM_THEME_FALLBACK_ICE_COOL_DARK = {
  "--bg-0": "#0a1018",
  "--bg-1": "#0d1520",
  "--bg-2": "#131c28",
  "--bg-surface": "rgba(13, 21, 32, 0.94)",
  "--bg-elevated": "rgba(19, 28, 40, 0.97)",
  "--panel": "rgba(13, 21, 32, 0.92)",
  "--panel-strong": "rgba(10, 16, 24, 0.96)",
  "--line": "rgba(100, 150, 200, 0.14)",
  "--line-strong": "rgba(120, 170, 220, 0.22)",
  "--text-0": "#f0f6ff",
  "--text-1": "rgba(199, 216, 240, 0.86)",
  "--text-2": "rgba(130, 160, 200, 0.55)",
  "--accent": "#3b82f6",
  "--accent-light": "#60a5fa",
  "--accent-rgb": "59, 130, 246",
  "--accent-subtle": "rgba(59, 130, 246, 0.16)",
  "--accent-2": "#22d3ee",
  "--accent-2-subtle": "rgba(34, 211, 238, 0.12)",
  "--chat-assistant-bg": "rgba(59, 130, 246, 0.08)",
  "--chat-user-bg": "rgba(34, 211, 238, 0.16)",
  "--thinking-bg": "rgba(59, 130, 246, 0.08)",
  "--composer-input-bg": "rgba(59, 130, 246, 0.08)",
  "--danger": "#fb7185",
  "--danger-subtle": "rgba(251, 113, 133, 0.12)",
  "--warning": "#fbbf24"
};
const CUSTOM_THEME_FALLBACK_NEUTRAL_SLATE = {
  "--bg-0": "#0c0e12",
  "--bg-1": "#11141a",
  "--bg-2": "#181c24",
  "--bg-surface": "rgba(17, 20, 26, 0.94)",
  "--bg-elevated": "rgba(24, 28, 36, 0.97)",
  "--panel": "rgba(17, 20, 26, 0.92)",
  "--panel-strong": "rgba(12, 14, 18, 0.96)",
  "--line": "rgba(148, 163, 184, 0.12)",
  "--line-strong": "rgba(148, 163, 184, 0.22)",
  "--text-0": "#f1f5f9",
  "--text-1": "rgba(203, 213, 225, 0.84)",
  "--text-2": "rgba(148, 163, 184, 0.58)",
  "--accent": "#94a3b8",
  "--accent-light": "#cbd5e1",
  "--accent-rgb": "148, 163, 184",
  "--accent-subtle": "rgba(148, 163, 184, 0.16)",
  "--accent-2": "#64748b",
  "--accent-2-subtle": "rgba(100, 116, 139, 0.14)",
  "--chat-assistant-bg": "rgba(148, 163, 184, 0.08)",
  "--chat-user-bg": "rgba(148, 163, 184, 0.16)",
  "--thinking-bg": "rgba(148, 163, 184, 0.08)",
  "--composer-input-bg": "rgba(148, 163, 184, 0.08)",
  "--danger": "#f87171",
  "--danger-subtle": "rgba(248, 113, 113, 0.12)",
  "--warning": "#fbbf24"
};
const CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY = {
  "--bg-0": "#fafafa",
  "--bg-1": "#f4f4f5",
  "--bg-2": "#e4e4e7",
  "--bg-surface": "rgba(250, 250, 250, 0.96)",
  "--bg-elevated": "rgba(255, 255, 255, 0.98)",
  "--panel": "rgba(244, 244, 245, 0.94)",
  "--panel-strong": "rgba(255, 255, 255, 0.97)",
  "--line": "rgba(15, 23, 42, 0.08)",
  "--line-strong": "rgba(15, 23, 42, 0.14)",
  "--text-0": "#18181b",
  "--text-1": "rgba(24, 24, 27, 0.78)",
  "--text-2": "rgba(82, 82, 91, 0.58)",
  "--accent": "#64748b",
  "--accent-light": "#475569",
  "--accent-rgb": "100, 116, 139",
  "--accent-subtle": "rgba(100, 116, 139, 0.12)",
  "--accent-2": "#71717a",
  "--accent-2-subtle": "rgba(113, 113, 122, 0.12)",
  "--chat-assistant-bg": "rgba(100, 116, 139, 0.06)",
  "--chat-user-bg": "rgba(100, 116, 139, 0.13)",
  "--thinking-bg": "rgba(100, 116, 139, 0.06)",
  "--composer-input-bg": "rgba(255, 255, 255, 0.72)",
  "--danger": "#dc2626",
  "--danger-subtle": "rgba(220, 38, 38, 0.08)",
  "--warning": "#d97706"
};
const CUSTOM_THEME_FALLBACK_SOFT_NIGHT_KIWI = {
  "--bg-0": "#0b1210",
  "--bg-1": "#0f1714",
  "--bg-2": "#15201b",
  "--bg-surface": "rgba(15, 23, 20, 0.94)",
  "--bg-elevated": "rgba(22, 32, 28, 0.97)",
  "--panel": "rgba(15, 23, 20, 0.92)",
  "--panel-strong": "rgba(12, 18, 16, 0.96)",
  "--line": "rgba(148, 180, 160, 0.12)",
  "--line-strong": "rgba(148, 180, 160, 0.22)",
  "--text-0": "#eef7f2",
  "--text-1": "rgba(214, 232, 220, 0.85)",
  "--text-2": "rgba(148, 180, 160, 0.58)",
  "--accent": "#22c55e",
  "--accent-light": "#4ade80",
  "--accent-rgb": "34, 197, 94",
  "--accent-subtle": "rgba(34, 197, 94, 0.14)",
  "--accent-2": "#14b8a6",
  "--accent-2-subtle": "rgba(20, 184, 166, 0.14)",
  "--chat-assistant-bg": "rgba(34, 197, 94, 0.08)",
  "--chat-user-bg": "rgba(34, 197, 94, 0.18)",
  "--thinking-bg": "rgba(34, 197, 94, 0.08)",
  "--composer-input-bg": "rgba(34, 197, 94, 0.08)",
  "--danger": "#fb7185",
  "--danger-subtle": "rgba(251, 113, 133, 0.12)",
  "--warning": "#fbbf24"
};
function isLikelyLightCssBackground(value) {
  if (value == null) return false;
  const s = value.trim().toLowerCase();
  if (s === "white" || s === "#fff" || s === "#ffffff" || s === "snow") return true;
  const hex6 = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex6) {
    const r = parseInt(hex6[1].slice(0, 2), 16);
    const g = parseInt(hex6[1].slice(2, 4), 16);
    const b = parseInt(hex6[1].slice(4, 6), 16);
    return (r + g + b) / 3 > 210 || r > 238 && g > 238;
  }
  const hex3 = /^#([0-9a-f]{3})$/i.exec(s);
  if (hex3) {
    const ch = hex3[1];
    const r = parseInt(ch[0] + ch[0], 16);
    const g = parseInt(ch[1] + ch[1], 16);
    const bch = parseInt(ch[2] + ch[2], 16);
    return (r + g + bch) / 3 > 210;
  }
  return /^#f[A-Fa-f0-9]{2}[A-Fa-f0-9]{2}[A-Fa-f0-9]{2}/i.test(s);
}
function shouldReplaceFullCustomPalette(hadUserTokens, mergedPartial, resolvedPaletteId, mergedBgCandidate) {
  if (resolvedPaletteId === "light_paper_gray") return true;
  if (hadUserTokens && mergedBgCandidate && isLikelyLightCssBackground(mergedBgCandidate)) return true;
  return false;
}
function resolveCustomThemeFallback(paletteHint) {
  const raw = paletteHint?.trim().toLowerCase() ?? "";
  if (raw === "ice_cool_dark") {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_ICE_COOL_DARK }, id: "ice_cool_dark" };
  }
  if (raw === "neutral_slate_dark") {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_NEUTRAL_SLATE }, id: "neutral_slate_dark" };
  }
  if (raw === "light_paper_gray") {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY }, id: "light_paper_gray" };
  }
  if (raw === "soft_kiwi_dark" || raw === "") {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_SOFT_NIGHT_KIWI }, id: "soft_kiwi_dark" };
  }
  const mentionsWhitePaper = /\b(all[-_\s]?white|white\b|paper\b|ivory\b|cream\b|snow\b|milky\b|pastel\b|bright\b\s*(theme|bg|palette|appearance|ui))\b/i.test(raw) || /\blight\b/i.test(raw) && /\b(theme|themes|palette|appearance|bg|background|scheme|chrome|bright)\b/i.test(raw) && !/\bdark\b/i.test(raw);
  const isIce = /\b(?:icy|ice[-_\s]?station|ice_cool|icecool)\b/i.test(raw) || /\bice\b/i.test(raw) && /\b(?:dark|blue|cool|station)\b/i.test(raw) || raw.includes("cool") && /\b(?:blue|icy|cold)\b/i.test(raw);
  const looksNeutralMuted = /\bneutral\b/i.test(raw) || /\bgray\b|\bgrey\b|\bslate\b/i.test(raw) || /\bmuted\b|\bmonochrome\b/i.test(raw) || /\bneutral[-_\s]?slate\b/i.test(raw);
  if (mentionsWhitePaper) {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY }, id: "light_paper_gray" };
  }
  if (looksNeutralMuted && !isIce) {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_NEUTRAL_SLATE }, id: "neutral_slate_dark" };
  }
  if (isIce) {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_ICE_COOL_DARK }, id: "ice_cool_dark" };
  }
  return { tokens: { ...CUSTOM_THEME_FALLBACK_SOFT_NIGHT_KIWI }, id: "soft_kiwi_dark" };
}
const pushUnique = (acc, line) => {
  const t = line.trim();
  if (t) acc.push(t);
};
const fallbackNoticeDdg = (summary) => `${summary}

`;
function premiumSearchUsesApiChain(provider) {
  return provider === "tavily_then_brave" || provider === "brave_then_tavily";
}
function premiumSearchTryOrder(settings) {
  if (!premiumSearchUsesApiChain(settings.provider)) return [];
  const hasT = settings.tavilyApiKey.trim().length > 0;
  const hasB = settings.braveApiKey.trim().length > 0;
  const seq = settings.provider === "tavily_then_brave" ? ["tavily", "brave"] : ["brave", "tavily"];
  return seq.filter((k) => k === "tavily" ? hasT : hasB);
}
function paidLabel(kind) {
  return kind === "tavily" ? "Tavily" : "Brave Search";
}
async function searchPaid(kind, query, settings) {
  const q = query.trim();
  return kind === "tavily" ? await searchTavily(q, settings.tavilyApiKey.trim()) : await searchBrave(q, settings.braveApiKey.trim());
}
const stripTags = (value) => value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const formatSearchResults = (provider, query, results) => {
  if (results.length === 0) {
    return `${provider} returned no web results for: "${query}"`;
  }
  return [
    `${provider} web results for "${query}":`,
    ...results.slice(0, 8).map((result, index) => {
      const lines = [`${index + 1}. ${result.title || result.url || "Untitled result"}`];
      if (result.url) lines.push(`   URL: ${result.url}`);
      if (result.snippet) lines.push(`   Snippet: ${result.snippet}`);
      if (result.published) lines.push(`   Published: ${result.published}`);
      if (typeof result.score === "number") lines.push(`   Score: ${Math.round(result.score * 1e3) / 1e3}`);
      return lines.join("\n");
    })
  ].join("\n\n");
};
async function searchTavily(q, apiKey) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      api_key: apiKey,
      query: q,
      search_depth: "basic",
      max_results: 8,
      include_answer: false,
      include_raw_content: false
    })
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  return formatSearchResults(
    "Tavily",
    q,
    (data.results ?? []).map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.content ? stripTags(result.content) : void 0,
      published: result.published_date,
      score: result.score
    }))
  );
}
async function searchBrave(q, apiKey) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", q);
  url.searchParams.set("count", "8");
  url.searchParams.set("text_decorations", "false");
  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey
    }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  return formatSearchResults(
    "Brave",
    q,
    (data.web?.results ?? []).map((result) => ({
      title: result.title || result.profile?.long_name,
      url: result.url,
      snippet: result.description ? stripTags(result.description) : void 0,
      published: result.age
    }))
  );
}
function* walkRelatedTopics(topics, maxDepth, maxOut) {
  for (const item of topics) {
    if (maxOut.n <= 0) return;
    if (!item || typeof item !== "object") continue;
    const o = item;
    if (typeof o.Text === "string" && o.Text.trim()) {
      const u = typeof o.FirstURL === "string" && o.FirstURL.trim() ? o.FirstURL.trim() : "";
      maxOut.n -= 1;
      yield u ? `- ${o.Text.trim()}
  ${u}` : `- ${o.Text.trim()}`;
    }
    if (maxDepth > 0 && Array.isArray(o.Topics)) {
      yield* walkRelatedTopics(o.Topics, maxDepth - 1, maxOut);
    }
  }
}
async function searchWeb(query, settings) {
  const q = query.trim();
  if (!q) {
    return "Error: empty search query.";
  }
  const s = settings;
  const usePaid = s != null && premiumSearchUsesApiChain(s.provider);
  const chain = usePaid && s ? premiumSearchTryOrder(s) : [];
  if (!s || !usePaid || chain.length === 0) {
    return searchDuckDuckGo(q);
  }
  let prefix = "";
  for (let i = 0; i < chain.length; i += 1) {
    const kind = chain[i];
    try {
      const body = await searchPaid(kind, q, s);
      return prefix ? `${prefix}${body}` : body;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const label = paidLabel(kind);
      if (i < chain.length - 1) {
        const nextLabel = paidLabel(chain[i + 1]);
        prefix += `${label} search failed (${reason}). Trying ${nextLabel} instead.

`;
      } else {
        prefix += `${label} search failed (${reason}). ` + fallbackNoticeDdg("Falling back to DuckDuckGo instant answers.");
      }
    }
  }
  return `${prefix}${await searchDuckDuckGo(q)}`;
}
async function searchDuckDuckGo(q) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=0`;
  let data;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mythra/0.1 (https://github.com) desktop assistant" }
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
    pushUnique(lines, `Topic: ${d.Heading.trim()}`);
  }
  if (typeof d.AbstractText === "string" && d.AbstractText.trim()) {
    pushUnique(lines, d.AbstractText.trim());
    if (typeof d.AbstractSource === "string" && d.AbstractSource.trim()) {
      pushUnique(lines, `Via: ${d.AbstractSource.trim()}`);
    }
    if (typeof d.AbstractURL === "string" && d.AbstractURL.trim()) {
      pushUnique(lines, `Source: ${d.AbstractURL.trim()}`);
    }
  }
  if (typeof d.Answer === "string" && d.Answer.trim()) {
    const at = typeof d.AnswerType === "string" && d.AnswerType.trim() ? ` [${d.AnswerType.trim()}]` : "";
    pushUnique(lines, `Answer${at}: ${d.Answer.trim()}`);
  }
  if (typeof d.Definition === "string" && d.Definition.trim()) {
    const def = d.Definition.trim();
    const src = typeof d.DefinitionURL === "string" && d.DefinitionURL.trim() ? d.DefinitionURL.trim() : "";
    pushUnique(lines, src ? `Definition: ${def}
Source: ${src}` : `Definition: ${def}`);
  }
  const results = d.Results;
  if (Array.isArray(results) && results.length > 0) {
    const block = ["Web results:"];
    let n = 0;
    for (const item of results) {
      if (n >= 8) break;
      if (!item || typeof item !== "object") continue;
      const o = item;
      const text = typeof o.Text === "string" ? o.Text.replace(/<[^>]+>/g, "").trim() : "";
      const urlR = typeof o.FirstURL === "string" && o.FirstURL.trim() ? o.FirstURL.trim() : "";
      if (text || urlR) {
        n += 1;
        if (text && urlR) {
          block.push(`- ${text}
  ${urlR}`);
        } else {
          block.push(`- ${text || urlR}`);
        }
      }
    }
    if (block.length > 1) {
      pushUnique(lines, block.join("\n\n"));
    }
  }
  const related = d.RelatedTopics;
  if (Array.isArray(related) && related.length > 0) {
    const relLines = ["Related:"];
    const maxOut = { n: 10 };
    for (const r of walkRelatedTopics(related, 2, maxOut)) {
      relLines.push(r);
    }
    if (relLines.length > 1) {
      pushUnique(lines, relLines.join("\n"));
    }
  }
  if (lines.length === 0) {
    const weatherExtra = await tryOpenMeteoWeatherSupplement(q);
    if (weatherExtra) {
      return weatherExtra;
    }
    return [
      `DuckDuckGo returned no instant answer for: "${q}"`,
      "This API only returns short instant answers, not a full result page. Try web_search again with: fewer words, exact product or error text in quotes, a year (e.g. 2026) for current topics, or an official site/repo name.",
      'For local weather, include a place name the geocoder can find (e.g. city and state); "here" is not available to the tool.',
      `DuckDuckGo (browser): https://duckduckgo.com/?q=${encodeURIComponent(q)}`
    ].join("\n\n");
  }
  return lines.join("\n\n");
}
const WEATHERISH = /\bweather|forecast|temperature|rain|snow|humidity|wind( speed)?\b/i;
function extractPlaceForWeather(q) {
  let s = q.replace(/^(what('?s| is)|please|can you|tell me|i want to know|could you)\s+/i, "").replace(/\b(the\s+)?(current|today'?s?|right now|local)\b/gi, " ").replace(/\b(weather|forecast|conditions?|like|outside)\b/gi, " ").replace(/\b(in|at|for|near|around)\b/gi, " ").replace(/\b(here|this place|my (town|area|location)|locally)\b/gi, "").replace(/\s+/g, " ").trim();
  if (s.length >= 2 && !/^(here|there|it)\b/i.test(s)) {
    return s.slice(0, 180);
  }
  s = q.replace(/\b(what|when|where|the|a|an|is|are|for|in|at|to|and|or|me|my|can|you|please|tell|current|local|right|now|weather|like|how|get|about)\b/gi, " ").replace(/\s+/g, " ").trim();
  if (s.length >= 3 && !/^(here|there)\b/i.test(s)) {
    return s.slice(0, 180);
  }
  return null;
}
function wmoWeatherPhrase(code) {
  if (code === 0) return "Clear sky";
  if (code <= 3) return "Mainly clear, partly cloudy, or overcast";
  if (code <= 48) return "Fog or rime";
  if (code <= 67) return "Drizzle or rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Rain showers";
  if (code <= 86) return "Snow showers";
  if (code <= 99) return "Thunderstorm or heavy precipitation";
  return "See WMO code";
}
async function tryOpenMeteoWeatherSupplement(q) {
  if (!WEATHERISH.test(q)) {
    return null;
  }
  const place = extractPlaceForWeather(q);
  if (!place) {
    return [
      "Weather lookup needs a named place in the search query (the tool has no access to the user’s GPS).",
      "Ask the user for a city/region, or run web_search again with a query like: weather [City] [State/Country].",
      `Tried: "${q}"`
    ].join("\n\n");
  }
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=3&language=en`;
  let geo;
  try {
    const res = await fetch(geoUrl, { headers: { "User-Agent": "Mythra/0.1 (desktop; Open-Meteo geocoding)" } });
    if (!res.ok) return null;
    geo = await res.json();
  } catch {
    return null;
  }
  const g = geo;
  const hit = g.results?.[0];
  if (!hit) {
    return null;
  }
  const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(", ");
  const fcUrl = new URL("https://api.open-meteo.com/v1/forecast");
  fcUrl.searchParams.set("latitude", String(hit.latitude));
  fcUrl.searchParams.set("longitude", String(hit.longitude));
  fcUrl.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m");
  fcUrl.searchParams.set("temperature_unit", "fahrenheit");
  fcUrl.searchParams.set("wind_speed_unit", "mph");
  fcUrl.searchParams.set("timezone", "auto");
  let data;
  try {
    const res = await fetch(fcUrl.toString(), { headers: { "User-Agent": "Mythra/0.1 (Open-Meteo forecast)" } });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  const d = data;
  const cur = d.current;
  if (!cur || typeof cur.temperature_2m !== "number") {
    return null;
  }
  const code = typeof cur.weather_code === "number" ? cur.weather_code : 0;
  const lines = [
    `Open-Meteo (current conditions, approximate) for ${label}:`,
    `— Temperature: ${Math.round(cur.temperature_2m * 10) / 10}°F` + (typeof cur.apparent_temperature === "number" ? ` (feels like ${Math.round(cur.apparent_temperature * 10) / 10}°F)` : ""),
    `— ${wmoWeatherPhrase(code)} (code ${code})`
  ];
  if (typeof cur.wind_speed_10m === "number") {
    lines.push(`— Wind: ${Math.round(cur.wind_speed_10m * 10) / 10} mph`);
  }
  if (typeof cur.relative_humidity_2m === "number") {
    lines.push(`— Humidity: ${Math.round(cur.relative_humidity_2m)}%`);
  }
  lines.push("Source: Open-Meteo (open-meteo.com). Not a replacement for official alerts or forecasts.");
  return lines.join("\n");
}
function tryParseArgs(raw) {
  if (raw == null || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function ss(v) {
  return typeof v === "string" ? v : "";
}
function displayFile(path) {
  const raw = ss(path).replace(/\\/g, "/").trim();
  if (!raw) return "file";
  const parts = raw.split("/").filter(Boolean);
  const base = parts.length ? parts[parts.length - 1] : raw;
  return base ?? raw;
}
function truncateSnippet(text, max) {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}
function webSearchProviderLabel(search) {
  const head = premiumSearchTryOrder(search)[0];
  if (head === "tavily") return "Tavily";
  if (head === "brave") return "Brave Search";
  return "DuckDuckGo";
}
function humanFallback(toolName) {
  return toolName.replace(/_/g, " ");
}
function formatToolActivityStart(toolName, rawArguments, settings) {
  const args = tryParseArgs(rawArguments);
  if (args === null) {
    return `Using ${humanFallback(toolName)}`;
  }
  switch (toolName) {
    case "web_search": {
      const q = truncateSnippet(ss(args.query), 100);
      if (!q) return "Searching the web";
      const who = webSearchProviderLabel(settings.search);
      return `Searching with ${who} for "${q}"`;
    }
    case "read_file":
      return `Reading ${displayFile(args.path)}`;
    case "write_file":
      return `Writing ${displayFile(args.path)}`;
    case "replace_in_file":
      return `Editing ${displayFile(args.path)}`;
    case "insert_after":
      return `Inserting into ${displayFile(args.path)}`;
    case "apply_patch":
      return "Applying a patch";
    case "rename_file": {
      const from = displayFile(args.from);
      const to = displayFile(args.to);
      return `Renaming ${from} → ${to}`;
    }
    case "delete_path":
      return `Deleting ${displayFile(args.path)}`;
    case "list_files":
      return "Listing workspace files";
    case "search_symbols": {
      const q = truncateSnippet(ss(args.query), 80);
      return q ? `Searching code for "${q}"` : "Searching project code";
    }
    case "get_file_outline":
      return `Showing outline of ${displayFile(args.path)}`;
    case "get_git_diff":
      return "Checking workspace changes";
    case "run_command": {
      const cmd = truncateSnippet(ss(args.command), 70);
      return cmd ? `Running: ${cmd}` : "Running a command";
    }
    case "run_tests": {
      const cmd = truncateSnippet(ss(args.command) || "npm test", 70);
      return `Running tests: ${cmd}`;
    }
    case "set_app_theme": {
      const id = truncateSnippet(ss(args.theme_id), 48);
      return id ? `Switching theme to ${id}` : "Changing app theme";
    }
    case "merge_custom_theme_tokens":
      return "Updating custom theme colors";
    case "set_custom_theme":
      return "Applying a custom theme";
    case "get_app_theme":
      return "Reading current theme";
    case "get_tool_access":
      return "Reading tool permissions";
    case "get_system_prompt":
      return "Reading AI instructions (system prompt)";
    case "get_wizard_system_prompt":
      return "Reading Wizard instructions";
    case "set_system_prompt":
      return "Updating system prompt";
    case "set_wizard_system_prompt":
      return "Updating Wizard instructions";
    case "set_wizard_display_name": {
      const name = truncateSnippet(ss(args.display_name), 64);
      return name ? `Renaming Wizard to “${name}”` : "Renaming Wizard";
    }
    case "revert_app_theme":
      return "Reverting theme";
    default:
      return `Using ${humanFallback(toolName)}`;
  }
}
function formatToolActivityDone(toolName, rawArguments) {
  const args = tryParseArgs(rawArguments);
  if (args === null) {
    return `Finished (${humanFallback(toolName)})`;
  }
  switch (toolName) {
    case "web_search":
      return "Search finished";
    case "read_file":
      return `Read ${displayFile(args.path)}`;
    case "write_file":
      return `Wrote ${displayFile(args.path)}`;
    case "replace_in_file":
      return `Updated ${displayFile(args.path)}`;
    case "insert_after":
      return `Inserted into ${displayFile(args.path)}`;
    case "apply_patch":
      return "Patch applied";
    case "rename_file":
      return `Renamed ${displayFile(args.from)} → ${displayFile(args.to)}`;
    case "delete_path":
      return `Deleted ${displayFile(args.path)}`;
    case "list_files":
      return "Listed files";
    case "search_symbols":
      return "Code search finished";
    case "get_file_outline":
      return `Outlined ${displayFile(args.path)}`;
    case "get_git_diff":
      return "Change check finished";
    case "run_command":
      return "Command finished";
    case "run_tests":
      return "Tests finished";
    case "set_app_theme":
      return "Theme updated";
    case "merge_custom_theme_tokens":
    case "set_custom_theme":
      return "Theme updated";
    case "get_app_theme":
      return "Theme details loaded";
    case "get_tool_access":
      return "Permissions loaded";
    case "get_system_prompt":
    case "get_wizard_system_prompt":
      return "Instructions loaded";
    case "set_system_prompt":
    case "set_wizard_system_prompt":
      return "Instructions saved";
    case "set_wizard_display_name":
      return "Wizard name saved";
    case "revert_app_theme":
      return "Theme reverted";
    default:
      return "Done";
  }
}
function mapCompletionUsage(u) {
  if (!u) return void 0;
  const pt = u.prompt_tokens ?? 0;
  const ct = u.completion_tokens ?? 0;
  const tt = u.total_tokens ?? pt + ct;
  return { promptTokens: pt, completionTokens: ct, totalTokens: tt };
}
function remapActiveFilePathAfterWorkspaceRootChange(prevRoot, nextRoot, activeFilePath) {
  if (!prevRoot?.trim() || !activeFilePath?.trim()) return activeFilePath;
  const prevR = resolve(prevRoot.trim());
  const nextR = resolve(nextRoot.trim());
  if (prevR === nextR) return activeFilePath;
  const af = resolve(activeFilePath);
  const prefix = prevR.endsWith(sep) ? prevR : `${prevR}${sep}`;
  if (af === prevR || af.startsWith(prefix)) {
    return resolve(join$1(nextR, relative(prevR, af)));
  }
  return activeFilePath;
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
    "X-OpenRouter-Title": provider.appName || "Mythra"
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
const mythraSessionModeEmbedInstruction = `Mythra inline control: you may place this exact token alone on its own line in your reply. The app will replace it with a real Chat/Agent switch. Do not change characters, add spaces inside the token, or put other text on the same line. Use only when the user needs to change session mode. If this prompt already includes "UI session mode: Agent", do not ask them to switch to Agent and do not include this token. Token: ${MYTHRA_SESSION_MODE_TOGGLE}`;
const mythraWebSearchEmbedInstruction = `Mythra inline Web toggle token ${MYTHRA_WEB_SEARCH_TOGGLE}: use ONLY when the chat header "Web" switch is OFF and you want an in-message control so the user can turn web_search on. When "Web" is already ON (see the UI state line in this prompt), do NOT include this token—it would duplicate the header and must not appear. If Web is on, use web_search directly for lookups. Do not change characters or spacing inside the token.`;
const webHeaderUiStateLine = (webOn) => webOn ? `UI: Chat header "Web" is ON; web_search is available. Do not put ${MYTHRA_WEB_SEARCH_TOGGLE} in your message.` : `UI: Chat header "Web" is OFF; web_search is disabled until the user enables "Web". You may use ${MYTHRA_WEB_SEARCH_TOGGLE} on its own line to show an inline switch, or tell them to use the header toggle.`;
const sessionModeUiStateLine = (mode) => mode === "agent" ? "UI session mode: Agent (authoritative for this request). Files, shell, workspace, and theme tools may be used when listed below. Do not tell the user to switch to Agent mode or say they must enable Agent—the UI line above the chat already reflects their choice." : "UI session mode: Chat. You cannot use workspace files, shell, or theme-change tools; invite the user to switch with the Chat/Agent control only if they need those features.";
const mythraWebSearchToolRoutingHint = `web_search: Mythra follows your Web Search provider choice (Settings): DuckDuckGo only, or Tavily-then-Brave / Brave-then-Tavily for whichever API keys are saved—each failure (including quota) skips to the next step, ending on DuckDuckGo instant answers. Failed steps appear in the tool result. DuckDuckGo only returns short blurbs and links, not full pages. For weather, include a resolvable place (city/region) in the query; when DuckDuckGo has no answer, a built-in Open-Meteo fallback may return approximate current conditions (not GPS/“here”). Write tight, distinctive queries: key nouns, exact product or library names, error strings in quotes, or a year for time-sensitive items. If the result is empty or off-topic, call web_search again with different wording before giving up. If still nothing, say that honestly; do not invent URLs or facts the tool did not return.`;
const mythraThemeInChatModeInstruction = `App theme: In Chat mode you cannot read or change the theme (no get_app_theme, set_custom_theme, set_app_theme, revert_app_theme, merge_custom_theme_tokens). You cannot call get_tool_access, get_system_prompt, or change tool permissions—switch to Agent mode first. If the user asks what theme is active, to change the theme, palette, or to revert a theme, say they need Agent mode first, and include the session-mode line so they get an inline switch: ${MYTHRA_SESSION_MODE_TOGGLE}`;
const mythraSetAppThemeAgentInstruction = `App theme (Agent only): For full custom colors call set_custom_theme with an explicit palette from (${SEMANTIC_CUSTOM_THEME_PALETTE_IDS.join(", ")}) and mode light or dark when brightness matters—do not rely only on the description string for routing (e.g. user asks for **red** → palette **red**, not pink). For targeted recolors ("sidebar only", exact hex), use merge_custom_theme_tokens with slots or whitelisted CSS variables. set_app_theme only applies fixed preset tiles (${PRESET_THEME_IDS.join(", ")}). revert_app_theme undoes the last change. After a successful theme change, reply in one short sentence and do not describe colors that differ from the tool result. **Mystic chat background:** When Settings → chat background is **Mythic**, artwork tracks the UI theme. For **Custom** app themes, **light** custom uses the **ice** Mystic image and **dark** custom uses the **neon** Mystic image; the UI layers **--chat-thread-bg** and bubble-related tokens (**--chat-assistant-bg**, **--chat-user-bg**, **--thinking-bg**) on top so the conversation area tints to match the palette. Prefer this coordinated look—after set_custom_theme you may call merge_custom_theme_tokens on **chatThread** / **assistantMessage** / **userMessage** with rgba washes of the accent if the user wants a stronger match.`;
const mythraModelSystemPromptInstruction = "System prompt: in Agent mode you may always call get_system_prompt to read the stored instructions for the **currently selected** provider—it works even when “AI can change system prompt” is off and does not modify settings. If Tool access allows `set_system_prompt`, call it only when the user explicitly asks you to replace those instructions; it overwrites the full prompt for that provider and saves to disk. Call get_tool_access to read Tool access toggles.";
const mythraToolAccessReadInstruction = "Tool access: call get_tool_access when the user asks which capabilities are enabled or disabled in Settings → Tool access (files, workspace search, commands, changing the stored system prompt via set_system_prompt). Reading the stored prompt is always done with get_system_prompt in Agent mode, independent of those toggles.";
const mythraProductFeaturesInstruction = "Mythra UI (describe accurately when users ask how the app works; do **not** say Mythra has no Wizards or no Nexus): The left sidebar has **CHATS**, **WIZARDS**, and **FILES** tabs. In the Wizards section, a **Wizards / Nexus** control switches between the list of **Wizards** and the list of **Nexus projects**. **Wizards** are saved teammates with their own local **workspace folder**, **system prompt** (Inspector → Settings), and **four default core Markdown files only: soul.md, tools.md, memory.md, corrections.md**. Mythra does **not** create **todo.md** or any other default task/inbox file—users add those (or custom docs) if they want. Sessions under a Wizard run Agent tools against **that** Wizard’s folder. Wizards can be exported/imported as `.mythwiz` bundles. **Good Wizard examples** (suggest when users ask how to use them): train a **writing style or brand voice** (detail voice in soul.md, keep sample pieces in the workspace, fold feedback into memory/corrections); **complex note-taking** (PARA/Zettelkasten/second brain with linked `.md` in the folder); a **project or stack specialist** (conventions and commands in tools.md); **meeting, research, or journal** flows with dated notes the Wizard maintains; **creative or role-play** personas with lore bibles. **Nexus projects** (New → Nexus, needs at least two Wizards) tie multiple Wizards to **one shared project workspace** on disk; each member still has private identity/memory docs. A Nexus has a **leader** Wizard, optional **mission** text (Inspector → Nexus), **relay** mode (teammates usually speak one stream at a time inside one assistant reply) vs **parallel** mode (multiple teammate streams at once), and tool-approval options (e.g. team full access, leader model approval). A **normal** chat uses the globally open workspace; Wizard and Nexus sessions add the routing described above.";
const mythraCodingToolInstruction = "Mythra coding tools (apply_patch is validated by `git apply` from the workspace root — malformed hunks become “corrupt patch”): Before any edit, read_file the target so line context matches the file on disk. apply_patch must be a single plain-text unified diff (no markdown fences, no prose). First line: `diff --git a/relative/path b/relative/path`; then `--- a/relative/path` and `+++ b/relative/path`; use one hunk per change with `@@ -start,count +start,count @@` where counts are line counts (single-line change is often `@@ -N,1 +N,1 @@`). Paths use forward slashes and match the repo relative to workspace root. Do not include `\\ No newline` unless the file truly needs it. If apply_patch fails, switch to replace_in_file (one exact contiguous match) or write_file for new/small files, then retry. Also use replace_in_file for one exact replacement, insert_after for small anchored inserts, rename_file for moves, get_git_diff after edits, search_symbols/get_file_outline to navigate, run_tests when useful. Every tool call: strict JSON only (double quotes, escape newlines in strings as \\n). Fix malformed JSON and retry; do not blame “relay” or Mythra for corrupt diffs.";
function mergeStreamingToolDelta(acc, delta) {
  const i = delta.index;
  const cur = acc.get(i) ?? { id: "", name: "", args: "" };
  if (delta.id) cur.id = delta.id;
  if (delta.function?.name) cur.name = delta.function.name;
  if (delta.function?.arguments) cur.args += delta.function.arguments;
  acc.set(i, cur);
}
function streamingToolAccToFunctionCalls(acc) {
  return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([i, { id, name, args }]) => ({
    id: id || `call_${i}`,
    type: "function",
    function: { name, arguments: args }
  }));
}
function parseToolCallArgumentsJson(raw) {
  let candidate = raw.trim();
  if (!candidate) {
    return { ok: true, args: {} };
  }
  if (candidate.startsWith("```")) {
    const close = candidate.lastIndexOf("```");
    const firstNl = candidate.indexOf("\n");
    if (firstNl !== -1 && close > firstNl) {
      candidate = candidate.slice(firstNl + 1, close).trim();
    }
  }
  try {
    const parsed = JSON.parse(candidate);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, args: parsed };
    }
  } catch {
  }
  return { ok: false };
}
function resolveStreamChatWallMs() {
  const raw = process.env.MYTHRA_STREAM_CHAT_WALL_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 18e5;
}
function mergeStreamDeadline(controller, wallMs) {
  if (wallMs <= 0) {
    return controller.signal;
  }
  try {
    const AS = AbortSignal;
    if (typeof AS.timeout === "function" && typeof AS.any === "function") {
      return AS.any([controller.signal, AS.timeout(wallMs)]);
    }
  } catch {
  }
  return controller.signal;
}
function mergeLeaderApprovalDeadline(user, timeoutMs) {
  if (timeoutMs <= 0) {
    return user;
  }
  try {
    const AS = AbortSignal;
    if (typeof AS.timeout !== "function" || typeof AS.any !== "function") {
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
function resolveLeaderApprovalWallMs() {
  const raw = process.env.MYTHRA_LEADER_APPROVAL_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 9e4;
}
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
function wizardPromptLooksLikeInjectedRouting(text) {
  const markers = [
    ["[Mythra model routing", "Mythra routing header"],
    ["[OpenKiwi model routing", "legacy routing header"],
    ["[Mythra] Thread id:", "thread routing line"],
    ["[OpenKiwi] Thread id:", "legacy thread routing line"],
    ["Non-Wizard Tool access lines elsewhere in this prompt", "routing reminder copied from this message"]
  ];
  for (const [needle, label] of markers) {
    if (text.includes(needle)) return label;
  }
  return void 0;
}
function agentModeSystemPromptInstructions(settings, runtime) {
  if (runtime.wizardId) {
    const label = runtime.wizardName?.trim() || "this Wizard";
    return [
      `Wizard session: you are running inside the "${label}" Wizard profile. The app merges this Wizard’s private instructions into the request; they are separate from the global LLM provider preset in Settings.`,
      "To change **this Wizard’s own** long-term instructions when the user asks, call `set_wizard_system_prompt` with the full new text. Mythra opens a before/after approval dialog—the user approves or rejects there. Do **not** tell them to enable “AI can change system prompt” under Settings → Tool access for Wizard instruction edits; that toggle only gates `set_system_prompt` (global provider prompt). `set_system_prompt` is not offered in Wizard chats.",
      "`get_wizard_system_prompt` reads this Wizard’s stored private instructions (read-only). Call it before small edits or `set_wizard_system_prompt`. `get_system_prompt` reads the separate **global LLM provider** preset in Settings—do not confuse the two.",
      "`set_wizard_display_name` updates the Wizard **shown name** in the sidebar and Inspector (stored profile). Mythra also renames the Wizard workspace folder on disk when the sanitized name no longer matches the folder name. When the user asks to rename you completely, call `set_wizard_display_name`, then edit soul.md and adjust `set_wizard_system_prompt` so identity text matches.",
      "Non-Wizard Tool access lines elsewhere in this prompt still apply to files, workspace search, and commands; Wizard prompt edits bypass the “AI can change system prompt” toggle.",
      "`set_wizard_system_prompt` must be **only** your Wizard’s authored persona/instructions text—the same kind of content shown in the Wizard editor—not hidden routing copied from this chat (never paste lines starting with `[Mythra model routing`, `[Mythra] Thread id`, workspace listings, or “Enabled tools:”). For small edits, call `get_wizard_system_prompt` first (and `read_file` on soul.md when facts live there), then minimally adjust—do not paste large unrelated blocks.",
      "Personality and durable memory belong in soul.md and memory.md. When the user revises how they want you to behave or what to remember, update those files with `write_file` so they stay authoritative.",
      "The app already appends a “Mythra Wizard runtime” reminder at send time; you usually should not duplicate long runtime explanations inside `system_prompt` unless the user explicitly asks."
    ];
  }
  return [
    mythraModelSystemPromptInstruction,
    settings.tools.allowModelSystemPrompt ? "set_system_prompt is enabled in Settings → you may update the system prompt when the user asks." : "set_system_prompt is disabled; the user can enable “AI can change system prompt” under Tool access. You can still call get_system_prompt anytime in Agent mode to read the stored prompt."
  ];
}
class ModelService {
  constructor(workspaceService2, commandService2, applyAppTheme2, getAppThemeState2, mergeCustomThemeTokens2, setCustomTheme2, persistAppSettings, persistWizardSystemPrompt, persistWizardDisplayName, requestWizardPromptApproval2, requestToolApprovalUi) {
    this.workspaceService = workspaceService2;
    this.commandService = commandService2;
    this.applyAppTheme = applyAppTheme2;
    this.getAppThemeState = getAppThemeState2;
    this.mergeCustomThemeTokens = mergeCustomThemeTokens2;
    this.setCustomTheme = setCustomTheme2;
    this.persistAppSettings = persistAppSettings;
    this.persistWizardSystemPrompt = persistWizardSystemPrompt;
    this.persistWizardDisplayName = persistWizardDisplayName;
    this.requestWizardPromptApproval = requestWizardPromptApproval2;
    this.requestToolApprovalUi = requestToolApprovalUi;
  }
  workspaceService;
  commandService;
  applyAppTheme;
  getAppThemeState;
  mergeCustomThemeTokens;
  setCustomTheme;
  persistAppSettings;
  persistWizardSystemPrompt;
  persistWizardDisplayName;
  requestWizardPromptApproval;
  requestToolApprovalUi;
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
      const streamDeadlineSignal = mergeStreamDeadline(controller, resolveStreamChatWallMs());
      const apiMessages = [
        { role: "system", content: provider.systemPrompt },
        { role: "system", content: sessionContext },
        ...messages.map((message) => toApiMessage(message))
      ];
      const toolDefinitions = this.buildToolDefinitions(settings, runtime);
      if (isTalk && toolDefinitions.length === 0) {
        await this.runTalkStream(client, window, requestId, provider.model, apiMessages, controller);
        return;
      }
      const maxAutoSteps = settings.agent.autoContinue ? Math.max(4, settings.agent.maxAutoSteps || 24) : 1;
      let lastRoundUsage;
      for (let step = 0; step < maxAutoSteps; step += 1) {
        this.assertNotStopped(requestId);
        const stream = await client.chat.completions.create(
          {
            model: provider.model,
            messages: apiMessages,
            tools: toolDefinitions.length > 0 ? toolDefinitions : void 0,
            tool_choice: toolDefinitions.length > 0 ? "auto" : void 0,
            stream: true,
            stream_options: { include_usage: true }
          },
          {
            signal: streamDeadlineSignal
          }
        );
        let assembled = "";
        let assembledReasoning = "";
        const toolAcc = /* @__PURE__ */ new Map();
        let lastFinish = null;
        let lastStreamUsage;
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
          if (typeof delta.content === "string" && delta.content.length > 0) {
            assembled += delta.content;
            window.webContents.send("chat:delta", { requestId, delta: delta.content });
          }
          const dAny = delta;
          if (typeof dAny.reasoning === "string" && dAny.reasoning.length > 0) {
            const r = dAny.reasoning;
            assembledReasoning += r;
            window.webContents.send("chat:delta", { requestId, delta: "", reasoningDelta: r });
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
        if (lastFinish === "tool_calls" && toolCallsFromStream.length === 0) {
          throw new Error("The model requested tools but the streamed tool payload was incomplete. Try again.");
        }
        if (toolCallsFromStream.length) {
          apiMessages.push({
            role: "assistant",
            content: assembled || null,
            tool_calls: toolCallsFromStream
          });
          for (const toolCall of toolCallsFromStream) {
            if (toolCall.type !== "function") {
              continue;
            }
            const rawArgs = toolCall.function.arguments ?? "";
            const parsedArgs = parseToolCallArgumentsJson(rawArgs);
            if (!parsedArgs.ok) {
              this.emitActivity(
                window,
                requestId,
                "warning",
                `${toolCall.function.name}: invalid JSON tool arguments — sending recovery hint to the model.`
              );
              apiMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: truncate(
                  JSON.stringify(
                    {
                      ok: false,
                      error: "invalid_tool_arguments_json",
                      tool: toolCall.function.name,
                      guidance: 'Arguments must be one JSON object with double-quoted keys and strings. For write_file use {"path":"relative/path.ext","content":"<file body as an escaped JSON string>"}. Escape literal quotes as \\", tabs/newlines as \\t / \\n.',
                      raw_preview: truncate(rawArgs, 2e3)
                    },
                    null,
                    2
                  ),
                  18e3
                )
              });
              continue;
            }
            this.emitActivity(
              window,
              requestId,
              toolCall.function.name === "run_command" ? "command" : "tool",
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
              role: "tool",
              tool_call_id: toolCall.id,
              content: truncate(toolResult, 18e3)
            });
            this.emitActivity(window, requestId, "success", formatToolActivityDone(toolCall.function.name, rawArgs));
          }
          continue;
        }
        const content = contentToString(assembled);
        const normalizedContent = normalizeAssistantContent(content);
        if (!normalizedContent) {
          apiMessages.push({
            role: "assistant",
            content: assembled
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
          reasoning: assembledReasoning.trim() || void 0,
          usage: lastStreamUsage
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
        content: lastVisibleAssistantContent || `I hit the per-message step limit (${maxAutoSteps} tool rounds) before finishing. Ask me to continue and I can pick up from here.`,
        usage: lastRoundUsage
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
      const streamSignal = mergeStreamDeadline(controller, resolveStreamChatWallMs());
      const stream = await client.chat.completions.create(
        { model, messages: apiMessages, stream: true, stream_options: { include_usage: true } },
        { signal: streamSignal }
      );
      let assembled = "";
      let assembledReasoning = "";
      let sawTool = false;
      let lastStreamUsage;
      for await (const chunk of stream) {
        this.assertNotStopped(requestId);
        if (chunk.usage) {
          const mapped = mapCompletionUsage(chunk.usage);
          if (mapped) {
            lastStreamUsage = mapped;
          }
        }
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
          content: "In Chat mode the assistant cannot use file or shell tools. If you need those, switch to Agent with the Chat/Agent control at the top of the chat, or in Settings under Theme → Session mode—then use Open Workspace to mount a folder if you need the project, and try again.",
          usage: lastStreamUsage
        });
        return;
      }
      const talkNorm = normalizeAssistantContent(assembled);
      if (!talkNorm) {
        finish({ requestId, content: "The model returned an empty reply. Try your message again.", usage: lastStreamUsage });
        return;
      }
      const reasoning = assembledReasoning.trim() || void 0;
      finish({ requestId, content: talkNorm, reasoning, usage: lastStreamUsage });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      const completion = await client.chat.completions.create(
        { model, messages: apiMessages },
        { signal: mergeStreamDeadline(controller, resolveStreamChatWallMs()) }
      );
      this.assertNotStopped(requestId);
      const fallbackUsage = mapCompletionUsage(completion.usage ?? void 0);
      const assistantMessage = completion.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error("The model returned no message.");
      }
      if (assistantMessage.tool_calls?.length) {
        finish({
          requestId,
          content: "In Chat mode the assistant cannot use file or shell tools. If you need those, switch to Agent with the Chat/Agent control at the top of the chat, or in Settings under Theme → Session mode—then use Open Workspace to mount a folder if you need the project, and try again.",
          usage: fallbackUsage
        });
        return;
      }
      const talkContent = contentToString(assistantMessage.content);
      const talkNorm = normalizeAssistantContent(talkContent);
      if (!talkNorm) {
        finish({ requestId, content: "The model returned an empty reply. Try your message again.", usage: fallbackUsage });
        return;
      }
      const reasoning = extractModelReasoning(assistantMessage);
      finish({ requestId, content: talkNorm, reasoning, usage: fallbackUsage });
    }
  }
  sendError(window, requestId, error) {
    const message = error instanceof Error && error.name === "AbortError" ? "Request stopped." : error instanceof Error ? error.message : "Unknown model error.";
    const payload = { requestId, error: message };
    window.webContents.send("chat:error", payload);
  }
  buildSetAppThemeTool() {
    return {
      type: "function",
      function: {
        name: "set_app_theme",
        description: `Change the Mythra preset theme (fixed appearances in Settings tiles). Allowed ids: ${PRESET_THEME_IDS.join(", ")}. Use set_custom_theme for custom color families (red, pink, purple, dark blue, icy, white, orange, kiwi, etc.).`,
        parameters: {
          type: "object",
          properties: {
            theme_id: {
              type: "string",
              enum: [...PRESET_THEME_IDS],
              description: "Preset theme id (matches Settings theme tiles; use set_custom_theme for custom colors)."
            }
          },
          required: ["theme_id"],
          additionalProperties: false
        }
      }
    };
  }
  buildGetAppThemeTool() {
    return {
      type: "function",
      function: {
        name: "get_app_theme",
        description: "Return the currently applied Mythra theme (id and display name) and, if available, the previous theme before the last change (so you can answer what theme is active or whether the user can revert). Agent mode only.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    };
  }
  buildGetToolAccessTool() {
    return {
      type: "function",
      function: {
        name: "get_tool_access",
        description: "Return which options are enabled under Settings → Tool access: read files, write files, workspace search, command deck, and whether the model may call set_system_prompt to change the stored system prompt. Read-only. (Reading the prompt uses get_system_prompt; that is not controlled by these toggles.)",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    };
  }
  buildGetSystemPromptTool() {
    return {
      type: "function",
      function: {
        name: "get_system_prompt",
        description: "Return the full system prompt text and preset metadata for the **currently selected** LLM provider in Settings (read-only, never writes). Use when the user asks what instructions you were given, what the system prompt says, or to quote the developer prompt. Available in Agent mode even if “AI can change system prompt” is disabled in Tool access. Long prompts may be truncated in the tool result.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    };
  }
  buildGetWizardSystemPromptTool() {
    return {
      type: "function",
      function: {
        name: "get_wizard_system_prompt",
        description: "Return this Wizard’s stored **private** system prompt (read-only)—the text edited in the Wizard profile, not Mythra’s hidden routing layers. Call before `set_wizard_system_prompt` whenever you need the exact current text for a precise edit. This is distinct from `get_system_prompt`, which reads the global LLM provider preset in Settings. Long prompts may be truncated.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    };
  }
  buildRevertAppThemeTool() {
    return {
      type: "function",
      function: {
        name: "revert_app_theme",
        description: "Set the app theme back to the previous theme (undo the most recent theme change from Settings or set_app_theme). Call get_app_theme first if you need to confirm canRevert. Agent mode only.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    };
  }
  buildMergeCustomThemeTokensTool() {
    return {
      type: "function",
      function: {
        name: "merge_custom_theme_tokens",
        description: "Exact Custom theme editor. Use this when the user wants a specific UI area recolored or gives exact colors. Prefer the slots object so you do not need to know CSS. Supported slots include appBackground, titlebar, sidebar, chatPanel, chatThread, assistantMessage, userMessage, thinking, composer, messageInput, inspector, settings, editor, text, mutedText, border, primaryAccent, secondaryAccent, danger, and warning. **Mystic:** If the chat background is Mystic, tint **chatThread** / **assistantMessage** / **userMessage** with rgba accent washes so the thread matches the custom theme (layers on the theme-aware Mystic image). You may also merge exact whitelisted CSS variables such as --accent, --bg-0, or --text-0. For whole-theme requests, use set_custom_theme first with an explicit palette.",
        parameters: {
          type: "object",
          properties: {
            palette: {
              type: "string",
              enum: [...MERGE_THEME_PALETTE_IDS, ...SEMANTIC_CUSTOM_THEME_PALETTE_IDS],
              description: "Fallback palette if tokens/slots are missing. Semantic ids include red, pink, purple, blue, green, orange, ice, kiwi, slate, white. For full-theme changes prefer set_custom_theme with the same palette id."
            },
            tokens: {
              type: "object",
              additionalProperties: { type: "string" },
              description: 'CSS variable keys or named UI slots to colors, e.g. { "--accent": "#64748b", "assistantMessage": "rgba(255,182,193,0.20)", "userMessage": "rgba(255,182,193,0.28)" }.'
            },
            slots: {
              type: "object",
              additionalProperties: { type: "string" },
              description: 'Named UI areas to recolor without knowing CSS variables, e.g. { "sidebar": "#ffb3d9", "userMessage": "rgba(236, 72, 153, 0.16)", "editor": "#050505", "text": "#111827" }.'
            }
          },
          required: [],
          additionalProperties: true
        }
      }
    };
  }
  buildSetCustomThemeTool() {
    return {
      type: "function",
      function: {
        name: "set_custom_theme",
        description: "Preferred tool for custom theme requests. Sets a complete Custom theme from semantic palette + mode, replacing old custom colors so leftover tokens do not clash. Pass **palette** explicitly (red, pink, purple, blue, green, orange, slate, white, ice, kiwi)—required for correct hue: e.g. **red** is not **pink**. **Mystic:** With Mystic chat background on, the app picks the light Mystic (ice) art for light custom themes and dark Mystic (neon) for dark; chat/thread tokens from this theme tint on top—optionally refine with merge_custom_theme_tokens on chatThread and bubbles. Use merge_custom_theme_tokens only for advanced exact tweaks.",
        parameters: {
          type: "object",
          properties: {
            palette: {
              type: "string",
              enum: [...SEMANTIC_CUSTOM_THEME_PALETTE_IDS],
              description: "Main color family. **red** = true red/crimson (not pink). **pink** = pink/rose/magenta/fuchsia. **purple**, **blue**, **green**, **orange**, **slate**, **white** (paper), **ice**, **kiwi** as usual."
            },
            mode: {
              type: "string",
              enum: [...SEMANTIC_CUSTOM_THEME_MODE_IDS],
              description: "Use light for bright/pastel/white UI, dark for deep/night/black UI. Omit if the user did not specify."
            },
            description: {
              type: "string",
              description: "Short copy of the user request, e.g. “completely pink theme”. Helps fallback routing."
            }
          },
          required: ["palette"],
          additionalProperties: false
        }
      }
    };
  }
  buildWebSearchTool() {
    return {
      type: "function",
      function: {
        name: "web_search",
        description: "Look up public web information via DuckDuckGo (short instant answers, definitions, and a few links—not full page text). Prefer compact queries with distinctive keywords, exact error text in quotes, product/version names, or a year for current events. If the first result is empty or unhelpful, call again with rephrased or narrower terms before concluding failure. Does not read the user’s project; in Agent mode use file tools for local code.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "One focused search string (not a long paragraph unless needed). Use keywords, quoted phrases, years, or official product/repo names; avoid vague one-word questions unless they are unambiguous."
            }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    };
  }
  buildToolDefinitions(settings, runtime) {
    const tools = [];
    if (settings.ui.webSearch) {
      tools.push(this.buildWebSearchTool());
    }
    if (settings.ui.sessionMode === "talk") {
      return tools;
    }
    tools.push(this.buildSetCustomThemeTool());
    tools.push(this.buildSetAppThemeTool());
    tools.push(this.buildMergeCustomThemeTokensTool());
    tools.push(this.buildGetAppThemeTool());
    tools.push(this.buildGetToolAccessTool());
    tools.push(this.buildGetSystemPromptTool());
    tools.push(this.buildRevertAppThemeTool());
    if (settings.tools.allowModelSystemPrompt) {
      tools.push({
        type: "function",
        function: {
          name: "set_system_prompt",
          description: "Replace the entire system prompt for the **currently selected** LLM provider in Settings. Use only when the user clearly wants their assistant instructions updated. Saves immediately; applies on the next user message. Disabled unless the user turns on “AI can change system prompt” in Settings → Tool access.",
          parameters: {
            type: "object",
            properties: {
              system_prompt: {
                type: "string",
                description: "Full new system prompt text (replaces the previous one for this provider)."
              }
            },
            required: ["system_prompt"],
            additionalProperties: false
          }
        }
      });
    }
    if (runtime.wizardId) {
      tools.push(this.buildGetWizardSystemPromptTool());
      tools.push({
        type: "function",
        function: {
          name: "set_wizard_system_prompt",
          description: "Replace this Wizard’s private system prompt only—not the global LLM provider preset in Settings. Use when the user clearly asks to change this Wizard’s own long-term instructions. Mythra shows a before/after approval dialog automatically. Independent of Settings → Tool access → “AI can change system prompt” (that toggle applies only to `set_system_prompt`, which is not offered in Wizard chats). Never paste Mythra Agent routing text from this chat into system_prompt—only persona/editor-style instructions.",
          parameters: {
            type: "object",
            properties: {
              system_prompt: {
                type: "string",
                description: "Full new Wizard-only prompt text (persona / instructions like in the Wizard settings editor). Must not include hidden `[Mythra model routing` blocks, `[Mythra] Thread id` lines, tool/workspace listings from Agent routing, or other pasted system-injection text—only user-facing Wizard instructions."
              }
            },
            required: ["system_prompt"],
            additionalProperties: false
          }
        }
      });
      tools.push({
        type: "function",
        function: {
          name: "set_wizard_display_name",
          description: "Change this Wizard’s **display name** in Mythra (sidebar list, chat subtitle, Inspector Wizard settings header). Does not edit soul.md or the stored system prompt—after renaming here, update soul.md (identity heading/text) and use `set_wizard_system_prompt` if your instructions still mention the old name so everything stays consistent.",
          parameters: {
            type: "object",
            properties: {
              display_name: {
                type: "string",
                description: "New short display name for this Wizard (shown in the UI)."
              }
            },
            required: ["display_name"],
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
    const toolPathPropDesc = wizardOutsideOn ? "Relative workspace path, ../ segment, or absolute local path (Wizard “Allow paths outside workspace” is on). Cloud-sync folders are blocked." : wizardOutsideOff ? "Relative path inside this Wizard workspace. For files elsewhere, ask the user to enable **Allow paths outside workspace** in Wizard settings." : "Relative path inside the workspace.";
    const readFileToolDesc = wizardOutsideOn ? "Read UTF-8 text; paths may be workspace-relative, ../ to reach sibling folders, or absolute local paths." : wizardOutsideOff ? "Read UTF-8 text using a path relative to this Wizard workspace only. If the user needs another Wizard’s folder or arbitrary paths, tell them to enable **Allow paths outside workspace** in Wizard settings (Inspector)." : "Read a UTF-8 text file using a path relative to the current workspace root.";
    const writeFileToolDesc = wizardOutsideOn ? "Create or overwrite UTF-8 text (creates parent folders). Paths may escape the workspace folder when this Wizard setting allows it—local disks only." : wizardOutsideOff ? "Create or overwrite UTF-8 inside this Wizard workspace. For targets outside it, ask the user to enable **Allow paths outside workspace**." : "Create or overwrite UTF-8 inside the workspace (creates parent folders).";
    const replaceInFileToolDesc = wizardOutsideOn ? "Replace exact text inside one UTF-8 file. Use after read_file. Paths may use ../ or absolute local targets when allowed (cloud-sync blocked). Set replace_all only when every occurrence should change." : wizardOutsideOff ? "Replace exact text inside one UTF-8 file under this Wizard workspace unless the user enables **Allow paths outside workspace**. Use after read_file." : "Replace exact text inside one UTF-8 file. Use for small, precise edits after read_file. Set replace_all only when every occurrence should change.";
    const insertAfterToolDesc = wizardOutsideOn ? "Insert text immediately after an exact anchor string in one UTF-8 file (paths may escape workspace when allowed)." : wizardOutsideOff ? "Insert text after an anchor in one UTF-8 file under this Wizard workspace unless **Allow paths outside workspace** is enabled." : "Insert text immediately after an exact anchor string in one UTF-8 file.";
    const renameFileToolDesc = wizardOutsideOn ? "Move or rename a local file or folder; from/to paths follow write_file rules." : wizardOutsideOff ? "Move or rename inside this Wizard workspace unless the user enables **Allow paths outside workspace**." : "Move or rename a file or folder inside the current workspace.";
    const deletePathToolDesc = wizardOutsideOn ? "Delete a local file or folder; path follows write_file rules." : wizardOutsideOff ? "Delete inside this Wizard workspace unless **Allow paths outside workspace** is enabled." : "Delete a file or folder inside the current workspace.";
    if (settings.tools.workspaceSearch) {
      tools.push({
        type: "function",
        function: {
          name: "list_files",
          description: "List files and directories under the current workspace root only. Does not include other folders on disk or other Wizards’ workspaces.",
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
          description: readFileToolDesc,
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: toolPathPropDesc
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
            name: "apply_patch",
            description: 'Apply a unified diff with `git apply` from the workspace root. The patch must be valid standard unified diff text only (---/+++/@@ lines, context lines starting with a single space). Context must match the file exactly or git fails with "corrupt patch". Always read_file first. If unsure, use replace_in_file or write_file instead.',
            parameters: {
              type: "object",
              properties: {
                patch: {
                  type: "string",
                  description: "Full unified diff as plain text (same as stdin to `git -C <workspace> apply --whitespace=nowarn -`). No markdown fences. Paths like --- a/src/file.ext / +++ b/src/file.ext relative to workspace root."
                }
              },
              required: ["patch"],
              additionalProperties: false
            }
          }
        },
        {
          type: "function",
          function: {
            name: "write_file",
            description: writeFileToolDesc,
            parameters: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: toolPathPropDesc
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
            name: "replace_in_file",
            description: replaceInFileToolDesc,
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: toolPathPropDesc },
                search: { type: "string", description: "Exact text to find." },
                replacement: { type: "string", description: "Replacement text." },
                replace_all: { type: "boolean", description: "Replace every occurrence instead of just the first." }
              },
              required: ["path", "search", "replacement"],
              additionalProperties: false
            }
          }
        },
        {
          type: "function",
          function: {
            name: "insert_after",
            description: insertAfterToolDesc,
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: toolPathPropDesc },
                anchor: { type: "string", description: "Exact text to insert after." },
                text: { type: "string", description: "Text to insert." }
              },
              required: ["path", "anchor", "text"],
              additionalProperties: false
            }
          }
        },
        {
          type: "function",
          function: {
            name: "rename_file",
            description: renameFileToolDesc,
            parameters: {
              type: "object",
              properties: {
                from: { type: "string", description: toolPathPropDesc },
                to: { type: "string", description: toolPathPropDesc }
              },
              required: ["from", "to"],
              additionalProperties: false
            }
          }
        },
        {
          type: "function",
          function: {
            name: "delete_path",
            description: deletePathToolDesc,
            parameters: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: toolPathPropDesc
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
      tools.push(
        {
          type: "function",
          function: {
            name: "get_git_diff",
            description: "Return git status and the current unstaged diff for the active workspace. Use after edits before summarizing changes.",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false
            }
          }
        },
        {
          type: "function",
          function: {
            name: "run_tests",
            description: "Run the project test/build/check command in the current workspace. Prefer this over run_command for verification.",
            parameters: {
              type: "object",
              properties: {
                command: {
                  type: "string",
                  description: "Test/check/build command to run, e.g. npm run check. If omitted, Mythra tries npm test."
                }
              },
              additionalProperties: false
            }
          }
        },
        {
          type: "function",
          function: {
            name: "run_command",
            description: "Run a shell command inside the current workspace and return stdout, stderr, and exit status. Use for commands not covered by run_tests or get_git_diff.",
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
        }
      );
    }
    if (settings.tools.workspaceSearch) {
      tools.push(
        {
          type: "function",
          function: {
            name: "search_symbols",
            description: "Search likely code symbols/declarations across the workspace. Use before reading many files when looking for a function, class, component, type, or constant.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "Symbol or text to search for." },
                limit: { type: "number", description: "Maximum results, default 50." }
              },
              required: ["query"],
              additionalProperties: false
            }
          }
        },
        {
          type: "function",
          function: {
            name: "get_file_outline",
            description: "Return top-level functions/classes/types/constants for a source file (path rules match read_file for this session).",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: toolPathPropDesc }
              },
              required: ["path"],
              additionalProperties: false
            }
          }
        }
      );
    }
    return tools;
  }
  threadPreamble(runtime) {
    const id = runtime.conversationId?.trim();
    if (!id) return "";
    return [
      `[Mythra] Thread id: ${id}. The messages in this request are the only history you see for this turn—other saved chats in the app are not included.`,
      "If the user just started a new chat, this thread is a fresh session; there are no prior turns in this list unless the user (or you in this thread) put them there.",
      ""
    ].join("\n");
  }
  async buildSessionContext(settings, runtime) {
    if (settings.ui.sessionMode === "talk") {
      const toolLine = settings.ui.webSearch ? 'Chat mode: the `web_search` tool is available for public web lookup while "Web" is enabled in the chat header. You have no read/write for local files, workspace listing, or shell—even if a folder shows in the UI (ignore it for local work).' : 'Chat mode: you have no tools until the user turns on "Web" in the chat header (then only `web_search` is available). You cannot read/write local files, search the workspace, or run shell commands.';
      return this.threadPreamble(runtime) + [
        '[Mythra model routing — Chat mode. This is a second system message; it is not shown in the user’s chat transcript. Do not tell the user about "hidden" or internal prompts; describe behavior in plain terms. If they need Agent (files, shell, workspace tools), tell them they can switch using the Chat/Agent control at the top of the chat window, or Session mode under Theme in Settings—either place works.]',
        sessionModeUiStateLine(settings.ui.sessionMode),
        toolLine,
        webHeaderUiStateLine(settings.ui.webSearch),
        ...settings.ui.webSearch ? [mythraWebSearchToolRoutingHint] : [],
        "For editing files, running commands, or searching the open project, they must be in Agent mode (same two places: top of chat, or Settings → Theme → Session mode). If the user needs that, say so in plain language.",
        mythraProductFeaturesInstruction,
        mythraSessionModeEmbedInstruction,
        mythraWebSearchEmbedInstruction,
        mythraThemeInChatModeInstruction,
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
        "[Mythra model routing — Agent mode, no workspace. This system message is not in the user’s visible transcript. Do not tell the user about internal prompts.]",
        sessionModeUiStateLine(settings.ui.sessionMode),
        "No workspace folder is open. You cannot use file or shell tools on disk until the user opens one from the sidebar. You can still answer generally.",
        "If they only want casual chat without tools, they can switch to Chat mode with the Chat/Agent control at the top of the chat, or Session mode under Theme in Settings.",
        mythraSessionModeEmbedInstruction,
        mythraWebSearchEmbedInstruction,
        mythraSetAppThemeAgentInstruction,
        mythraToolAccessReadInstruction,
        mythraProductFeaturesInstruction,
        ...agentModeSystemPromptInstructions(settings, runtime),
        webLine,
        webHeaderUiStateLine(settings.ui.webSearch),
        ...settings.ui.webSearch ? [mythraWebSearchToolRoutingHint] : []
      ].join("\n");
    }
    const files = await this.workspaceService.listFiles(runtime.workspaceRoot);
    const visibleFiles = files.slice(0, 140).map((entry) => `${entry.type === "directory" ? "[dir]" : "[file]"} ${entry.path}`).join("\n");
    const enabledTools = [
      "set_custom_theme",
      "set_app_theme",
      "merge_custom_theme_tokens",
      "get_app_theme",
      "get_tool_access",
      "get_system_prompt",
      "revert_app_theme",
      settings.ui.webSearch ? "web_search" : null,
      settings.tools.workspaceSearch ? "list_files" : null,
      settings.tools.workspaceSearch ? "search_symbols, get_file_outline" : null,
      settings.tools.fileRead ? "read_file" : null,
      settings.tools.fileWrite ? "apply_patch, replace_in_file, insert_after, rename_file, write_file, delete_path" : null,
      settings.tools.commandDeck ? "get_git_diff, run_tests, run_command" : null,
      settings.tools.allowModelSystemPrompt ? "set_system_prompt" : null,
      runtime.wizardId ? "get_wizard_system_prompt, set_wizard_system_prompt, set_wizard_display_name" : null
    ].filter(Boolean).join(", ");
    return [
      "[Mythra model routing — Agent mode. The user does not see this system message. Do not tell the user about “internal” or “hidden” prompts.]",
      sessionModeUiStateLine(settings.ui.sessionMode),
      "Converse like a normal assistant: friendly, direct, and human. Do not act like a project manager or ask for a “task”, “autonomous objective”, or “objective in todo” unless the user is clearly scoping a multi-step build.",
      "Agent mode only means: when the user wants something that requires the repo, files, or the shell, you *may* use the tools below. For greetings, chit-chat, and general Q&A, answer normally and use zero tools unless reading a file is genuinely required to help.",
      "If the user wants to use only Chat mode (no file/shell tools), they can switch with the Chat/Agent control at the top of the chat or under Theme → Session mode in Settings.",
      mythraSessionModeEmbedInstruction,
      mythraWebSearchEmbedInstruction,
      webHeaderUiStateLine(settings.ui.webSearch),
      mythraSetAppThemeAgentInstruction,
      mythraToolAccessReadInstruction,
      mythraProductFeaturesInstruction,
      ...agentModeSystemPromptInstructions(settings, runtime),
      mythraCodingToolInstruction,
      `Workspace root: ${runtime.workspaceRoot}`,
      `Active file: ${runtime.activeFilePath ? relative(runtime.workspaceRoot, runtime.activeFilePath) : "none"}`,
      `Enabled tools: ${enabledTools || "none"}`,
      `Approval: ${this.effectiveFullAccess(settings, runtime) ? "writes/commands/system prompt runs without per-action approval" : "user approval may be required for some writes, deletes, commands, and system prompt changes"}.`,
      runtime.wizardId ? "Wizard prompt edits (set_wizard_system_prompt) always use the built-in before/after approval dialog regardless of global Tool access." : "",
      runtime.wizardId ? runtime.wizardAllowOutsideWorkspace ? "Wizard **Allow paths outside workspace** is ON: read/write/replace/insert/rename/delete/get_file_outline may target ../ segments or absolute local paths (cloud-sync folders remain blocked). list_files, search_symbols, apply_patch, get_git_diff, run_tests, and run_command stay scoped to this Wizard’s workspace folder only." : "Wizard path-based file tools default to this workspace folder only. If the user wants reads/writes elsewhere on disk (another Wizard folder, home directory, etc.), tell them to enable **Allow paths outside workspace** for this Wizard in Inspector → Wizard settings. Until then Mythra rejects paths outside the workspace—even with approval. To reuse another Wizard’s docs without that setting, suggest copying files here or opening that Wizard’s session." : "",
      `In one user message you may get several model turns: use tools when needed, then reply in plain language. Step cap per message: about ${settings.agent.maxAutoSteps} tool rounds.`,
      "If the user asks what you can do, say you can both chat and (when it helps) use the listed tools on the open workspace—without sounding like you will always run a task.",
      ...settings.ui.webSearch ? [mythraWebSearchToolRoutingHint] : [],
      "Visible workspace entries (truncated):",
      visibleFiles || "[workspace appears empty]"
    ].join("\n");
  }
  async executeToolCall(window, requestId, settings, runtime, toolCall, args) {
    const workspaceRoot = runtime.workspaceRoot;
    if (toolCall.function.name === "web_search") {
      if (!settings.ui.webSearch) {
        throw new Error("Web search is turned off. Enable the Web toggle in the chat header to search online.");
      }
      const query = String(args.query ?? "").trim();
      if (!query) {
        throw new Error("web_search requires a non-empty query.");
      }
      return await searchWeb(query, settings.search);
    }
    if (toolCall.function.name === "set_app_theme") {
      if (settings.ui.sessionMode === "talk") {
        throw new Error(
          "set_app_theme is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again."
        );
      }
      if (!this.applyAppTheme) {
        throw new Error("Theme changes are not available in this build.");
      }
      const themeId = String(args.theme_id ?? "").trim();
      if (!isPresetThemeId(themeId)) {
        throw new Error(`Invalid theme_id. Use one of: ${PRESET_THEME_IDS.join(", ")} (use merge_custom_theme_tokens for custom colors).`);
      }
      const result = await this.applyAppTheme(themeId);
      this.patchSettingsThemeFromToolResult(settings, result);
      return result;
    }
    if (toolCall.function.name === "merge_custom_theme_tokens") {
      if (settings.ui.sessionMode === "talk") {
        throw new Error(
          "merge_custom_theme_tokens is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again."
        );
      }
      if (!this.mergeCustomThemeTokens) {
        throw new Error("Custom theme merges are not available in this build.");
      }
      const result = await this.mergeCustomThemeTokens(args);
      this.patchSettingsThemeFromToolResult(settings, result);
      return result;
    }
    if (toolCall.function.name === "set_custom_theme") {
      if (settings.ui.sessionMode === "talk") {
        throw new Error(
          "set_custom_theme is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again."
        );
      }
      if (!this.setCustomTheme) {
        throw new Error("Custom theme changes are not available in this build.");
      }
      const result = await this.setCustomTheme(args);
      this.patchSettingsThemeFromToolResult(settings, result);
      return result;
    }
    if (toolCall.function.name === "get_app_theme") {
      if (settings.ui.sessionMode === "talk") {
        throw new Error(
          "get_app_theme is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again."
        );
      }
      if (!this.getAppThemeState) {
        throw new Error("Theme state is not available in this build.");
      }
      return this.getAppThemeState();
    }
    if (toolCall.function.name === "get_tool_access") {
      if (settings.ui.sessionMode === "talk") {
        throw new Error(
          "get_tool_access is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again."
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
            fileRead: "Read files",
            fileWrite: "Write files",
            workspaceSearch: "Workspace search",
            commandDeck: "Command deck",
            allowModelSystemPrompt: "AI can change system prompt"
          }
        },
        null,
        2
      );
    }
    if (toolCall.function.name === "get_wizard_system_prompt") {
      if (settings.ui.sessionMode === "talk") {
        throw new Error(
          "get_wizard_system_prompt is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again."
        );
      }
      if (!runtime.wizardId) {
        throw new Error("get_wizard_system_prompt is only available inside a Wizard session.");
      }
      const full = runtime.wizardSystemPrompt ?? "";
      const MAX_PREVIEW = 24e3;
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
    if (toolCall.function.name === "get_system_prompt") {
      if (settings.ui.sessionMode === "talk") {
        throw new Error(
          "get_system_prompt is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again."
        );
      }
      const kind = settings.selectedProvider;
      const provider = settings.providers[kind];
      const full = provider.systemPrompt ?? "";
      const MAX_PREVIEW = 24e3;
      const truncated = full.length > MAX_PREVIEW;
      const system_prompt = truncated ? truncate(full, MAX_PREVIEW) : full;
      const preset = provider.activePromptPresetId == null ? { id: "draft", label: "Draft" } : (() => {
        const row = provider.promptPresets.find((x) => x.id === provider.activePromptPresetId);
        return {
          id: provider.activePromptPresetId,
          label: row?.name ?? "Preset"
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
    if (toolCall.function.name === "revert_app_theme") {
      if (settings.ui.sessionMode === "talk") {
        throw new Error(
          "revert_app_theme is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again."
        );
      }
      if (!this.applyAppTheme || !this.getAppThemeState) {
        throw new Error("Theme changes are not available in this build.");
      }
      let state;
      try {
        state = JSON.parse(this.getAppThemeState());
      } catch {
        throw new Error("Could not read theme state.");
      }
      if (!state.canRevert || !state.previousThemeId || !isThemeId(state.previousThemeId)) {
        throw new Error(
          "No previous theme to revert to. The app remembers one step back after a theme change in Settings or via set_app_theme."
        );
      }
      const result = await this.applyAppTheme(state.previousThemeId);
      this.patchSettingsThemeFromToolResult(settings, result);
      return result;
    }
    if (toolCall.function.name === "set_system_prompt") {
      if (settings.ui.sessionMode === "talk") {
        throw new Error(
          "set_system_prompt is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again."
        );
      }
      if (!settings.tools.allowModelSystemPrompt) {
        throw new Error(
          "Changing the system prompt from the model is turned off. The user can enable “AI can change system prompt” under Settings → Tool access."
        );
      }
      if (!this.persistAppSettings) {
        throw new Error("System prompt updates are not available in this build.");
      }
      const system_prompt = String(args.system_prompt ?? "");
      if (!system_prompt.trim()) {
        throw new Error("set_system_prompt requires a non-empty system_prompt string.");
      }
      const MAX_SYSTEM_PROMPT = 12e4;
      if (system_prompt.length > MAX_SYSTEM_PROMPT) {
        throw new Error(`system_prompt is too long (max ${MAX_SYSTEM_PROMPT} characters).`);
      }
      const providerKind = settings.selectedProvider;
      await this.requestApprovalIfNeeded(
        window,
        requestId,
        settings,
        runtime,
        "Approve system prompt change",
        `The model wants to replace the **${providerKind}** system prompt (${system_prompt.length} characters).

Preview:
${truncate(system_prompt, 900)}`
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
          message: "System prompt saved for the active provider. It applies on the next message."
        },
        null,
        2
      );
    }
    if (toolCall.function.name === "set_wizard_system_prompt") {
      if (!runtime.wizardId) {
        throw new Error("set_wizard_system_prompt is only available inside a Wizard session.");
      }
      if (!this.persistWizardSystemPrompt) {
        throw new Error("Wizard system prompt updates are not available in this build.");
      }
      const system_prompt = String(args.system_prompt ?? "");
      if (!system_prompt.trim()) {
        throw new Error("set_wizard_system_prompt requires a non-empty system_prompt string.");
      }
      const MAX_SYSTEM_PROMPT = 12e4;
      if (system_prompt.length > MAX_SYSTEM_PROMPT) {
        throw new Error(`system_prompt is too long (max ${MAX_SYSTEM_PROMPT} characters).`);
      }
      const leaked = wizardPromptLooksLikeInjectedRouting(system_prompt);
      if (leaked) {
        throw new Error(
          `set_wizard_system_prompt contained pasted Mythra routing text (${leaked}). Put only this Wizard’s authored instructions—use read_file on soul.md or workspace docs for facts, then edit minimally. Remove any blocks matching hidden Agent routing (e.g. lines beginning with “[Mythra model routing” or “[Mythra] Thread id”).`
        );
      }
      const before = runtime.wizardSystemPrompt ?? "";
      this.emitActivity(window, requestId, "approval", "Approve Wizard system prompt change: waiting for user approval.");
      if (this.requestWizardPromptApproval) {
        await this.requestWizardPromptApproval(window, runtime.wizardName ?? "Wizard", before, system_prompt);
      } else {
        await this.requestApproval(
          window,
          `Approve ${runtime.wizardName ?? "Wizard"} prompt change`,
          [
            "The Wizard wants to replace its private system prompt.",
            "",
            "ORIGINAL SYSTEM PROMPT",
            truncate(before || "[empty]", 1500),
            "",
            "→ NEW SYSTEM PROMPT",
            truncate(system_prompt, 1500)
          ].join("\n")
        );
      }
      await this.persistWizardSystemPrompt(runtime.wizardId, system_prompt);
      runtime.wizardSystemPrompt = system_prompt;
      return JSON.stringify(
        {
          ok: true,
          wizardId: runtime.wizardId,
          length: system_prompt.length,
          message: "Wizard system prompt saved. It applies on the next message."
        },
        null,
        2
      );
    }
    if (toolCall.function.name === "set_wizard_display_name") {
      if (settings.ui.sessionMode === "talk") {
        throw new Error(
          "set_wizard_display_name is only available in Agent mode. Ask the user to switch with the Chat/Agent control or Session mode in Settings, then try again."
        );
      }
      if (!runtime.wizardId) {
        throw new Error("set_wizard_display_name is only available inside a Wizard session.");
      }
      if (!this.persistWizardDisplayName) {
        throw new Error("Wizard display name updates are not available in this build.");
      }
      const raw = String(args.display_name ?? "");
      const display_name = raw.replace(/[\u0000-\u001f]/g, "").trim();
      if (!display_name) {
        throw new Error("set_wizard_display_name requires a non-empty display_name.");
      }
      if (display_name.length > 120) {
        throw new Error("display_name is too long (max 120 characters).");
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
          message: "Wizard display name saved for the sidebar and Wizard settings. Mythra renames the workspace folder when needed so it matches your name. Update soul.md and call set_wizard_system_prompt if needed so your identity text matches."
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
        const file = await this.workspaceService.openFile(workspaceRoot, path, wizardAllowOutside);
        if (file.imagePreview && !file.content) {
          return JSON.stringify(
            {
              path: relative(workspaceRoot, file.path),
              kind: "image",
              mimeType: file.imagePreview.mimeType,
              note: "Binary image file. Preview it in the Editor tab; no text content is returned here."
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
      case "write_file": {
        if (!settings.tools.fileWrite) {
          throw new Error("The write_file tool is disabled in settings.");
        }
        const path = String(args.path ?? "");
        const content = String(args.content ?? "");
        if (!path) {
          throw new Error("write_file requires a path.");
        }
        let textDiff;
        try {
          const existing = await this.workspaceService.openFile(workspaceRoot, path, wizardAllowOutside);
          if (!existing.imagePreview) {
            textDiff = { before: existing.content, after: content };
          }
        } catch {
          textDiff = { before: "", after: content };
        }
        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          "Approve file write",
          textDiff ? `The model wants to create or overwrite this path:
${path}

Compare the previous file (left) to the proposed text (right).` : `The model wants to write (binary image or unreadable):
${path}

This will create or overwrite the file.`,
          textDiff
        );
        const file = await this.workspaceService.saveFile(workspaceRoot, path, content, wizardAllowOutside);
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
      case "apply_patch": {
        if (!settings.tools.fileWrite) {
          throw new Error("The apply_patch tool is disabled in settings.");
        }
        const patch = String(args.patch ?? "");
        if (!patch.trim()) {
          throw new Error("apply_patch requires a patch.");
        }
        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          "Approve patch",
          `The model wants to apply a patch inside:
${workspaceRoot}

Patch preview:
${truncate(patch, 2500)}`
        );
        const changes = await this.workspaceService.applyPatch(workspaceRoot, patch);
        window.webContents.send("workspace:changed", { root: workspaceRoot });
        return JSON.stringify({ ok: true, changes }, null, 2);
      }
      case "replace_in_file": {
        if (!settings.tools.fileWrite) {
          throw new Error("The replace_in_file tool is disabled in settings.");
        }
        const path = String(args.path ?? "");
        const search = String(args.search ?? "");
        const replacement = String(args.replacement ?? "");
        const replaceAll = Boolean(args.replace_all);
        if (!path) throw new Error("replace_in_file requires a path.");
        const file = await this.workspaceService.openFile(workspaceRoot, path, wizardAllowOutside);
        let textDiff;
        if (!file.imagePreview) {
          const before = file.content;
          if (!search) {
            throw new Error("Search text cannot be empty.");
          }
          const occurrences = before.split(search).length - 1;
          if (occurrences === 0) {
            throw new Error("Search text was not found.");
          }
          const after = replaceAll ? before.split(search).join(replacement) : before.replace(search, replacement);
          textDiff = { before, after };
        }
        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          "Approve file edit",
          textDiff ? `The model wants to replace text in:
${path}` : `The model wants to replace text in:
${path}

Search:
${truncate(search, 1200)}

Replacement:
${truncate(replacement, 1200)}`,
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
        window.webContents.send("workspace:changed", { root: workspaceRoot, fileWritten: result.path });
        return JSON.stringify(
          { ok: true, path: relative(workspaceRoot, result.path), replacements: result.replacements },
          null,
          2
        );
      }
      case "insert_after": {
        if (!settings.tools.fileWrite) {
          throw new Error("The insert_after tool is disabled in settings.");
        }
        const path = String(args.path ?? "");
        const anchor = String(args.anchor ?? "");
        const text = String(args.text ?? "");
        if (!path) throw new Error("insert_after requires a path.");
        if (!anchor) {
          throw new Error("Anchor text cannot be empty.");
        }
        const file = await this.workspaceService.openFile(workspaceRoot, path, wizardAllowOutside);
        let textDiff;
        if (!file.imagePreview) {
          const beforeContent = file.content;
          const index = beforeContent.indexOf(anchor);
          if (index < 0) {
            throw new Error("Anchor text was not found.");
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
          "Approve file insertion",
          textDiff ? `The model wants to insert text in:
${path}` : `The model wants to insert text in:
${path}

After:
${truncate(anchor, 1200)}

Insert:
${truncate(text, 1200)}`,
          textDiff
        );
        const result = await this.workspaceService.insertAfter(workspaceRoot, path, anchor, text, wizardAllowOutside);
        window.webContents.send("workspace:changed", { root: workspaceRoot, fileWritten: result.path });
        return JSON.stringify({ ok: true, path: relative(workspaceRoot, result.path) }, null, 2);
      }
      case "rename_file": {
        if (!settings.tools.fileWrite) {
          throw new Error("The rename_file tool is disabled in settings.");
        }
        const from = String(args.from ?? "");
        const to = String(args.to ?? "");
        if (!from || !to) throw new Error("rename_file requires from and to.");
        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          "Approve rename",
          `The model wants to rename:
${from}

to:
${to}`
        );
        const result = await this.workspaceService.renamePath(workspaceRoot, from, to, wizardAllowOutside);
        window.webContents.send("workspace:changed", { root: workspaceRoot, fileDeleted: result.from, fileWritten: result.to });
        return JSON.stringify(
          { ok: true, from: relative(workspaceRoot, result.from), to: relative(workspaceRoot, result.to) },
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
          runtime,
          "Approve delete",
          `The model wants to delete:
${path}

This cannot be undone from the app.`
        );
        const deleted = await this.workspaceService.deletePath(workspaceRoot, path, wizardAllowOutside);
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
      case "get_git_diff": {
        if (!settings.tools.commandDeck) {
          throw new Error("The get_git_diff tool is disabled in settings.");
        }
        return JSON.stringify(await this.workspaceService.getChanges(workspaceRoot), null, 2);
      }
      case "search_symbols": {
        if (!settings.tools.workspaceSearch) {
          throw new Error("The search_symbols tool is disabled in settings.");
        }
        const query = String(args.query ?? "");
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, args.limit)) : 50;
        return JSON.stringify({ ok: true, results: await this.workspaceService.searchSymbols(workspaceRoot, query, limit) }, null, 2);
      }
      case "get_file_outline": {
        if (!settings.tools.workspaceSearch) {
          throw new Error("The get_file_outline tool is disabled in settings.");
        }
        const path = String(args.path ?? "");
        if (!path) throw new Error("get_file_outline requires a path.");
        return JSON.stringify(
          { ok: true, ...await this.workspaceService.getFileOutline(workspaceRoot, path, wizardAllowOutside) },
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
          runtime,
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
      case "run_tests": {
        if (!settings.tools.commandDeck) {
          throw new Error("The run_tests tool is disabled in settings.");
        }
        const command = String(args.command ?? "").trim() || "npm test";
        await this.requestApprovalIfNeeded(
          window,
          requestId,
          settings,
          runtime,
          "Approve test command",
          `The model wants to run:
${command}

The command will execute inside:
${workspaceRoot}`
        );
        const signal = this.activeRequests.get(requestId)?.controller.signal;
        const result = await this.commandService.runAndCapture(command, workspaceRoot, 6e4, signal);
        return JSON.stringify(result, null, 2);
      }
      default:
        throw new Error(`Unknown tool: ${toolCall.function.name}`);
    }
  }
  patchSettingsThemeFromToolResult(settings, result) {
    try {
      const parsed = JSON.parse(result);
      if (!parsed.ok || !parsed.themeId || !isThemeId(parsed.themeId)) return;
      settings.ui.themeId = parsed.themeId;
      if (isPresetThemeId(parsed.themeId)) {
        delete settings.ui.customThemeTokens;
      } else if (parsed.customThemeTokens) {
        settings.ui.customThemeTokens = parsed.customThemeTokens;
      }
    } catch {
    }
  }
  effectiveFullAccess(settings, runtime) {
    if (runtime.nexusTeamFullAccess) {
      return true;
    }
    if (runtime.wizardId != null) {
      return Boolean(runtime.wizardFullAccess);
    }
    return settings.agent.fullAccess;
  }
  async resolveNexusLeaderToolApproval(settings, runtime, title, detail, textDiff, signal) {
    const kind = runtime.nexusLeaderProvider;
    const model = runtime.nexusLeaderModel?.trim();
    if (!kind || !model) {
      return false;
    }
    const profile = settings.providers[kind];
    if (!profile?.baseUrl?.trim()) {
      return false;
    }
    let body = truncate(detail, 12e3);
    if (textDiff) {
      body += `

--- proposed change (truncated) ---
Before:
${truncate(textDiff.before, 6e3)}

After:
${truncate(textDiff.after, 6e3)}`;
    }
    const leaderName = runtime.nexusLeaderName?.trim() || "Nexus leader";
    const client = createClient(settings, kind);
    const approvalSignal = mergeLeaderApprovalDeadline(signal, resolveLeaderApprovalWallMs());
    try {
      const completion = await client.chat.completions.create(
        {
          model,
          messages: [
            {
              role: "system",
              content: `You are ${leaderName}, the Nexus leader. Teammates proposed tool actions that require approval.

Reply with exactly one uppercase word: APPROVE or DENY.

Approve only when the action fits the Nexus mission, respects the shared workspace, and is not reckless. Deny unclear or destructive requests.`
            },
            {
              role: "user",
              content: `Approval title: ${title}

Details:
${body}`
            }
          ],
          max_tokens: 16,
          temperature: 0
        },
        approvalSignal ? { signal: approvalSignal } : signal ? { signal } : void 0
      );
      const raw = contentToString(completion.choices[0]?.message?.content ?? "").trim().toUpperCase();
      const token = raw.split(/\s+/)[0] ?? "";
      return token === "APPROVE";
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return false;
      }
      throw err;
    }
  }
  async requestApprovalIfNeeded(window, requestId, settings, runtime, title, detail, textDiff) {
    if (this.effectiveFullAccess(settings, runtime)) {
      return;
    }
    if (runtime.nexusLeaderApprovesTools && runtime.nexusLeaderProvider && runtime.nexusLeaderModel?.trim()) {
      this.emitActivity(window, requestId, "approval", `${title}: Nexus leader reviewing…`);
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
        throw new Error("Nexus leader denied this tool action.");
      }
      return;
    }
    this.emitActivity(window, requestId, "approval", `${title}: waiting for user approval.`);
    await this.requestApproval(window, title, detail, textDiff);
  }
  async requestApproval(window, title, detail, textDiff) {
    if (!this.requestToolApprovalUi) {
      throw new Error("Tool approval UI is not wired.");
    }
    await this.requestToolApprovalUi(window, title, detail, textDiff);
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
const defaultSettings = {
  selectedProvider: "lmstudio",
  providers: {
    lmstudio: {
      kind: "lmstudio",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "lm-studio",
      model: "",
      systemPrompt: "",
      activePromptPresetId: null,
      promptPresets: [],
      appName: "Mythra",
      appUrl: "https://example.local"
    },
    openrouter: {
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      model: "",
      systemPrompt: "",
      activePromptPresetId: null,
      promptPresets: [],
      appName: "Mythra",
      appUrl: "https://example.local"
    }
  },
  search: {
    provider: "duckduckgo",
    tavilyApiKey: "",
    braveApiKey: ""
  },
  tools: {
    fileRead: true,
    fileWrite: true,
    workspaceSearch: true,
    commandDeck: true,
    allowModelSystemPrompt: false
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
    favoriteModels: { lmstudio: [], openrouter: [] },
    wizardProjectsParentFolder: null,
    onboardingCompleted: false,
    chatThreadBackgroundPreset: "mystic",
    chatThreadBackgroundPath: null
  },
  lastWorkspaceRoot: null
};
function mysticVariantForTheme(themeId, customThemeLight) {
  switch (themeId) {
    case "neon-grid":
      return "neon";
    case "sunset-terminal":
      return "sunset";
    case "ice-station":
      return "ice";
    case "kiwi":
      return "kiwi";
    case "custom":
      return customThemeLight ? "ice" : "neon";
  }
}
function isChatThreadBackgroundPresetId(value) {
  return value === "mystic";
}
function isSavedPromptPresetList(v) {
  return Array.isArray(v) && v.every(
    (x) => x != null && typeof x === "object" && typeof x.id === "string" && typeof x.name === "string" && typeof x.prompt === "string" && typeof x.updatedAt === "number"
  );
}
function rawHasPromptPresetsKey(raw) {
  return Object.prototype.hasOwnProperty.call(raw, "promptPresets");
}
function normalizeProviderProfile(defaults, saved) {
  const raw = saved ?? {};
  const base = { ...defaults, ...raw };
  if (rawHasPromptPresetsKey(raw) && isSavedPromptPresetList(raw.promptPresets)) {
    const v = raw.activePromptPresetId;
    const activePromptPresetId2 = typeof v === "string" ? v : null;
    return {
      kind: base.kind ?? defaults.kind,
      baseUrl: typeof base.baseUrl === "string" ? base.baseUrl : defaults.baseUrl,
      apiKey: typeof base.apiKey === "string" ? base.apiKey : defaults.apiKey,
      model: typeof base.model === "string" ? base.model : defaults.model,
      systemPrompt: typeof base.systemPrompt === "string" ? base.systemPrompt : defaults.systemPrompt,
      activePromptPresetId: activePromptPresetId2,
      promptPresets: raw.promptPresets,
      appName: typeof base.appName === "string" ? base.appName : defaults.appName,
      appUrl: typeof base.appUrl === "string" ? base.appUrl : defaults.appUrl
    };
  }
  const promptPresets = isSavedPromptPresetList(raw.customPromptPresets) ? raw.customPromptPresets : [];
  const oldPid = raw.promptPresetId;
  const oldA = raw.activeCustomPresetId;
  let activePromptPresetId = null;
  if (oldPid === "custom") {
    activePromptPresetId = typeof oldA === "string" ? oldA : null;
  } else {
    activePromptPresetId = null;
  }
  return {
    kind: base.kind ?? defaults.kind,
    baseUrl: typeof base.baseUrl === "string" ? base.baseUrl : defaults.baseUrl,
    apiKey: typeof base.apiKey === "string" ? base.apiKey : defaults.apiKey,
    model: typeof base.model === "string" ? base.model : defaults.model,
    systemPrompt: typeof base.systemPrompt === "string" ? base.systemPrompt : defaults.systemPrompt,
    activePromptPresetId,
    promptPresets,
    appName: typeof base.appName === "string" ? base.appName : defaults.appName,
    appUrl: typeof base.appUrl === "string" ? base.appUrl : defaults.appUrl
  };
}
const SETTINGS_FILE = "mythra-settings.json";
const LEGACY_SETTINGS_FILES = ["openkiwi-settings.json", "pixel-forge-settings.json"];
function normalizeMergedSearch(saved) {
  const base = { ...defaultSettings.search, ...saved };
  let provider = typeof base.provider === "string" ? base.provider : defaultSettings.search.provider;
  if (provider === "tavily") provider = "tavily_then_brave";
  if (provider === "brave") provider = "brave_then_tavily";
  if (provider !== "duckduckgo" && provider !== "tavily_then_brave" && provider !== "brave_then_tavily") {
    provider = defaultSettings.search.provider;
  }
  return {
    provider,
    tavilyApiKey: typeof base.tavilyApiKey === "string" ? base.tavilyApiKey : "",
    braveApiKey: typeof base.braveApiKey === "string" ? base.braveApiKey : ""
  };
}
const mergeSettings = (saved) => ({
  ...defaultSettings,
  ...saved,
  lastWorkspaceRoot: typeof saved?.lastWorkspaceRoot === "string" && saved.lastWorkspaceRoot.trim().length > 0 ? saved.lastWorkspaceRoot.trim() : null,
  providers: {
    lmstudio: normalizeProviderProfile(
      defaultSettings.providers.lmstudio,
      saved?.providers?.lmstudio
    ),
    openrouter: normalizeProviderProfile(
      defaultSettings.providers.openrouter,
      saved?.providers?.openrouter
    )
  },
  search: normalizeMergedSearch(saved?.search),
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
    chatThreadBackgroundPreset: saved?.ui?.chatThreadBackgroundPreset != null && isChatThreadBackgroundPresetId(String(saved.ui.chatThreadBackgroundPreset)) ? saved.ui.chatThreadBackgroundPreset : saved?.ui?.chatThreadBackgroundPreset === null ? null : typeof saved?.ui?.chatThreadBackgroundPath === "string" && saved.ui.chatThreadBackgroundPath.trim().length > 0 ? null : defaultSettings.ui.chatThreadBackgroundPreset,
    chatThreadBackgroundPath: typeof saved?.ui?.chatThreadBackgroundPath === "string" && saved.ui.chatThreadBackgroundPath.trim().length > 0 ? saved.ui.chatThreadBackgroundPath.trim() : null,
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
  async load() {
    const pathsToTry = [this.path, ...LEGACY_SETTINGS_FILES.map((f) => join$1(this.userData, f))];
    for (const tryPath of pathsToTry) {
      try {
        const raw = await readFile(tryPath, "utf8");
        const merged = mergeSettings(JSON.parse(raw));
        if (tryPath !== this.path && !existsSync(this.path)) {
          try {
            await mkdir(dirname(this.path), { recursive: true });
            await writeFile(this.path, JSON.stringify(merged, null, 2), "utf8");
          } catch {
          }
        }
        return merged;
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
function sanitizeWizardFolderSegment(name) {
  return name.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/\s+/g, " ").slice(0, 80).trim() || "Mythra Wizard";
}
const IGNORED_DIRS = /* @__PURE__ */ new Set([".git", "node_modules", ".next", "dist", "out", "build", "coverage"]);
const MAX_TREE_DEPTH = 10;
const MAX_LIST_DEPTH = 24;
const MAX_TREE_ENTRIES = 2500;
const MAX_LIST_ENTRIES = 5e3;
const MAX_SEARCH_FILES = 1500;
const MAX_SEARCH_FILE_BYTES = 5e5;
const MAX_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024;
const MAX_MYTHWIZ_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_MYTHWIZ_FILES = 1e3;
const MAX_MYTHWIZ_FILE_CHARS = 5 * 1024 * 1024;
const MAX_MYTHWIZ_TOTAL_CHARS = 25 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const WIZARD_CORE_DOCS = [
  ["soul.md", "Soul"],
  ["tools.md", "Tools"],
  ["memory.md", "Memory"],
  ["corrections.md", "Corrections"]
];
const WIZARD_DEFAULT_CONTENT = {
  "soul.md": (name) => `# ${name}

Describe this Wizard's identity, tone, principles, strengths, boundaries, and working style here.
`,
  "tools.md": () => `# Tools

## Mythra (this app)

- **Always** call \`read_file\` before editing so file content matches disk.
- **apply_patch**: unified diff only, valid for \`git apply\` from the Wizard workspace root. Context lines (those starting with a space) must match **exactly**—wrong spaces/tabs or stale lines cause \`corrupt patch\`. No markdown around the patch inside the tool JSON.
- If a patch fails, try a smaller hunk, \`replace_in_file\` for one exact match, or \`write_file\` for a full small file.
- Tools expect strict JSON (escaped newlines as \`\\n\` in strings).
- **Default core files** Mythra creates are only soul, tools, memory, and corrections—**not** \`todo.md\`. Add \`todo.md\` or any extra \`.md\` yourself if the user wants tasks, inboxes, or other always-loaded notes.

## Example directions (optional)

Users often dedicate a Wizard to: matching a **writing voice** (samples + soul); a **note system** (linked markdown in this folder); **one codebase or stack** (conventions here); or **research / meetings** (dated notes you maintain).

Describe your preferred stacks, scripts, test commands, and project conventions below.
`,
  "memory.md": () => `# Memory

Durable notes this Wizard should remember across sessions.
`,
  "corrections.md": () => `# Corrections

User corrections, mistakes to avoid, and lessons learned.
`
};
function soulMarkdownForWizard(name, personality) {
  const trimmed = personality?.trim();
  if (trimmed) {
    return `# ${name}

${trimmed}
`;
  }
  return WIZARD_DEFAULT_CONTENT["soul.md"](name);
}
function memoryMarkdownForWizard(memory) {
  const trimmed = memory?.trim();
  if (trimmed) {
    return `# Memory

${trimmed}
`;
  }
  return WIZARD_DEFAULT_CONTENT["memory.md"]("");
}
const normalizeDocName = (name) => {
  const base = name.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/^\.+/, "").slice(0, 80).trim();
  if (!base) return null;
  return base.toLowerCase().endsWith(".md") ? base : `${base}.md`;
};
const isLikelyCloudPath = (root) => {
  const normalized = resolve(root);
  const parts = normalized.split(sep).map((part) => part.toLowerCase());
  const lower = normalized.toLowerCase();
  return lower.includes(`${sep}library${sep}mobile documents${sep}`) || lower.includes(`${sep}library${sep}cloudstorage${sep}`) || parts.includes("dropbox") || parts.some((part) => part.startsWith("googledrive")) || parts.some((part) => part.startsWith("onedrive")) || parts.includes("google drive") || parts.includes("icloud drive");
};
const assertLocalWorkspace = (root) => {
  if (isLikelyCloudPath(root)) {
    throw new Error("Choose a local folder. Synced cloud folders can cause file conflicts while a Wizard is editing.");
  }
};
const spawnWithInput = (cmd, args, cwd, input) => new Promise((resolvePromise, reject) => {
  const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) resolvePromise();
    else reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
  });
  child.stdin.end(input);
});
const OUTSIDE_WORKSPACE_HINT = "Target path is outside the active workspace. Use paths relative to this workspace, or enable “Allow paths outside workspace” for this Wizard in Wizard settings (Inspector).";
const pathEquals = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const pathStartsWith = (target, root) => {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (process.platform === "win32") {
    return target.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return target.startsWith(prefix);
};
const pathInsideOrEqual = (target, root) => pathEquals(target, root) || pathStartsWith(target, root);
async function nearestExistingPath(absPath) {
  let current = absPath;
  for (; ; ) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
async function assertRealPathInsideRoot(resolvedRoot, resolvedTarget) {
  const realRoot = await realpath(resolvedRoot);
  const existing = await nearestExistingPath(resolvedTarget);
  const realExisting = await realpath(existing);
  if (!pathInsideOrEqual(realExisting, realRoot)) {
    throw new Error(OUTSIDE_WORKSPACE_HINT);
  }
}
async function resolveWorkspaceTarget(root, target, allowOutsideWorkspace = false) {
  const resolvedRoot = resolve(root.trim());
  const raw = target.trim();
  if (!raw) {
    throw new Error("Path cannot be empty.");
  }
  const isAbsolute = raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw);
  const resolvedTarget = isAbsolute ? resolve(raw) : resolve(resolvedRoot, raw);
  if (!allowOutsideWorkspace) {
    if (!pathInsideOrEqual(resolvedTarget, resolvedRoot)) {
      throw new Error(OUTSIDE_WORKSPACE_HINT);
    }
    await assertRealPathInsideRoot(resolvedRoot, resolvedTarget);
  }
  assertLocalWorkspace(dirname(resolvedTarget));
  return resolvedTarget;
}
const ensureInsideRoot = (root, target) => resolveWorkspaceTarget(root, target, false);
function isInsideRootSync(root, target) {
  try {
    const resolvedRoot = resolve(root.trim());
    const raw = target.trim();
    const isAbsolute = raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw);
    const resolvedTarget = isAbsolute ? resolve(raw) : resolve(resolvedRoot, raw);
    if (!pathInsideOrEqual(resolvedTarget, resolvedRoot)) return false;
    const realRoot = realpathSync(resolvedRoot);
    let current = resolvedTarget;
    for (; ; ) {
      try {
        statSync(current);
        const realExisting = realpathSync(current);
        return pathInsideOrEqual(realExisting, realRoot);
      } catch (error) {
        if (error.code !== "ENOENT") return false;
        const parent = dirname(current);
        if (parent === current) return false;
        current = parent;
      }
    }
  } catch {
    return false;
  }
}
const normalizeWizardExportRelPath = (raw) => {
  const posix = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = posix.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(`Invalid export path: ${raw}`);
  }
  return segments.join("/");
};
function zipEntryUncompressedSize(entry) {
  const data = entry._data;
  return typeof data?.uncompressedSize === "number" ? data.uncompressedSize : void 0;
}
function assertMythwizTextBudget(path, content, totalChars) {
  if (content.length > MAX_MYTHWIZ_FILE_CHARS) {
    throw new Error(`Import file is too large: ${path}`);
  }
  if (totalChars + content.length > MAX_MYTHWIZ_TOTAL_CHARS) {
    throw new Error("Import bundle is too large.");
  }
}
const sortNodes = (nodes) => nodes.sort((a, b) => {
  if (a.type !== b.type) {
    return a.type === "directory" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
});
const buildTree = async (root, depth = 0, budget = { remaining: MAX_TREE_ENTRIES }) => {
  if (depth > MAX_TREE_DEPTH || budget.remaining <= 0) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const nodes = await Promise.all(
    entries.filter((entry) => !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".DS_Store")).map(async (entry) => {
      if (budget.remaining <= 0) {
        return null;
      }
      budget.remaining -= 1;
      const fullPath = resolve(root, entry.name);
      if (entry.isDirectory()) {
        const node2 = {
          name: entry.name,
          path: fullPath,
          type: "directory",
          children: await buildTree(fullPath, depth + 1, budget)
        };
        return node2;
      }
      const node = {
        name: entry.name,
        path: fullPath,
        type: "file"
      };
      return node;
    })
  );
  return sortNodes(nodes.filter((node) => node != null));
};
const walkFiles = async (root, current, bucket, depth = 0) => {
  if (depth > MAX_LIST_DEPTH || bucket.length >= MAX_LIST_ENTRIES) {
    return;
  }
  const entries = await readdir(current, { withFileTypes: true });
  const sorted = entries.filter((entry) => !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".DS_Store")).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  for (const entry of sorted) {
    if (bucket.length >= MAX_LIST_ENTRIES) {
      return;
    }
    const fullPath = resolve(current, entry.name);
    const type = entry.isDirectory() ? "directory" : "file";
    bucket.push({ path: relative(root, fullPath) || ".", type });
    if (entry.isDirectory()) {
      await walkFiles(root, fullPath, bucket, depth + 1);
    }
  }
};
const RASTER_IMAGE_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif"
};
class WorkspaceService {
  async assertUsableLocalWorkspace(root) {
    const resolved = resolve(root);
    assertLocalWorkspace(resolved);
    const st = await stat(resolved);
    if (!st.isDirectory()) {
      throw new Error("Workspace path is not a folder.");
    }
    return resolved;
  }
  async chooseWorkspace() {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return this.assertUsableLocalWorkspace(result.filePaths[0]);
  }
  async chooseWizardWorkspace(defaultName, preferredDefaultPath) {
    let defaultPath = join$1(process.env.HOME ?? "", "Desktop", sanitizeWizardFolderSegment(defaultName));
    const trimmed = preferredDefaultPath?.trim();
    if (trimmed) {
      try {
        defaultPath = await this.assertUsableLocalWorkspace(trimmed);
      } catch {
      }
    }
    const result = await dialog.showOpenDialog({
      buttonLabel: "Use this folder",
      defaultPath,
      message: "Choose a local folder for this Wizard.",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    assertLocalWorkspace(result.filePaths[0]);
    return result.filePaths[0];
  }
  /** Pick the folder that will contain one subfolder per Wizard (`<parent>/<sanitized name>/`). */
  async chooseWizardProjectsFolder(preferredDefaultPath) {
    let defaultPath = join$1(process.env.HOME ?? "", "Desktop");
    const trimmed = preferredDefaultPath?.trim();
    if (trimmed) {
      try {
        defaultPath = await this.assertUsableLocalWorkspace(trimmed);
      } catch {
      }
    }
    const result = await dialog.showOpenDialog({
      buttonLabel: "Use this folder",
      defaultPath,
      message: "Choose a folder for Wizard workspaces. Each new Wizard will get its own subfolder inside here (named from the Wizard title).",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return this.assertUsableLocalWorkspace(result.filePaths[0]);
  }
  async chooseNexusWorkspace(preferredDefaultPath) {
    let defaultPath = join$1(process.env.HOME ?? "", "Desktop");
    const trimmed = preferredDefaultPath?.trim();
    if (trimmed) {
      try {
        defaultPath = await this.assertUsableLocalWorkspace(trimmed);
      } catch {
      }
    }
    const result = await dialog.showOpenDialog({
      buttonLabel: "Use this folder",
      defaultPath,
      message: "Choose a local project folder that the Nexus team will share.",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return this.assertUsableLocalWorkspace(result.filePaths[0]);
  }
  getRecommendedWizardWorkspace(name) {
    return join$1(process.env.HOME ?? "", "Desktop", sanitizeWizardFolderSegment(name));
  }
  async setupWizardWorkspace(request) {
    const name = request.name.trim();
    if (!name) {
      throw new Error("Wizard name is required.");
    }
    if (!request.model.trim()) {
      throw new Error("Choose a model for this Wizard.");
    }
    let parentDir;
    const ws = request.workspaceRoot?.trim();
    if (ws) {
      parentDir = resolve(ws);
    } else if (request.createOnDesktop) {
      parentDir = resolve(join$1(process.env.HOME ?? "", "Desktop"));
    } else {
      throw new Error(
        "Choose the folder where Wizard workspaces live. Each Wizard gets its own subfolder inside it."
      );
    }
    assertLocalWorkspace(parentDir);
    const parentStat = await stat(parentDir).catch(() => null);
    if (!parentStat?.isDirectory()) {
      throw new Error("Wizard workspaces folder must be an existing local folder.");
    }
    const childSegment = sanitizeWizardFolderSegment(name);
    const root = resolve(join$1(parentDir, childSegment));
    try {
      await stat(root);
      throw new Error(
        `A Wizard folder "${childSegment}" already exists in that location. Choose a different Wizard name, or delete or rename that folder.`
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("A Wizard folder")) {
        throw error;
      }
      if (error.code !== "ENOENT") throw error;
    }
    await mkdir(root, { recursive: true });
    for (const [file] of WIZARD_CORE_DOCS) {
      const target = join$1(root, file);
      const initialBody = file === "soul.md" ? soulMarkdownForWizard(name, request.wizardPersonality) : file === "memory.md" ? memoryMarkdownForWizard(request.wizardMemory) : WIZARD_DEFAULT_CONTENT[file](name);
      try {
        await writeFile(target, initialBody, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    const seen = new Set(WIZARD_CORE_DOCS.map(([file]) => file.toLowerCase()));
    for (const raw of request.customDocuments ?? []) {
      const file = normalizeDocName(raw);
      if (!file || seen.has(file.toLowerCase())) continue;
      seen.add(file.toLowerCase());
      const target = join$1(root, file);
      try {
        await writeFile(target, `# ${file.replace(/\.md$/i, "")}

`, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    if (request.mythwizWorkspaceFiles?.length) {
      if (request.mythwizWorkspaceFiles.length > MAX_MYTHWIZ_FILES) {
        throw new Error(`Import bundle has too many files (max ${MAX_MYTHWIZ_FILES}).`);
      }
      let importedChars = 0;
      for (const { relativePath, content } of request.mythwizWorkspaceFiles) {
        const safe = normalizeWizardExportRelPath(relativePath);
        assertMythwizTextBudget(safe, content, importedChars);
        importedChars += content.length;
        const abs = await ensureInsideRoot(root, safe);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
      }
    }
    const documents = await this.listWizardWorkspaceDocuments(root);
    const profile = {
      name,
      workspaceRoot: root,
      provider: request.provider,
      model: request.model,
      systemPrompt: request.systemPrompt,
      documents,
      fullAccess: false
    };
    return {
      profile,
      tree: await this.getTree(root)
    };
  }
  /**
   * All `.md` files under the Wizard workspace (recursive; skips ignored dirs like node_modules).
   * Core scaffold filenames first (in fixed order), then every other Markdown path sorted lexically.
   */
  async listWizardWorkspaceDocuments(workspaceRoot) {
    const resolved = resolve(workspaceRoot.trim());
    try {
      const st = await stat(resolved);
      if (!st.isDirectory()) throw new Error("Not a directory");
    } catch {
      throw new Error("Wizard workspace is not available.");
    }
    const bucket = [];
    await walkFiles(resolved, resolved, bucket);
    const coreMap = new Map(WIZARD_CORE_DOCS.map(([f, label]) => [f.toLowerCase(), label]));
    const coreOrder = WIZARD_CORE_DOCS.map(([f]) => f.toLowerCase());
    const mdRelPaths = bucket.filter((x) => x.type === "file" && /\.md$/i.test(x.path)).map((x) => x.path.replace(/\\/g, "/"));
    mdRelPaths.sort((a, b) => {
      const ba = basename(a).toLowerCase();
      const bb = basename(b).toLowerCase();
      const ia = coreOrder.indexOf(ba);
      const ib = coreOrder.indexOf(bb);
      if (ia !== -1 || ib !== -1) {
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        if (ia !== ib) return ia - ib;
        return a.localeCompare(b);
      }
      return a.localeCompare(b);
    });
    return mdRelPaths.map((rel) => {
      const abs = resolve(resolved, rel);
      const lower = basename(rel).toLowerCase();
      const label = coreMap.get(lower) ?? rel.replace(/\.md$/i, "");
      return {
        path: abs,
        label,
        core: coreMap.has(lower)
      };
    });
  }
  /** Relative POSIX paths of files under this Wizard workspace (for export UI). Ignores dotfiles and heavy dirs like node_modules. */
  async listWizardExportRelativeFiles(workspaceRoot) {
    const resolved = resolve(workspaceRoot.trim());
    assertLocalWorkspace(resolved);
    await stat(resolved);
    const bucket = [];
    await walkFiles(resolved, resolved, bucket);
    return bucket.filter((x) => x.type === "file").map((x) => x.path === "." ? "" : x.path.replace(/\\/g, "/")).filter((p) => p.length > 0).sort((a, b) => a.localeCompare(b));
  }
  async buildWizardMythwizArchive(req) {
    const root = resolve(req.workspaceRoot.trim());
    assertLocalWorkspace(root);
    await stat(root);
    let normalizedPaths;
    try {
      normalizedPaths = [...new Set(req.workspaceRelativePaths.map(normalizeWizardExportRelPath))];
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
    if (!req.includeSystemPromptFile && normalizedPaths.length === 0) {
      throw new Error("Select at least one item to export.");
    }
    const zip = new JSZip();
    const exportedAt = (/* @__PURE__ */ new Date()).toISOString();
    const missingFromDisk = [];
    const workspaceWritten = [];
    for (const rel of normalizedPaths) {
      try {
        const abs = await ensureInsideRoot(root, rel);
        await stat(abs);
        const buf = await readFile(abs);
        zip.file(`workspace/${rel}`, buf);
        workspaceWritten.push(rel);
      } catch {
        missingFromDisk.push(rel);
      }
    }
    if (missingFromDisk.length > 0) {
      throw new Error(`Could not read on disk: ${missingFromDisk.join(", ")}`);
    }
    if (req.includeSystemPromptFile) {
      zip.file("system_prompt.md", req.systemPrompt ?? "", { createFolders: false });
    }
    const manifest = {
      format: "mythwiz",
      version: 1,
      exportedAt,
      wizardDisplayName: req.wizardDisplayName,
      includesSystemPromptFile: Boolean(req.includeSystemPromptFile),
      workspacePaths: workspaceWritten
    };
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    const nodeBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return Buffer.from(nodeBuf);
  }
  /** Read a `.mythwiz` ZIP produced by Mythra export (manifest, optional system_prompt.md, and workspace/ files). */
  async parseWizardMythwizBuffer(buffer) {
    if (buffer.length > MAX_MYTHWIZ_ARCHIVE_BYTES) {
      throw new Error(`Import bundle is too large (max ${Math.round(MAX_MYTHWIZ_ARCHIVE_BYTES / 1024 / 1024)} MB).`);
    }
    const zip = await JSZip.loadAsync(buffer);
    const manifestFile = zip.file("manifest.json");
    if (!manifestFile) {
      throw new Error("This file has no manifest.json — pick a Mythra .mythwiz export.");
    }
    const manifestSize = zipEntryUncompressedSize(manifestFile);
    if (manifestSize != null && manifestSize > MAX_MYTHWIZ_FILE_CHARS) {
      throw new Error("manifest.json is too large.");
    }
    let manifest;
    try {
      manifest = JSON.parse(await manifestFile.async("string"));
    } catch {
      throw new Error("Could not parse manifest.json in this bundle.");
    }
    if (manifest.format !== "mythwiz") {
      throw new Error("This file is not a Mythra Wizard bundle.");
    }
    if (manifest.version !== 1) {
      throw new Error(`Unsupported mythwiz format version (${String(manifest.version)}).`);
    }
    let systemPrompt = "";
    const spFile = zip.file("system_prompt.md");
    if (spFile) {
      const systemPromptSize = zipEntryUncompressedSize(spFile);
      if (systemPromptSize != null && systemPromptSize > MAX_MYTHWIZ_FILE_CHARS) {
        throw new Error("system_prompt.md is too large.");
      }
      systemPrompt = await spFile.async("string");
      assertMythwizTextBudget("system_prompt.md", systemPrompt, 0);
    }
    const workspaceFiles = [];
    const prefix = "workspace/";
    let totalChars = systemPrompt.length;
    for (const [fullPath, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const normalizedZipPath = fullPath.replace(/\\/g, "/");
      if (!normalizedZipPath.startsWith(prefix)) continue;
      if (workspaceFiles.length >= MAX_MYTHWIZ_FILES) {
        throw new Error(`Import bundle has too many files (max ${MAX_MYTHWIZ_FILES}).`);
      }
      const inner = normalizedZipPath.slice(prefix.length);
      if (!inner) continue;
      let safeInner;
      try {
        safeInner = normalizeWizardExportRelPath(inner);
      } catch {
        continue;
      }
      const entrySize = zipEntryUncompressedSize(entry);
      if (entrySize != null && entrySize > MAX_MYTHWIZ_FILE_CHARS) {
        throw new Error(`Import file is too large: ${safeInner}`);
      }
      const text = await entry.async("string");
      assertMythwizTextBudget(safeInner, text, totalChars);
      totalChars += text.length;
      workspaceFiles.push({ relativePath: safeInner, content: text });
    }
    workspaceFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return {
      wizardDisplayName: (manifest.wizardDisplayName ?? "").trim() || "Imported Wizard",
      systemPrompt,
      workspaceFiles
    };
  }
  /**
   * Renames the wizard workspace directory when its basename does not match the sanitized display name.
   * Keeps the same parent folder; updates `workspaceRoot` and absolute paths in `documents`.
   */
  async ensureWizardWorkspaceFolderMatchesDisplayName(profile) {
    const oldRoot = resolve(profile.workspaceRoot.trim());
    assertLocalWorkspace(oldRoot);
    await stat(oldRoot);
    const parent = dirname(oldRoot);
    const desiredBase = sanitizeWizardFolderSegment(profile.name);
    const newRoot = resolve(join$1(parent, desiredBase));
    if (newRoot === oldRoot) {
      return profile;
    }
    let destInWay = false;
    try {
      await stat(newRoot);
      destInWay = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (destInWay) {
      throw new Error(
        `Cannot rename workspace folder to "${desiredBase}" — that name is already taken in this location. Use a different Wizard name or remove/rename the conflicting folder.`
      );
    }
    await rename(oldRoot, newRoot);
    return this.remapWizardProfileRoots(profile, oldRoot, newRoot);
  }
  remapWizardProfileRoots(profile, oldRoot, newRoot) {
    const oldR = resolve(oldRoot);
    const newR = resolve(newRoot);
    const prefix = oldR.endsWith(sep) ? oldR : `${oldR}${sep}`;
    return {
      ...profile,
      workspaceRoot: newR,
      documents: profile.documents.map((d) => {
        const abs = resolve(d.path);
        if (abs === oldR || abs.startsWith(prefix)) {
          return { ...d, path: join$1(newR, relative(oldR, abs)) };
        }
        return d;
      })
    };
  }
  async getTree(root) {
    await stat(root);
    return buildTree(root);
  }
  isInsideRoot(root, target) {
    return isInsideRootSync(root, target);
  }
  async openFile(root, target, allowOutsideWorkspace = false) {
    const safePath = await resolveWorkspaceTarget(root, target, allowOutsideWorkspace);
    const ext = extname(safePath).toLowerCase();
    if (ext === ".svg") {
      const st = await stat(safePath);
      if (st.size > MAX_IMAGE_PREVIEW_BYTES) {
        throw new Error(`Image preview is too large (max ${Math.round(MAX_IMAGE_PREVIEW_BYTES / 1024 / 1024)} MB).`);
      }
      const content2 = await readFile(safePath, "utf8");
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content2)}`;
      return {
        path: safePath,
        content: content2,
        imagePreview: { mimeType: "image/svg+xml", dataUrl }
      };
    }
    const rasterMime = RASTER_IMAGE_EXT[ext];
    if (rasterMime) {
      const st = await stat(safePath);
      if (st.size > MAX_IMAGE_PREVIEW_BYTES) {
        throw new Error(`Image preview is too large (max ${Math.round(MAX_IMAGE_PREVIEW_BYTES / 1024 / 1024)} MB).`);
      }
      const buf = await readFile(safePath);
      const dataUrl = `data:${rasterMime};base64,${buf.toString("base64")}`;
      return {
        path: safePath,
        content: "",
        imagePreview: { mimeType: rasterMime, dataUrl }
      };
    }
    const content = await readFile(safePath, "utf8");
    return { path: safePath, content };
  }
  async saveFile(root, target, content, allowOutsideWorkspace = false) {
    const safePath = await resolveWorkspaceTarget(root, target, allowOutsideWorkspace);
    await mkdir(dirname(safePath), { recursive: true });
    await writeFile(safePath, content, "utf8");
    return this.openFile(root, target, allowOutsideWorkspace);
  }
  async replaceInFile(root, target, search, replacement, replaceAll, allowOutsideWorkspace = false) {
    if (!search) {
      throw new Error("Search text cannot be empty.");
    }
    const safePath = await resolveWorkspaceTarget(root, target, allowOutsideWorkspace);
    const content = await readFile(safePath, "utf8");
    const count = content.split(search).length - 1;
    if (count === 0) {
      throw new Error("Search text was not found.");
    }
    const next = replaceAll ? content.split(search).join(replacement) : content.replace(search, replacement);
    await writeFile(safePath, next, "utf8");
    return { path: safePath, replacements: replaceAll ? count : 1 };
  }
  async insertAfter(root, target, anchor, text, allowOutsideWorkspace = false) {
    if (!anchor) {
      throw new Error("Anchor text cannot be empty.");
    }
    const safePath = await resolveWorkspaceTarget(root, target, allowOutsideWorkspace);
    const content = await readFile(safePath, "utf8");
    const index = content.indexOf(anchor);
    if (index < 0) {
      throw new Error("Anchor text was not found.");
    }
    const at = index + anchor.length;
    const next = `${content.slice(0, at)}${text}${content.slice(at)}`;
    await writeFile(safePath, next, "utf8");
    return { path: safePath };
  }
  async renamePath(root, from, to, allowOutsideWorkspace = false) {
    const safeFrom = await resolveWorkspaceTarget(root, from, allowOutsideWorkspace);
    const safeTo = await resolveWorkspaceTarget(root, to, allowOutsideWorkspace);
    await mkdir(dirname(safeTo), { recursive: true });
    await rename(safeFrom, safeTo);
    return { from: safeFrom, to: safeTo };
  }
  async deletePath(root, target, allowOutsideWorkspace = false) {
    const safePath = await resolveWorkspaceTarget(root, target, allowOutsideWorkspace);
    await rm(safePath, { recursive: true, force: false });
    return { path: safePath };
  }
  async deleteWorkspaceFolder(root) {
    const safePath = resolve(root);
    assertLocalWorkspace(safePath);
    await rm(safePath, { recursive: true, force: true });
    return { path: safePath };
  }
  async listFiles(root) {
    const files = [];
    await stat(root);
    await walkFiles(resolve(root), resolve(root), files);
    return files;
  }
  async getChanges(root) {
    const cwd = resolve(root);
    try {
      const [status, diff] = await Promise.all([
        execFileAsync("git", ["status", "--short"], { cwd, maxBuffer: 2e6 }),
        execFileAsync("git", ["diff", "--", "."], { cwd, maxBuffer: 8e6 })
      ]);
      return { ok: true, root: cwd, status: status.stdout, diff: diff.stdout };
    } catch (error) {
      return {
        ok: false,
        root: cwd,
        status: "",
        diff: "",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  async applyPatch(root, patch) {
    if (!patch.trim()) {
      throw new Error("Patch cannot be empty.");
    }
    const cwd = resolve(root);
    const applyHint = "\n\nHow to recover (Mythra uses `git apply` here): re-read the file with read_file; make every context line in the patch match the file exactly (including spaces/tabs); check @@ old/new line counts; keep paths as `a/rel/path` and `b/rel/path` under this folder; do not wrap the patch in markdown inside JSON. For one exact replacement use replace_in_file, or rewrite a small file with write_file.";
    try {
      await spawnWithInput("git", ["apply", "--whitespace=nowarn", "-"], cwd, patch);
    } catch (error) {
      const stderr = error instanceof Error ? error.message : String(error);
      if (/corrupt patch|does not apply|patch failed|unrecognized input|bogus|empty ident/i.test(stderr)) {
        throw new Error(`${stderr}${applyHint}`);
      }
      throw error instanceof Error ? new Error(`${stderr}${applyHint}`) : error;
    }
    return this.getChanges(root);
  }
  async searchSymbols(root, query, limit = 50) {
    const q = query.trim().toLowerCase();
    if (!q) {
      throw new Error("search_symbols requires a query.");
    }
    const files = (await this.listFiles(root)).filter((entry) => entry.type === "file").slice(0, MAX_SEARCH_FILES);
    const results = [];
    for (const entry of files) {
      if (results.length >= limit) break;
      const full = await ensureInsideRoot(root, entry.path);
      try {
        const s = await stat(full);
        if (s.size > MAX_SEARCH_FILE_BYTES) continue;
        const content = await readFile(full, "utf8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && results.length < limit; i += 1) {
          const line = lines[i];
          if (!line.toLowerCase().includes(q)) continue;
          if (!/\b(class|function|const|let|var|interface|type|enum|def|struct|export|import)\b/.test(line)) continue;
          results.push({ path: entry.path, line: i + 1, text: line.trim() });
        }
      } catch {
      }
    }
    return results;
  }
  async getFileOutline(root, target, allowOutsideWorkspace = false) {
    const safePath = await resolveWorkspaceTarget(root, target, allowOutsideWorkspace);
    const content = await readFile(safePath, "utf8");
    const ext = extname(safePath).toLowerCase();
    const lines = content.split(/\r?\n/);
    const patterns = ext === ".py" ? [/^\s*(?:async\s+)?def\s+([\w_]+)/, /^\s*class\s+([\w_]+)/] : [
      /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([\w$]+)/,
      /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=/,
      /^\s*(?:export\s+)?(?:interface|type|class|enum)\s+([\w$]+)/
    ];
    const outline = [];
    for (let i = 0; i < lines.length; i += 1) {
      for (const pattern of patterns) {
        const match = pattern.exec(lines[i]);
        if (match?.[1]) {
          outline.push({ line: i + 1, name: match[1], text: lines[i].trim() });
          break;
        }
      }
    }
    return { path: relative(resolve(root), safePath), outline };
  }
  labelForRoot(root) {
    return basename(root);
  }
}
const WATCH_IGNORE_SEGMENTS = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "out",
  "build",
  "coverage"
]);
const WATCH_DEBOUNCE_MS = 380;
const POLL_FALLBACK_MS = 2e3;
function shouldIgnoreWatchPath(rel) {
  if (rel == null || rel === "") return false;
  const norm = rel.replace(/\\/g, "/");
  for (const seg of norm.split("/")) {
    if (!seg) continue;
    if (seg === ".DS_Store" || seg === "Thumbs.db") return true;
    if (WATCH_IGNORE_SEGMENTS.has(seg)) return true;
  }
  return false;
}
function relToString(rel) {
  if (rel == null) return null;
  return typeof rel === "string" ? rel : rel.toString("utf8");
}
class WorkspaceWatchController {
  constructor(getWindow) {
    this.getWindow = getWindow;
  }
  getWindow;
  fsWatcher = null;
  pollTimer = null;
  emitTimer = null;
  stop() {
    if (this.emitTimer != null) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    if (this.pollTimer != null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.fsWatcher != null) {
      this.fsWatcher.removeAllListeners();
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }
  setRoot(root) {
    this.stop();
    const absRoot = resolve(root);
    const flush = () => {
      this.emitTimer = null;
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;
      win.webContents.send("workspace:changed", { root: absRoot });
    };
    const scheduleEmit = () => {
      if (this.emitTimer != null) clearTimeout(this.emitTimer);
      this.emitTimer = setTimeout(flush, WATCH_DEBOUNCE_MS);
    };
    const onFsEvent = (_evt, rel) => {
      const asStr = relToString(rel);
      if (shouldIgnoreWatchPath(asStr)) return;
      scheduleEmit();
    };
    let usedRecursive = false;
    try {
      this.fsWatcher = watch(absRoot, { recursive: true }, onFsEvent);
      usedRecursive = true;
    } catch {
      try {
        this.fsWatcher = watch(absRoot, onFsEvent);
      } catch {
        this.fsWatcher = null;
      }
    }
    this.fsWatcher?.on("error", () => scheduleEmit());
    if (!usedRecursive) {
      this.pollTimer = setInterval(scheduleEmit, POLL_FALLBACK_MS);
    }
  }
}
const CHAT_THREAD_BG_DIR = "chat-thread-backgrounds";
const MAX_CHAT_THREAD_BG_BYTES = 20 * 1024 * 1024;
const PENDING_WORKSPACE_DELETE_MS = 5 * 60 * 1e3;
function chatThreadBackgroundStoreRoot() {
  return join$1(app.getPath("userData"), CHAT_THREAD_BG_DIR);
}
function isPathInsideChatThreadBackgroundStore(absPath) {
  let root;
  let target;
  try {
    root = realpathSync(chatThreadBackgroundStoreRoot());
    target = realpathSync(resolve(absPath.trim()));
  } catch {
    root = resolve(chatThreadBackgroundStoreRoot());
    target = resolve(absPath.trim());
  }
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (process.platform === "win32") {
    const t = target.toLowerCase();
    const p = prefix.toLowerCase();
    return t === root.toLowerCase() || t.startsWith(p);
  }
  return target === root || target.startsWith(prefix);
}
const MYSTIC_BUNDLED_PATHS = {
  neon: mythraBgMysticNeon,
  sunset: mythraBgMysticSunset,
  ice: mythraBgMysticIce,
  kiwi: mythraBgMysticKiwi
};
function resolveReadChatThreadBackgroundFile(raw) {
  if (typeof raw === "string") {
    const p = resolve(raw.trim());
    if (!isPathInsideChatThreadBackgroundStore(p)) return null;
    return p;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw;
  if (o.source === "userFile") {
    const p = resolve(String(o.path).trim());
    if (!isPathInsideChatThreadBackgroundStore(p)) return null;
    return p;
  }
  if (o.source === "builtin" && o.presetId === "mystic") {
    if (!isThemeId(o.themeId)) return null;
    const variant = mysticVariantForTheme(o.themeId, o.customThemeLight);
    return MYSTIC_BUNDLED_PATHS[variant];
  }
  return null;
}
function imageMimeFromFilename(filename) {
  const ext = basename(filename).split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "jpg":
    case "jpeg":
    default:
      return "image/jpeg";
  }
}
const settingsStore = new SettingsStore();
const chatStore = new ChatStore();
const workspaceService = new WorkspaceService();
const commandService = new CommandService();
let mainWindow = null;
let activeWorkspaceRoot;
const workspaceWatch = new WorkspaceWatchController(() => {
  const w = mainWindow;
  return w && !w.isDestroyed() ? w : null;
});
let currentSettings = defaultSettings;
let previousThemeId;
const pendingWizardPromptApprovals = /* @__PURE__ */ new Map();
const pendingToolApprovals = /* @__PURE__ */ new Map();
const trustedWorkspaceRoots = /* @__PURE__ */ new Set();
const pendingWorkspaceDeleteRoots = /* @__PURE__ */ new Map();
const workspaceRootKey = async (root) => {
  const resolved = resolve(root.trim());
  const real = await realpath(resolved);
  return process.platform === "win32" ? real.toLowerCase() : real;
};
const trustWorkspaceRoot = async (root) => {
  const usable = await workspaceService.assertUsableLocalWorkspace(root);
  trustedWorkspaceRoots.add(await workspaceRootKey(usable));
  return usable;
};
const registerPendingWorkspaceDeleteRoot = async (root) => {
  if (!root?.trim()) return;
  let key;
  try {
    key = await workspaceRootKey(root);
  } catch {
    return;
  }
  const existing = pendingWorkspaceDeleteRoots.get(key);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    pendingWorkspaceDeleteRoots.delete(key);
  }, PENDING_WORKSPACE_DELETE_MS);
  timeout.unref?.();
  pendingWorkspaceDeleteRoots.set(key, timeout);
};
const registeredWorkspaceRootKeys = async () => {
  const roots = [];
  for (const chat of await chatStore.listChats()) {
    if (chat.kind === "wizard" && chat.wizard?.workspaceRoot) {
      roots.push(chat.wizard.workspaceRoot);
    }
    if (chat.kind === "nexus" && chat.nexus?.workspaceRoot) {
      roots.push(chat.nexus.workspaceRoot);
    }
  }
  const keys = /* @__PURE__ */ new Set();
  for (const root of roots) {
    try {
      keys.add(await workspaceRootKey(root));
    } catch {
    }
  }
  return keys;
};
const assertTrustedWorkspaceRoot = async (root) => {
  const usable = await workspaceService.assertUsableLocalWorkspace(root);
  const key = await workspaceRootKey(usable);
  if (trustedWorkspaceRoots.has(key)) return usable;
  const savedLast = currentSettings.lastWorkspaceRoot?.trim();
  if (savedLast) {
    try {
      if (await workspaceRootKey(savedLast) === key) return usable;
    } catch {
    }
  }
  if ((await registeredWorkspaceRootKeys()).has(key)) return usable;
  throw new Error("Workspace is not trusted. Use Open workspace or a saved Wizard/Nexus workspace to attach it.");
};
const assertRegisteredOrPendingDeleteRoot = async (root) => {
  const usable = await workspaceService.assertUsableLocalWorkspace(root);
  const key = await workspaceRootKey(usable);
  if ((await registeredWorkspaceRootKeys()).has(key) || pendingWorkspaceDeleteRoots.has(key)) {
    return { usable, key };
  }
  throw new Error("Workspace folder is not registered for deletion.");
};
const sameWorkspaceRoot = async (a, b) => {
  if (!a?.trim() || !b?.trim()) return false;
  try {
    return await workspaceRootKey(a) === await workspaceRootKey(b);
  } catch {
    return false;
  }
};
const assertSavedChatWorkspaceRootsAreTrusted = async (chat) => {
  const previous = await chatStore.loadChat(chat.id);
  if (chat.kind === "wizard" && chat.wizard?.workspaceRoot) {
    if (!await sameWorkspaceRoot(previous?.wizard?.workspaceRoot, chat.wizard.workspaceRoot)) {
      await assertTrustedWorkspaceRoot(chat.wizard.workspaceRoot);
    }
  }
  if (chat.kind === "nexus" && chat.nexus?.workspaceRoot) {
    if (!await sameWorkspaceRoot(previous?.nexus?.workspaceRoot, chat.nexus.workspaceRoot)) {
      await assertTrustedWorkspaceRoot(chat.nexus.workspaceRoot);
    }
  }
};
const recordThemeTransition = (from, to) => {
  if (from !== to) {
    previousThemeId = from;
  }
};
const applyAppTheme = async (rawId) => {
  if (!isThemeId(rawId)) {
    return JSON.stringify({
      ok: false,
      error: `Invalid theme_id. Presets: ${PRESET_THEME_IDS.join(", ")}. "custom" applies only when restoring the previous theme via revert_app_theme.`
    });
  }
  recordThemeTransition(currentSettings.ui.themeId, rawId);
  const nextUi = {
    ...currentSettings.ui,
    themeId: rawId,
    customThemeTokens: isPresetThemeId(rawId) ? void 0 : currentSettings.ui.customThemeTokens
  };
  currentSettings = await settingsStore.save({
    ...currentSettings,
    ui: nextUi
  });
  mainWindow?.webContents.send("settings:updated", currentSettings);
  const displayName = getThemeName(rawId);
  return JSON.stringify({
    ok: true,
    themeId: rawId,
    displayName,
    message: rawId === "custom" ? "Theme set to Custom." : `Theme set to ${displayName}.`
  });
};
const mergeCustomThemeTokens = async (incoming) => {
  const paletteHint = typeof incoming["palette"] === "string" ? incoming["palette"].trim() : void 0;
  const modeHint = typeof incoming["mode"] === "string" ? incoming["mode"].trim() : void 0;
  const descriptionHint = typeof incoming["description"] === "string" ? incoming["description"].trim() : void 0;
  const flat = flattenMergeThemeToolArgs(incoming);
  let partial = sanitizeCustomThemeTokens(flat);
  const hadUserTokens = Object.keys(partial).length > 0;
  let resolvedPaletteId;
  let semanticPaletteId;
  if (!hadUserTokens) {
    const paletteIsMergeFallback = paletteHint ? MERGE_THEME_PALETTE_IDS.includes(paletteHint) : false;
    if (paletteHint && !paletteIsMergeFallback && isSemanticCustomThemePaletteId(paletteHint)) {
      const semantic = buildSemanticCustomThemeTokens({
        palette: paletteHint,
        mode: modeHint,
        description: descriptionHint
      });
      const targetText = `${descriptionHint ?? ""} ${Object.keys(incoming).join(" ")}`.toLowerCase();
      const targetBubbles = /\b(chat\s*)?bubbles?\b|\b(user|assistant)\s*messages?\b/.test(targetText);
      partial = targetBubbles ? {
        "--chat-assistant-bg": semantic.tokens["--accent-subtle"],
        "--chat-user-bg": semantic.tokens["--accent-2-subtle"] ?? semantic.tokens["--accent-subtle"]
      } : { ...semantic.tokens };
      semanticPaletteId = semantic.palette;
    } else {
      const resolved = resolveCustomThemeFallback(paletteHint);
      partial = { ...resolved.tokens };
      resolvedPaletteId = resolved.id;
    }
  }
  const prev = currentSettings.ui.themeId;
  if (prev !== "custom") {
    recordThemeTransition(prev, "custom");
  }
  const existing = currentSettings.ui.customThemeTokens ?? {};
  const userWantsLightPaper = paletteHint === "light_paper_gray" || paletteHint?.toLowerCase().includes("light_paper_gray") || hadUserTokens && partial["--bg-0"] && isLikelyLightCssBackground(partial["--bg-0"]);
  let merged;
  if (hadUserTokens && userWantsLightPaper) {
    merged = { ...CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY, ...partial };
    resolvedPaletteId = resolvedPaletteId ?? "light_paper_gray";
  } else if (shouldReplaceFullCustomPalette(hadUserTokens, partial, resolvedPaletteId, partial["--bg-0"])) {
    merged = resolvedPaletteId === "light_paper_gray" ? { ...partial } : { ...existing, ...partial };
  } else {
    merged = { ...existing, ...partial };
  }
  currentSettings = await settingsStore.save({
    ...currentSettings,
    ui: {
      ...currentSettings.ui,
      themeId: "custom",
      customThemeTokens: merged
    }
  });
  mainWindow?.webContents.send("settings:updated", currentSettings);
  const message = hadUserTokens && userWantsLightPaper ? `Applied light paper + gray accent base with ${Object.keys(partial).length} token override(s).` : hadUserTokens ? `Applied ${Object.keys(partial).length} custom color override(s); theme set to Custom.` : semanticPaletteId ? `Applied semantic "${semanticPaletteId}" custom color fallback.` : `Applied built-in "${resolvedPaletteId}" palette (${paletteHint ? `hint: "${paletteHint}"` : "no palette hint"}).`;
  return JSON.stringify({
    ok: true,
    themeId: "custom",
    displayName: getThemeName("custom"),
    customThemeTokens: merged,
    usedFallbackPalette: !hadUserTokens,
    mergePaletteId: resolvedPaletteId,
    semanticPaletteId,
    message
  });
};
const setCustomTheme = async (incoming) => {
  const { tokens, palette, mode } = buildSemanticCustomThemeTokens({
    palette: typeof incoming.palette === "string" ? incoming.palette : void 0,
    mode: typeof incoming.mode === "string" ? incoming.mode : void 0,
    description: typeof incoming.description === "string" ? incoming.description : void 0,
    intensity: typeof incoming.intensity === "string" ? incoming.intensity : void 0
  });
  const prev = currentSettings.ui.themeId;
  if (prev !== "custom") {
    recordThemeTransition(prev, "custom");
  }
  currentSettings = await settingsStore.save({
    ...currentSettings,
    ui: {
      ...currentSettings.ui,
      themeId: "custom",
      customThemeTokens: tokens
    }
  });
  mainWindow?.webContents.send("settings:updated", currentSettings);
  return JSON.stringify({
    ok: true,
    themeId: "custom",
    displayName: getThemeName("custom"),
    customThemeTokens: tokens,
    semanticPalette: palette,
    semanticMode: mode,
    message: `Applied full custom ${mode} ${palette} theme.`
  });
};
const getAppThemeState = () => {
  const cur = currentSettings.ui.themeId;
  const prev = previousThemeId;
  const canRevert = prev != null && isThemeId(prev);
  return JSON.stringify({
    ok: true,
    themeId: cur,
    displayName: getThemeName(cur),
    previousThemeId: prev ?? null,
    previousDisplayName: prev != null ? getThemeName(prev) : null,
    canRevert
  });
};
const requestWizardPromptApproval = async (window, wizardName, before, after) => {
  const id = randomUUID();
  const payload = {
    id,
    title: `Approve ${wizardName} prompt change`,
    wizardName,
    before,
    after
  };
  const approved = await new Promise((resolveApproval) => {
    pendingWizardPromptApprovals.set(id, resolveApproval);
    window.webContents.send("wizard:prompt-approval-request", payload);
  });
  if (!approved) {
    throw new Error("Wizard system prompt change was denied by the user.");
  }
};
const requestToolApproval = async (window, title, detail, diff) => {
  const id = randomUUID();
  const payload = {
    id,
    title,
    detail,
    ...diff ? { diffBefore: diff.before, diffAfter: diff.after } : {}
  };
  const approved = await new Promise((resolveApproval) => {
    pendingToolApprovals.set(id, resolveApproval);
    window.webContents.send("tool:approval-request", payload);
  });
  if (!approved) {
    throw new Error(`${title} was denied by the user.`);
  }
};
const modelService = new ModelService(
  workspaceService,
  commandService,
  applyAppTheme,
  getAppThemeState,
  mergeCustomThemeTokens,
  setCustomTheme,
  async (updater) => {
    const next = updater(structuredClone(currentSettings));
    currentSettings = await settingsStore.save(next);
    mainWindow?.webContents.send("settings:updated", currentSettings);
    return currentSettings;
  },
  async (wizardId, systemPrompt) => {
    const chat = await chatStore.loadChat(wizardId);
    if (!chat || chat.kind !== "wizard" || !chat.wizard) {
      throw new Error("Wizard not found.");
    }
    await chatStore.saveChat({
      ...chat,
      updatedAt: Date.now(),
      wizard: {
        ...chat.wizard,
        systemPrompt
      }
    });
  },
  async (wizardId, displayName) => {
    const trimmed = displayName.trim();
    if (!trimmed || trimmed.length > 120) {
      throw new Error("Invalid Wizard display name.");
    }
    const chat = await chatStore.loadChat(wizardId);
    if (!chat || chat.kind !== "wizard" || !chat.wizard) {
      throw new Error("Wizard not found.");
    }
    const prevRoot = chat.wizard.workspaceRoot;
    const wizard = await workspaceService.ensureWizardWorkspaceFolderMatchesDisplayName({
      ...chat.wizard,
      name: trimmed
    });
    await chatStore.saveChat({
      ...chat,
      title: trimmed,
      titleOverride: trimmed,
      updatedAt: Date.now(),
      wizard
    });
    if (activeWorkspaceRoot && resolve(activeWorkspaceRoot) === resolve(prevRoot)) {
      activeWorkspaceRoot = wizard.workspaceRoot;
      workspaceWatch.setRoot(wizard.workspaceRoot);
    }
    const ls = currentSettings.lastWorkspaceRoot?.trim();
    if (ls && resolve(ls) === resolve(prevRoot)) {
      currentSettings = await settingsStore.save({
        ...currentSettings,
        lastWorkspaceRoot: wizard.workspaceRoot
      });
      mainWindow?.webContents.send("settings:updated", currentSettings);
    }
    mainWindow?.webContents.send("chats:updated");
    return wizard;
  },
  requestWizardPromptApproval,
  requestToolApproval
);
const assertActiveWorkspace = (root) => {
  if (!root) {
    throw new Error("No workspace is active.");
  }
  if (!activeWorkspaceRoot || resolve(root) !== resolve(activeWorkspaceRoot)) {
    throw new Error("Workspace is not active.");
  }
};
const sanitizeRuntime = (runtime) => {
  const workspaceRoot = runtime.workspaceRoot && activeWorkspaceRoot && resolve(runtime.workspaceRoot) === resolve(activeWorkspaceRoot) ? activeWorkspaceRoot : void 0;
  const activeFilePath = workspaceRoot && runtime.activeFilePath && workspaceService.isInsideRoot(workspaceRoot, runtime.activeFilePath) ? runtime.activeFilePath : void 0;
  return {
    workspaceRoot,
    activeFilePath,
    conversationId: runtime.conversationId,
    wizardId: typeof runtime.wizardId === "string" ? runtime.wizardId : void 0,
    wizardName: typeof runtime.wizardName === "string" ? runtime.wizardName : void 0,
    wizardSystemPrompt: typeof runtime.wizardSystemPrompt === "string" ? runtime.wizardSystemPrompt : void 0,
    wizardFullAccess: typeof runtime.wizardFullAccess === "boolean" ? runtime.wizardFullAccess : void 0,
    wizardAllowOutsideWorkspace: typeof runtime.wizardAllowOutsideWorkspace === "boolean" ? runtime.wizardAllowOutsideWorkspace : void 0,
    nexusTeamFullAccess: typeof runtime.nexusTeamFullAccess === "boolean" ? runtime.nexusTeamFullAccess : void 0,
    nexusLeaderApprovesTools: typeof runtime.nexusLeaderApprovesTools === "boolean" ? runtime.nexusLeaderApprovesTools : void 0,
    nexusLeaderProvider: runtime.nexusLeaderProvider === "lmstudio" || runtime.nexusLeaderProvider === "openrouter" ? runtime.nexusLeaderProvider : void 0,
    nexusLeaderModel: typeof runtime.nexusLeaderModel === "string" ? runtime.nexusLeaderModel : void 0,
    nexusLeaderName: typeof runtime.nexusLeaderName === "string" ? runtime.nexusLeaderName : void 0
  };
};
const sanitizeChatSettings = (requested) => ({
  ...requested,
  search: currentSettings.search,
  /** Use the renderer’s Tool access toggles so changes apply on the next message even before Save (disk is updated on Save). */
  tools: requested.tools,
  agent: currentSettings.agent,
  ui: {
    ...requested.ui,
    themeId: currentSettings.ui.themeId,
    customThemeTokens: currentSettings.ui.customThemeTokens,
    /** User toggles in the renderer header; trusting requested avoids a race vs main IPC. */
    favoriteModels: currentSettings.ui.favoriteModels
  }
});
const createWindow = async () => {
  const windowIcon = nativeImage.createFromPath(appIconPath);
  mainWindow = new BrowserWindow({
    width: 1580,
    height: 980,
    minWidth: 1280,
    minHeight: 760,
    title: "Mythra",
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
  workspaceWatch.stop();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
ipcMain.handle("settings:load", async () => {
  currentSettings = await settingsStore.load();
  return currentSettings;
});
ipcMain.handle("settings:save", async (_event, settings) => {
  const safe = isPresetThemeId(settings.ui.themeId) ? { ...settings, lastWorkspaceRoot: currentSettings.lastWorkspaceRoot, ui: { ...settings.ui, customThemeTokens: void 0 } } : { ...settings, lastWorkspaceRoot: currentSettings.lastWorkspaceRoot };
  const from = currentSettings.ui.themeId;
  const to = safe.ui.themeId;
  if (from !== to) {
    recordThemeTransition(from, to);
  }
  currentSettings = await settingsStore.save(safe);
  return currentSettings;
});
ipcMain.handle("workspace:choose", async () => {
  const root = await workspaceService.chooseWorkspace();
  if (!root) {
    return null;
  }
  await trustWorkspaceRoot(root);
  activeWorkspaceRoot = root;
  workspaceWatch.setRoot(root);
  currentSettings = await settingsStore.save({
    ...currentSettings,
    lastWorkspaceRoot: root
  });
  mainWindow?.webContents.send("settings:updated", currentSettings);
  return {
    root,
    label: basename(root),
    tree: await workspaceService.getTree(root)
  };
});
ipcMain.handle("workspace:open-last", async () => {
  const candidate = currentSettings.lastWorkspaceRoot?.trim();
  if (!candidate) {
    return null;
  }
  let root;
  try {
    root = await trustWorkspaceRoot(candidate);
  } catch {
    currentSettings = await settingsStore.save({
      ...currentSettings,
      lastWorkspaceRoot: null
    });
    mainWindow?.webContents.send("settings:updated", currentSettings);
    return null;
  }
  activeWorkspaceRoot = root;
  workspaceWatch.setRoot(root);
  return {
    root,
    label: basename(root),
    tree: await workspaceService.getTree(root)
  };
});
ipcMain.handle("workspace:last-valid-root", async () => {
  const candidate = currentSettings.lastWorkspaceRoot?.trim();
  if (!candidate) {
    return null;
  }
  try {
    return await workspaceService.assertUsableLocalWorkspace(candidate);
  } catch {
    return null;
  }
});
ipcMain.handle("workspace:activate", async (_event, root) => {
  const resolved = await assertTrustedWorkspaceRoot(root);
  activeWorkspaceRoot = resolved;
  workspaceWatch.setRoot(resolved);
  return {
    root: resolved,
    label: basename(resolved),
    tree: await workspaceService.getTree(resolved)
  };
});
ipcMain.handle("workspace:tree", async (_event, root) => {
  assertActiveWorkspace(root);
  return workspaceService.getTree(root);
});
ipcMain.handle("workspace:detach", async () => {
  workspaceWatch.stop();
  activeWorkspaceRoot = void 0;
});
ipcMain.handle("workspace:open-file", async (_event, root, target) => {
  assertActiveWorkspace(root);
  return workspaceService.openFile(root, target);
});
ipcMain.handle("workspace:save-file", async (_event, root, target, content) => {
  assertActiveWorkspace(root);
  return workspaceService.saveFile(root, target, content);
});
ipcMain.handle("workspace:changes", async (_event, root) => {
  assertActiveWorkspace(root);
  return workspaceService.getChanges(root);
});
ipcMain.handle(
  "wizard:recommended-workspace",
  async (_event, name) => workspaceService.getRecommendedWizardWorkspace(name)
);
ipcMain.handle("wizard:choose-workspace", async (_event, name, preferredDefaultPath) => {
  const root = await workspaceService.chooseWizardWorkspace(name, preferredDefaultPath);
  if (root) await trustWorkspaceRoot(root);
  return root;
});
ipcMain.handle("wizard:choose-projects-folder", async (_event, preferredDefaultPath) => {
  const root = await workspaceService.chooseWizardProjectsFolder(preferredDefaultPath);
  if (root) await trustWorkspaceRoot(root);
  return root;
});
ipcMain.handle("nexus:choose-workspace", async (_event, preferredDefaultPath) => {
  const root = await workspaceService.chooseNexusWorkspace(preferredDefaultPath);
  if (root) await trustWorkspaceRoot(root);
  return root;
});
ipcMain.handle("wizard:setup", async (_event, request) => {
  const result = await workspaceService.setupWizardWorkspace(request);
  await trustWorkspaceRoot(result.profile.workspaceRoot);
  activeWorkspaceRoot = result.profile.workspaceRoot;
  workspaceWatch.setRoot(result.profile.workspaceRoot);
  return result;
});
ipcMain.handle("wizard:sync-workspace-folder", async (_event, profile) => {
  const prevRoot = resolve(profile.workspaceRoot.trim());
  const updated = await workspaceService.ensureWizardWorkspaceFolderMatchesDisplayName(profile);
  await trustWorkspaceRoot(updated.workspaceRoot);
  if (resolve(prevRoot) !== resolve(updated.workspaceRoot)) {
    if (activeWorkspaceRoot && resolve(activeWorkspaceRoot) === prevRoot) {
      activeWorkspaceRoot = updated.workspaceRoot;
      workspaceWatch.setRoot(updated.workspaceRoot);
    }
    const ls = currentSettings.lastWorkspaceRoot?.trim();
    if (ls && resolve(ls) === prevRoot) {
      currentSettings = await settingsStore.save({
        ...currentSettings,
        lastWorkspaceRoot: updated.workspaceRoot
      });
      mainWindow?.webContents.send("settings:updated", currentSettings);
    }
  }
  return updated;
});
ipcMain.handle("wizard:delete-workspace", async (_event, root) => {
  const { usable, key } = await assertRegisteredOrPendingDeleteRoot(root);
  pendingWorkspaceDeleteRoots.delete(key);
  const deleted = await workspaceService.deleteWorkspaceFolder(usable);
  if (activeWorkspaceRoot && resolve(activeWorkspaceRoot) === resolve(deleted.path)) {
    activeWorkspaceRoot = void 0;
    workspaceWatch.stop();
  }
  return deleted;
});
ipcMain.handle("wizard:prompt-approval-response", async (_event, id, approved) => {
  const resolveApproval = pendingWizardPromptApprovals.get(id);
  if (!resolveApproval) return;
  pendingWizardPromptApprovals.delete(id);
  resolveApproval(Boolean(approved));
});
ipcMain.handle("tool:approval-response", async (_event, id, approved) => {
  const resolveApproval = pendingToolApprovals.get(id);
  if (!resolveApproval) return;
  pendingToolApprovals.delete(id);
  resolveApproval(Boolean(approved));
});
ipcMain.handle("wizard:list-documents", async (_event, root) => workspaceService.listWizardWorkspaceDocuments(root));
ipcMain.handle("wizard:read-document", async (_event, root, target) => {
  const resolvedRoot = resolve(root.trim());
  const chats = await chatStore.listChats();
  const normalizedRoot = resolvedRoot.toLowerCase();
  const isKnownWizardRoot = chats.some(
    (chat) => {
      if (chat.kind !== "wizard" || !chat.wizard) return false;
      if (chat.wizard.workspaceRoot && resolve(chat.wizard.workspaceRoot) === resolvedRoot) return true;
      const expectedFolder = sanitizeWizardFolderSegment(chat.wizard.name).toLowerCase();
      return (chat.wizard.documents ?? []).some((doc) => {
        let dir = dirname(resolve(doc.path));
        for (let depth = 0; depth < 16; depth += 1) {
          if (resolve(dir) === resolvedRoot && basename(dir).toLowerCase() === expectedFolder) return true;
          const parent = dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        return false;
      });
    }
  );
  if (!isKnownWizardRoot || normalizedRoot.includes("/library/cloudstorage/")) {
    throw new Error("Wizard workspace is not registered.");
  }
  return workspaceService.openFile(resolvedRoot, target, false);
});
ipcMain.handle(
  "wizard:list-export-files",
  async (_event, root) => workspaceService.listWizardExportRelativeFiles(root)
);
ipcMain.handle("wizard:export-mythwiz", async (event, req) => {
  const winSafe = BrowserWindow.fromWebContents(event.sender);
  const baseName = sanitizeWizardFolderSegment(req.wizardDisplayName.trim() || "wizard");
  const opts = {
    title: "Export Wizard",
    defaultPath: `${baseName}.mythwiz`,
    filters: [{ name: "Mythra Wizard bundle", extensions: ["mythwiz"] }]
  };
  const { canceled, filePath } = winSafe && !winSafe.isDestroyed() ? await dialog.showSaveDialog(winSafe, opts) : await dialog.showSaveDialog(opts);
  if (canceled || !filePath) {
    return { ok: false, cancelled: true };
  }
  try {
    const buf = await workspaceService.buildWizardMythwizArchive(req);
    await writeFile(filePath, buf);
    return { ok: true, path: filePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
});
ipcMain.handle("wizard:choose-import-mythwiz", async (event) => {
  const winSafe = BrowserWindow.fromWebContents(event.sender);
  const opts = {
    title: "Import Wizard bundle",
    properties: ["openFile"],
    filters: [{ name: "Mythra Wizard bundle", extensions: ["mythwiz"] }]
  };
  const pick = winSafe && !winSafe.isDestroyed() ? await dialog.showOpenDialog(winSafe, opts) : await dialog.showOpenDialog(opts);
  if (pick.canceled || pick.filePaths.length === 0) {
    return { ok: false, cancelled: true };
  }
  try {
    const st = await stat(pick.filePaths[0]);
    if (st.size > 50 * 1024 * 1024) {
      return { ok: false, error: "Import bundle is too large." };
    }
    const buf = await readFile(pick.filePaths[0]);
    const data = await workspaceService.parseWizardMythwizBuffer(buf);
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
});
ipcMain.handle("ui:choose-chat-thread-background", async (event) => {
  const winSafe = BrowserWindow.fromWebContents(event.sender);
  const opts = {
    title: "Chat thread background",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"] }]
  };
  const pick = winSafe && !winSafe.isDestroyed() ? await dialog.showOpenDialog(winSafe, opts) : await dialog.showOpenDialog(opts);
  if (pick.canceled || pick.filePaths.length === 0) {
    return { ok: false, cancelled: true };
  }
  const src = pick.filePaths[0];
  try {
    const st = await stat(src);
    if (!st.isFile()) {
      return { ok: false, error: "Not a file." };
    }
    if (st.size > MAX_CHAT_THREAD_BG_BYTES) {
      return { ok: false, error: `Image is too large (max ${Math.round(MAX_CHAT_THREAD_BG_BYTES / 1024 / 1024)} MB).` };
    }
    const safeBase = basename(src).replace(/[^a-zA-Z0-9._-]/g, "_") || "background";
    const destName = `${randomUUID()}-${safeBase}`;
    const destDir = chatThreadBackgroundStoreRoot();
    await mkdir(destDir, { recursive: true });
    const dest = join$1(destDir, destName);
    await copyFile(src, dest);
    return { ok: true, path: dest };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
});
ipcMain.handle("ui:read-chat-thread-background", async (_event, raw) => {
  const p = resolveReadChatThreadBackgroundFile(raw);
  if (!p) return { ok: false };
  try {
    const st = await stat(p);
    if (st.size > MAX_CHAT_THREAD_BG_BYTES) {
      return { ok: false };
    }
    const buf = await readFile(p);
    return {
      ok: true,
      mime: imageMimeFromFilename(p),
      dataBase64: buf.toString("base64")
    };
  } catch {
    return { ok: false };
  }
});
ipcMain.handle("shell:open-external", async (_event, rawUrl) => {
  if (typeof rawUrl !== "string") return;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
  await shell.openExternal(parsed.href);
});
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
      await modelService.streamChat(event, mainWindow, requestId, sanitizeChatSettings(settings), messages, sanitizeRuntime(runtime));
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
  if (cwd != null) {
    assertActiveWorkspace(cwd);
  }
  return commandService.run(mainWindow, command, cwd);
});
ipcMain.handle("commands:kill", async (_event, jobId) => commandService.kill(jobId));
ipcMain.handle("chats:list", async () => chatStore.listChats());
ipcMain.handle("chats:load", async (_event, id) => chatStore.loadChat(id));
ipcMain.handle("chats:save", async (_event, chat) => {
  await assertSavedChatWorkspaceRootsAreTrusted(chat);
  return chatStore.saveChat(chat);
});
ipcMain.handle("chats:delete", async (_event, id) => {
  const chat = await chatStore.loadChat(id);
  if (chat?.kind === "wizard") {
    await registerPendingWorkspaceDeleteRoot(chat.wizard?.workspaceRoot);
  }
  if (chat?.kind === "nexus") {
    await registerPendingWorkspaceDeleteRoot(chat.nexus?.workspaceRoot);
  }
  return chatStore.deleteChat(id);
});

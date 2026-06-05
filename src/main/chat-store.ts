import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { app } from 'electron';
import type { ChatAttachment, ChatSearchResult, CostDashboardSummary, ProviderKind, SavedChat, SavedChatMeta } from '@shared/types';

const CHATS_DIR = 'mythra-chats';
const GENERATED_MEDIA_DIR = 'generated-media';
const CHAT_INDEX_FILE = 'mythra-chat-index.json';
/** Older installs (OpenKiwi / Pixel Forge). */
const LEGACY_CHAT_DIRS = ['openkiwi-chats', 'pixel-forge-chats'] as const;
const CHAT_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;

interface ChatIndex {
  version: 1;
  chats: SavedChatMeta[];
}

const assertSafeChatId = (id: string) => {
  if (!CHAT_ID_RE.test(id)) {
    throw new Error('Invalid chat id.');
  }
};

export class ChatStore {
  private readonly userData = app.getPath('userData');
  private readonly dir = join(this.userData, CHATS_DIR);
  private readonly indexPath = join(this.userData, CHAT_INDEX_FILE);
  private readonly generatedMediaDir = join(this.userData, GENERATED_MEDIA_DIR);
  private legacyMigrated = false;

  private async migrateLegacyChatsIfNeeded() {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    try {
      const newHas =
        existsSync(this.dir) && (await readdir(this.dir)).some((f) => f.endsWith('.json'));
      if (newHas) return;

      for (const legacyName of LEGACY_CHAT_DIRS) {
        const legacyDir = join(this.userData, legacyName);
        if (!existsSync(legacyDir)) continue;
        const files = (await readdir(legacyDir)).filter((f) => f.endsWith('.json'));
        if (files.length === 0) continue;
        await mkdir(this.dir, { recursive: true });
        for (const f of files) {
          const dst = join(this.dir, f);
          if (!existsSync(dst)) await copyFile(join(legacyDir, f), dst);
        }
        break;
      }
    } catch {
      // non-fatal
    }
  }

  private async ensureDir() {
    await this.migrateLegacyChatsIfNeeded();
    await mkdir(this.dir, { recursive: true });
  }

  private chatToMeta(chat: SavedChat): SavedChatMeta {
    return {
      id: chat.id,
      kind: chat.kind ?? 'normal',
      title: chat.title,
      titleOverride: chat.titleOverride ?? null,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      pinned: chat.pinned ?? false,
      chatOrder: typeof chat.chatOrder === 'number' && Number.isFinite(chat.chatOrder) ? chat.chatOrder : null,
      modelOverride: chat.modelOverride ?? null,
      wizard: chat.wizard ?? null,
      wizardId: chat.wizardId ?? null,
      nexus: chat.nexus ?? null,
      nexusId: chat.nexusId ?? null
    };
  }

  private sortMetas(metas: SavedChatMeta[]) {
    return metas.sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      const aOrder = typeof a.chatOrder === 'number' && Number.isFinite(a.chatOrder) ? a.chatOrder : -a.updatedAt;
      const bOrder = typeof b.chatOrder === 'number' && Number.isFinite(b.chatOrder) ? b.chatOrder : -b.updatedAt;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return b.updatedAt - a.updatedAt;
    });
  }

  private async chatFileIds() {
    const files = await readdir(this.dir);
    return files
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -'.json'.length))
      .filter((id) => CHAT_ID_RE.test(id));
  }

  private async readIndexIfFresh(): Promise<SavedChatMeta[] | null> {
    try {
      const raw = await readFile(this.indexPath, 'utf8');
      const index = JSON.parse(raw) as ChatIndex;
      if (index.version !== 1 || !Array.isArray(index.chats)) return null;

      const idsOnDisk = new Set(await this.chatFileIds());
      const idsInIndex = new Set(index.chats.map((chat) => chat.id));
      if (idsOnDisk.size !== idsInIndex.size) return null;
      for (const id of idsOnDisk) {
        if (!idsInIndex.has(id)) return null;
      }

      return this.sortMetas([...index.chats]);
    } catch {
      return null;
    }
  }

  private async writeIndex(metas: SavedChatMeta[]) {
    const index: ChatIndex = { version: 1, chats: this.sortMetas([...metas]) };
    await writeFile(this.indexPath, JSON.stringify(index), 'utf8');
  }

  private async rebuildIndexFromChatFiles(): Promise<SavedChatMeta[]> {
    const metas: SavedChatMeta[] = [];
    for (const id of await this.chatFileIds()) {
      try {
        const raw = await readFile(join(this.dir, `${id}.json`), 'utf8');
        const chat = JSON.parse(raw) as SavedChat;
        metas.push(this.chatToMeta(chat));
      } catch {
        // skip corrupted files
      }
    }
    await this.writeIndex(metas).catch(() => undefined);
    return this.sortMetas(metas);
  }

  async listChats(): Promise<SavedChatMeta[]> {
    await this.ensureDir();
    return (await this.readIndexIfFresh()) ?? this.rebuildIndexFromChatFiles();
  }

  async loadChat(id: string): Promise<SavedChat | null> {
    try {
      assertSafeChatId(id);
      const raw = await readFile(join(this.dir, `${id}.json`), 'utf8');
      return JSON.parse(raw) as SavedChat;
    } catch {
      return null;
    }
  }

  async searchChats(query: string, limit = 30): Promise<ChatSearchResult[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    await this.ensureDir();
    const results: ChatSearchResult[] = [];
    for (const id of await this.chatFileIds()) {
      if (results.length >= limit) break;
      const chat = await this.loadChat(id);
      if (!chat) continue;
      const haystacks = [
        chat.title,
        chat.titleOverride ?? '',
        chat.wizard?.name ?? '',
        chat.nexus?.name ?? '',
        ...chat.messages.map((message) => message.content)
      ];
      const matches = haystacks.filter((text) => text.toLowerCase().includes(q));
      if (matches.length === 0) continue;
      const source = matches.find((text) => text.toLowerCase().includes(q)) ?? chat.title;
      const lower = source.toLowerCase();
      const at = Math.max(0, lower.indexOf(q));
      const start = Math.max(0, at - 80);
      const end = Math.min(source.length, at + q.length + 120);
      const snippet = `${start > 0 ? '...' : ''}${source.slice(start, end).replace(/\s+/g, ' ').trim()}${end < source.length ? '...' : ''}`;
      results.push({
        chatId: chat.id,
        title: chat.title,
        kind: chat.kind,
        updatedAt: chat.updatedAt,
        snippet,
        matchCount: matches.length
      });
    }
    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async costSummary(): Promise<CostDashboardSummary> {
    await this.ensureDir();
    const byModel = new Map<string, { provider: ProviderKind; model: string; messages: number; totalTokens: number; totalCostUsd: number }>();
    let chats = 0;
    let pricedMessages = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;
    for (const id of await this.chatFileIds()) {
      const chat = await this.loadChat(id);
      if (!chat) continue;
      chats += 1;
      for (const message of chat.messages) {
        const cost = message.costEstimate;
        if (!cost) continue;
        pricedMessages += 1;
        totalTokens += cost.totalTokens;
        totalCostUsd += cost.totalCostUsd;
        const key = `${cost.provider}:${cost.model}`;
        const row = byModel.get(key) ?? {
          provider: cost.provider,
          model: cost.model,
          messages: 0,
          totalTokens: 0,
          totalCostUsd: 0
        };
        row.messages += 1;
        row.totalTokens += cost.totalTokens;
        row.totalCostUsd += cost.totalCostUsd;
        byModel.set(key, row);
      }
    }
    return {
      chats,
      pricedMessages,
      totalTokens,
      totalCostUsd,
      byModel: [...byModel.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    };
  }

  async saveChat(chat: SavedChat): Promise<void> {
    assertSafeChatId(chat.id);
    await this.ensureDir();
    await writeFile(join(this.dir, `${chat.id}.json`), JSON.stringify(chat), 'utf8');
    const existing = (await this.readIndexIfFresh()) ?? (await this.rebuildIndexFromChatFiles());
    const next = existing.filter((meta) => meta.id !== chat.id);
    next.push(this.chatToMeta(chat));
    await this.writeIndex(next).catch(() => undefined);
  }

  private isInsideGeneratedMedia(path: string) {
    const root = resolve(this.generatedMediaDir);
    const target = resolve(path);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (process.platform === 'win32') {
      const rootLower = root.toLowerCase();
      const prefixLower = prefix.toLowerCase();
      const targetLower = target.toLowerCase();
      return targetLower === rootLower || targetLower.startsWith(prefixLower);
    }
    return target === root || target.startsWith(prefix);
  }

  private generatedMediaPathFromAttachment(attachment: ChatAttachment): string | null {
    if (attachment.filePath) {
      const path = resolve(attachment.filePath);
      return this.isInsideGeneratedMedia(path) ? path : null;
    }
    if (!attachment.dataUrl.startsWith('file:')) return null;
    try {
      const path = fileURLToPath(attachment.dataUrl);
      return this.isInsideGeneratedMedia(path) ? path : null;
    } catch {
      return null;
    }
  }

  private async deleteGeneratedMediaForChat(chat: SavedChat) {
    const attachmentPaths = new Set<string>();
    for (const message of chat.messages) {
      for (const attachment of message.attachments ?? []) {
        const path = this.generatedMediaPathFromAttachment(attachment);
        if (path) attachmentPaths.add(path);
      }
    }

    await Promise.all(
      [...attachmentPaths].map((path) => rm(path, { force: true, recursive: false }).catch(() => undefined))
    );

    await rm(join(this.generatedMediaDir, chat.id), { force: true, recursive: true }).catch(() => undefined);
  }

  async deleteChat(id: string): Promise<boolean> {
    try {
      assertSafeChatId(id);
      const chatPath = join(this.dir, `${id}.json`);
      let chat: SavedChat | null = null;
      try {
        chat = JSON.parse(await readFile(chatPath, 'utf8')) as SavedChat;
      } catch {
        chat = null;
      }
      if (chat) {
        await this.deleteGeneratedMediaForChat(chat);
      }
      await unlink(chatPath);
      const existing = await this.readIndexIfFresh();
      if (existing) {
        await this.writeIndex(existing.filter((meta) => meta.id !== id)).catch(() => undefined);
      }
      return true;
    } catch {
      return false;
    }
  }
}

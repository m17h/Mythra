import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { app } from 'electron';
import type { ChatAttachment, SavedChat, SavedChatMeta } from '@shared/types';

const CHATS_DIR = 'mythra-chats';
const GENERATED_MEDIA_DIR = 'generated-media';
/** Older installs (OpenKiwi / Pixel Forge). */
const LEGACY_CHAT_DIRS = ['openkiwi-chats', 'pixel-forge-chats'] as const;
const CHAT_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;

const assertSafeChatId = (id: string) => {
  if (!CHAT_ID_RE.test(id)) {
    throw new Error('Invalid chat id.');
  }
};

export class ChatStore {
  private readonly userData = app.getPath('userData');
  private readonly dir = join(this.userData, CHATS_DIR);
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

  async listChats(): Promise<SavedChatMeta[]> {
    await this.ensureDir();
    const files = await readdir(this.dir);
    const metas: SavedChatMeta[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.dir, file), 'utf8');
        const chat = JSON.parse(raw) as SavedChat;
        metas.push({
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
        });
      } catch {
        // skip corrupted files
      }
    }

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

  async loadChat(id: string): Promise<SavedChat | null> {
    try {
      assertSafeChatId(id);
      const raw = await readFile(join(this.dir, `${id}.json`), 'utf8');
      return JSON.parse(raw) as SavedChat;
    } catch {
      return null;
    }
  }

  async saveChat(chat: SavedChat): Promise<void> {
    assertSafeChatId(chat.id);
    await this.ensureDir();
    await writeFile(join(this.dir, `${chat.id}.json`), JSON.stringify(chat), 'utf8');
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
      return true;
    } catch {
      return false;
    }
  }
}

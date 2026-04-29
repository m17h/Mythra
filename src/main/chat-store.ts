import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type { SavedChat, SavedChatMeta } from '@shared/types';

const CHATS_DIR = 'openkiwi-chats';
const LEGACY_CHATS_DIR = 'pixel-forge-chats';
const CHAT_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;

const assertSafeChatId = (id: string) => {
  if (!CHAT_ID_RE.test(id)) {
    throw new Error('Invalid chat id.');
  }
};

export class ChatStore {
  private readonly userData = app.getPath('userData');
  private readonly dir = join(this.userData, CHATS_DIR);
  private readonly legacyDir = join(this.userData, LEGACY_CHATS_DIR);
  private legacyMigrated = false;

  private async migrateLegacyChatsIfNeeded() {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    try {
      const newHas =
        existsSync(this.dir) && (await readdir(this.dir)).some((f) => f.endsWith('.json'));
      if (newHas) return;
      if (!existsSync(this.legacyDir)) return;
      const files = (await readdir(this.legacyDir)).filter((f) => f.endsWith('.json'));
      if (files.length === 0) return;
      await mkdir(this.dir, { recursive: true });
      for (const f of files) {
        const dst = join(this.dir, f);
        if (!existsSync(dst)) await copyFile(join(this.legacyDir, f), dst);
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
          modelOverride: chat.modelOverride ?? null,
          wizard: chat.wizard ?? null,
          wizardId: chat.wizardId ?? null
        });
      } catch {
        // skip corrupted files
      }
    }

    return metas.sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
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

  async deleteChat(id: string): Promise<boolean> {
    try {
      assertSafeChatId(id);
      await unlink(join(this.dir, `${id}.json`));
      return true;
    } catch {
      return false;
    }
  }
}

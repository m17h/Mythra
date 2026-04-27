import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type { SavedChat, SavedChatMeta } from '@shared/types';

const CHATS_DIR = 'pixel-forge-chats';

export class ChatStore {
  private readonly dir = join(app.getPath('userData'), CHATS_DIR);

  private async ensureDir() {
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
          title: chat.title,
          titleOverride: chat.titleOverride ?? null,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt
        });
      } catch {
        // skip corrupted files
      }
    }

    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async loadChat(id: string): Promise<SavedChat | null> {
    try {
      const raw = await readFile(join(this.dir, `${id}.json`), 'utf8');
      return JSON.parse(raw) as SavedChat;
    } catch {
      return null;
    }
  }

  async saveChat(chat: SavedChat): Promise<void> {
    await this.ensureDir();
    await writeFile(join(this.dir, `${chat.id}.json`), JSON.stringify(chat), 'utf8');
  }

  async deleteChat(id: string): Promise<boolean> {
    try {
      await unlink(join(this.dir, `${id}.json`));
      return true;
    } catch {
      return false;
    }
  }
}
